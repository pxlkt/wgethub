// End-to-end: the real CLI, the real wget, and a local server impersonating
// GitHub's API and CDN, including one that misbehaves on purpose.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const hasWget = !spawnSync("wget", ["--version"]).error;
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PAYLOAD = randomBytes(300_000);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

let server: Server;
let base = "";
/** Per-test knobs for the fake GitHub. */
const state = { digest: `sha256:${SHA}` as string | null, dropFirst: 0, requests: [] as { url: string; range: string | undefined }[] };

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  state.requests.push({ url, range: req.headers.range });
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const asset = (name: string, extra: object = {}) => ({
    id: 1, name, size: PAYLOAD.length, url: `${base}/api-asset/${name}`, browser_download_url: `${base}/dl/${name}`, digest: state.digest, ...extra,
  });
  const release = {
    id: 1, tag_name: "v1.0.0", name: "One", draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z",
    html_url: "", tarball_url: null, zipball_url: null,
    assets: [
      asset("tool-linux-x86_64.tar.gz"), asset("tool-linux-aarch64.tar.gz"), asset("tool-darwin-arm64.tar.gz"),
      asset("tool-windows-x86_64.zip"), asset("../../escape.sh"),
    ],
  };

  if (url === "/repos/o/r/releases/latest" || url === "/repos/o/r/releases/tags/v1.0.0") return json(200, release);
  if (url.startsWith("/repos/")) return json(404, { message: "Not Found" });
  if (url.startsWith("/dl/")) {
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
    const body = PAYLOAD.subarray(start);
    const head = start > 0
      ? { "content-range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`, "content-length": body.length }
      : { "content-length": body.length, "accept-ranges": "bytes" };
    res.writeHead(start > 0 ? 206 : 200, head);
    if (state.dropFirst > 0) {
      state.dropFirst--;
      res.write(body.subarray(0, Math.floor(body.length / 3)), () => res.destroy()); // hang up mid-transfer
      return;
    }
    res.end(body);
    return;
  }
  json(404, {});
}

before(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  dir: string;
}

function run(args: string[], dir = mkdtempSync(join(tmpdir(), "wgethub-e2e-"))): Promise<Run> {
  const env = {
    PATH: process.env.PATH, HOME: dir, WGETHUB_API_URL: base, WGETHUB_CACHE_DIR: join(dir, ".cache"),
    no_proxy: "127.0.0.1", NO_COLOR: "1",
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args, "--no-auth", "--os", "linux", "--arch", "x64", "-o", dir], { env, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, dir });
    });
  });
}

function reset(): void {
  state.digest = `sha256:${SHA}`;
  state.dropFirst = 0;
  state.requests = [];
}

const NAME = "tool-linux-x86_64.tar.gz";
const opts = { skip: hasWget ? false : "wget is not installed" };

test("downloads the asset for this platform and verifies it", opts, async () => {
  reset();
  const result = await run(["o/r", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.tag, "v1.0.0");
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].name, NAME);
  assert.equal(out.files[0].status, "downloaded");
  assert.equal(out.files[0].checksum, SHA);
  assert.match(out.files[0].verified, /sha256 via GitHub digest/);
  assert.deepEqual(readFileSync(join(result.dir, NAME)), PAYLOAD);
  assert.deepEqual(readdirSync(result.dir).filter((f) => f.includes(".part")), [], "no partial or lock files left behind");
});

test("prints bare paths on a pipe and is idempotent on re-run", opts, async () => {
  reset();
  const first = await run(["o/r"]);
  assert.equal(first.stdout.trim(), join(first.dir, NAME));
  state.requests = [];
  const second = await run(["o/r"], first.dir);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /already here/);
  assert.equal(state.requests.filter((r) => r.url.startsWith("/dl/")).length, 0, "nothing is downloaded twice");
});

test("resumes a partial download with a Range request", opts, async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), "wgethub-e2e-"));
  writeFileSync(join(dir, `${NAME}.part`), PAYLOAD.subarray(0, 100_000));
  const result = await run(["o/r", "--json"], dir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files[0].status, "resumed");
  assert.equal(state.requests.find((r) => r.url.startsWith("/dl/"))?.range, "bytes=100000-");
  assert.deepEqual(readFileSync(join(dir, NAME)), PAYLOAD);
});

test("survives the connection dropping mid-transfer", opts, async () => {
  reset();
  state.dropFirst = 2;
  const result = await run(["o/r"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readFileSync(join(result.dir, NAME)), PAYLOAD);
  assert.ok(state.requests.filter((r) => r.url.startsWith("/dl/")).length >= 3);
});

test("a corrupt partial file is detected, discarded and re-downloaded", opts, async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), "wgethub-e2e-"));
  writeFileSync(join(dir, `${NAME}.part`), randomBytes(100_000));
  const result = await run(["o/r"], dir);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readFileSync(join(dir, NAME)), PAYLOAD);
});

test("a checksum that never matches fails with exit 7 and leaves nothing behind", opts, async () => {
  reset();
  state.digest = `sha256:${"0".repeat(64)}`;
  const result = await run(["o/r", "--retries", "1"]);
  assert.equal(result.code, 7, result.stderr);
  assert.match(result.stderr, /failed verification/);
  assert.equal(existsSync(join(result.dir, NAME)), false);
  assert.equal(existsSync(join(result.dir, `${NAME}.part`)), false);
});

test("refuses to clobber a different existing file unless forced", opts, async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), "wgethub-e2e-"));
  writeFileSync(join(dir, NAME), "precious");
  const refused = await run(["o/r"], dir);
  assert.equal(refused.code, 6);
  assert.equal(readFileSync(join(dir, NAME), "utf8"), "precious");
  const forced = await run(["o/r", "--force"], dir);
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(readFileSync(join(dir, NAME)), PAYLOAD);
});

test("--require-checksum fails closed when nothing is published", opts, async () => {
  reset();
  state.digest = null;
  const strict = await run(["o/r", "--require-checksum"]);
  assert.equal(strict.code, 7);
  const lenient = await run(["o/r"]);
  assert.equal(lenient.code, 0, lenient.stderr);
  assert.match(lenient.stderr, /size only/);
});

test("patterns select several assets, downloaded in parallel", opts, async () => {
  reset();
  const result = await run(["o/r", "*linux*", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).files.map((f: { name: string }) => f.name).sort(), ["tool-linux-aarch64.tar.gz", NAME]);
});

test("an asset name that tries to escape the output directory is refused", opts, async () => {
  reset();
  const result = await run(["o/r", "escape"]);
  assert.equal(result.code, 6);
  assert.match(result.stderr, /suspicious name/);
});

test("inspection modes need no download", async () => {
  reset();
  const urls = await run(["o/r@1.0.0", "--print-url"]);
  assert.equal(urls.stdout.trim(), `${base}/dl/${NAME}`);
  const list = await run(["o/r", "--list", "--json"]);
  const assets = JSON.parse(list.stdout).assets as { name: string; recommended: boolean }[];
  assert.deepEqual(assets.filter((a) => a.recommended).map((a) => a.name), [NAME]);
  assert.equal(state.requests.filter((r) => r.url.startsWith("/dl/")).length, 0);
});

test("errors map to documented exit codes", async () => {
  reset();
  assert.equal((await run(["o/missing"])).code, 3);
  assert.equal((await run(["o/r", "no-such-asset"])).code, 3);
  assert.equal((await run(["o/r", "--bogus"])).code, 2);
  assert.equal((await run([])).code, 2, "no repo and no terminal to ask on");
});
