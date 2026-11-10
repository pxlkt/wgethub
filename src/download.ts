import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { type Expected, hashFile } from "./checksum.ts";
import { Exit, Interrupted, WgethubError, sleep } from "./errors.ts";
import { type WgetInfo, buildArgs, explainExit, isRetriable, runWget } from "./wget.ts";

export interface DownloadJob {
  name: string;
  url: string;
  /** Size in bytes when GitHub told us; undefined for generated source archives. */
  size: number | undefined;
  expected: Expected | undefined;
  /** Generated archives cannot be resumed with a Range request, so always start them fresh. */
  resumable: boolean;
  /** Lazily fetch a signed URL using the API token. Used if the plain URL is refused. */
  authedUrl?: (() => Promise<string | undefined>) | undefined;
}

export interface DownloadContext {
  wget: WgetInfo;
  dir: string;
  retries: number;
  tries: number;
  timeout: number;
  force: boolean;
  verify: boolean;
  userAgent: string;
  extraArgs: readonly string[];
  signal: AbortSignal;
  /** Base delay between our own retries; tests shrink it. */
  backoffMs?: number;
}

export interface DownloadHooks {
  progress(bytes: number): void;
  phase(text: string): void;
}

export interface DownloadResult {
  name: string;
  path: string;
  bytes: number;
  status: "downloaded" | "resumed" | "already-complete";
  /** e.g. "sha256 via GitHub digest", "size only", "unverified" */
  verified: string;
  checksum: string | undefined;
  seconds: number;
}

/** Asset names come from the network. Never let one climb out of the output directory. */
export function safeName(name: string): string {
  const base = basename(name.replaceAll("\\", "/"));
  if (base !== name || base === "" || base === "." || base === ".." || base.includes("\0")) {
    throw new WgethubError(`Refusing to write an asset with a suspicious name: ${JSON.stringify(name)}`, Exit.download);
  }
  return base;
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One writer per partial file. A lock left behind by a dead process is taken over. */
function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw ioError(error);
      let owner = NaN;
      try {
        owner = Number(readFileSync(path, "utf8"));
      } catch {
        // unreadable lock: treat as stale
      }
      if (Number.isInteger(owner) && owner !== process.pid && alive(owner)) {
        throw new WgethubError(`Another wgethub (pid ${owner}) is already downloading ${basename(path, ".part.lock")} here.`, Exit.download);
      }
      rmSync(path, { force: true });
    }
  }
  throw new WgethubError(`Could not lock ${path}.`, Exit.download);
}

function ioError(error: unknown): WgethubError {
  const e = error as NodeJS.ErrnoException;
  return new WgethubError(`Cannot write to the output directory: ${e.message}`, Exit.download);
}

async function matchesExpectation(path: string, job: DownloadJob, verify: boolean): Promise<{ ok: boolean; verified: string; checksum: string | undefined }> {
  const size = sizeOf(path);
  if (job.size !== undefined && size !== job.size) return { ok: false, verified: "size mismatch", checksum: undefined };
  if (job.expected && verify) {
    const actual = await hashFile(path, job.expected.algorithm);
    return { ok: actual === job.expected.hex, verified: `${job.expected.algorithm} via ${job.expected.source}`, checksum: actual };
  }
  return { ok: job.size !== undefined, verified: job.size !== undefined ? "size only" : "unverified", checksum: undefined };
}

/**
 * Download one file with wget, to `<name>.part`, and only promote it to its
 * real name once the bytes have been proven right. The invariant: a file
 * without the .part suffix is always complete and verified.
 */
export async function downloadOne(job: DownloadJob, ctx: DownloadContext, hooks: DownloadHooks): Promise<DownloadResult> {
  const started = Date.now();
  const final = join(ctx.dir, safeName(job.name));
  const part = `${final}.part`;
  const elapsed = () => (Date.now() - started) / 1000;

  if (sizeOf(final) !== undefined && !ctx.force) {
    hooks.phase("checking existing file");
    const existing = await matchesExpectation(final, job, ctx.verify);
    if (existing.ok) {
      return { name: job.name, path: final, bytes: sizeOf(final) ?? 0, status: "already-complete", verified: existing.verified, checksum: existing.checksum, seconds: elapsed() };
    }
    throw new WgethubError(
      `${final} already exists and ${job.size === undefined ? "cannot be compared with" : "differs from"} the release asset.`,
      Exit.download,
      "Pass --force to overwrite it, or -o to download somewhere else.",
    );
  }

  const release = acquireLock(`${part}.lock`);
  try {
    let url = job.url;
    let usedAuthedUrl = false;
    let resumedFrom = 0;
    let failure = "";

    for (let attempt = 0; attempt <= ctx.retries; attempt++) {
      if (ctx.signal.aborted) throw new Interrupted();

      let have = sizeOf(part) ?? 0;
      if (have > 0 && (!job.resumable || (job.size !== undefined && have > job.size))) {
        rmSync(part, { force: true });
        have = 0;
      }
      if (attempt === 0) resumedFrom = have;

      if (job.size === undefined || have < job.size) {
        hooks.phase(attempt === 0 ? (have > 0 ? "resuming" : "downloading") : `retry ${attempt}/${ctx.retries}`);
        hooks.progress(have);
        const poll = setInterval(() => hooks.progress(sizeOf(part) ?? 0), 100);
        let result;
        try {
          const args = buildArgs(ctx.wget, {
            url, dest: part, resume: job.resumable, tries: ctx.tries, timeout: ctx.timeout, userAgent: ctx.userAgent, extra: ctx.extraArgs,
          });
          result = await runWget(ctx.wget, args, ctx.signal);
        } finally {
          clearInterval(poll);
        }
        if (ctx.signal.aborted) throw new Interrupted();

        if (result.code !== 0) {
          failure = [explainExit(result.code, ctx.wget.flavor), result.stderr.split("\n").slice(-3).join("\n")].filter(Boolean).join("\n");
          // A refused request is the signature of a private repo: retry once through the API with our token.
          if (job.authedUrl && !usedAuthedUrl && result.code !== null && result.code !== 3) {
            usedAuthedUrl = true;
            const signed = await job.authedUrl();
            if (signed) {
              url = signed;
              attempt--;
              continue;
            }
          }
          if (!isRetriable(result.code, ctx.wget.flavor)) break;
          await sleep(Math.min(15_000, (ctx.backoffMs ?? 1000) * 2 ** attempt), ctx.signal);
          continue;
        }
      }

      const got = sizeOf(part) ?? 0;
      hooks.progress(got);
      if (job.size !== undefined && got !== job.size) {
        failure = `expected ${job.size} bytes but got ${got}`;
        if (got > job.size) rmSync(part, { force: true });
        continue; // short file: go around again and let wget resume it
      }

      hooks.phase("verifying");
      const check = await matchesExpectation(part, job, ctx.verify);
      if (!check.ok && job.expected && ctx.verify) {
        // Corrupt bytes cannot be resumed past. Throw them away and start clean.
        rmSync(part, { force: true });
        resumedFrom = 0;
        failure = `${job.expected.algorithm} mismatch (expected ${job.expected.hex}, got ${check.checksum})`;
        if (attempt < ctx.retries) continue;
        throw new WgethubError(`${job.name} failed verification: ${failure}`, Exit.verify, "The corrupt download was deleted. If this keeps happening the release itself may have been tampered with.");
      }

      try {
        renameSync(part, final);
      } catch (error) {
        throw ioError(error);
      }
      return {
        name: job.name, path: final, bytes: got, status: resumedFrom > 0 ? "resumed" : "downloaded",
        verified: check.verified, checksum: check.checksum, seconds: elapsed(),
      };
    }

    const kept = sizeOf(part);
    throw new WgethubError(
      `Could not download ${job.name}.\n${failure}`,
      Exit.download,
      kept ? `Kept ${kept} bytes in ${part}. Run the same command again to resume.` : undefined,
    );
  } finally {
    release();
  }
}

/** Run jobs with bounded concurrency. Every job runs to completion; failures are collected, not short-circuited. */
export async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
