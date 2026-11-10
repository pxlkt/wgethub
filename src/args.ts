import { parseArgs } from "node:util";
import { Exit, WgethubError } from "./errors.ts";

export interface Options {
  target: string | undefined;
  patterns: string[];
  tag: string | undefined;
  pre: boolean;
  all: boolean;
  source: boolean;
  zip: boolean;
  outputDir: string;
  jobs: number;
  retries: number;
  tries: number;
  timeout: number;
  os: string | undefined;
  arch: string | undefined;
  force: boolean;
  verify: boolean;
  requireChecksum: boolean;
  auth: boolean;
  cache: boolean;
  interactive: boolean;
  yes: boolean;
  list: boolean;
  releases: boolean;
  printUrl: boolean;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  doctor: boolean;
  help: boolean;
  version: boolean;
  /** Everything after `--`, handed to wget untouched. */
  wgetArgs: string[];
  /** The v1 `-nv` / `--no-validate` flag was passed. It is a no-op now. */
  legacyNoValidate: boolean;
}

const usage = (message: string) => new WgethubError(message, Exit.usage, "Run `wgethub --help` for usage.");

function integer(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw usage(`--${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

export function parseCli(argv: readonly string[]): Options {
  const split = argv.indexOf("--");
  const own = split === -1 ? [...argv] : argv.slice(0, split);
  const wgetArgs = split === -1 ? [] : argv.slice(split + 1);

  const isLegacy = (arg: string) => arg === "-nv" || arg === "--no-validate";
  const legacy = own.filter(isLegacy);
  const args = own.filter((arg) => !isLegacy(arg));

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        tag: { type: "string", short: "t" },
        asset: { type: "string", short: "a", multiple: true },
        pre: { type: "boolean" },
        all: { type: "boolean", short: "A" },
        source: { type: "boolean", short: "s" },
        zip: { type: "boolean" },
        "output-dir": { type: "string", short: "o" },
        jobs: { type: "string", short: "j" },
        retries: { type: "string" },
        tries: { type: "string" },
        timeout: { type: "string" },
        os: { type: "string" },
        arch: { type: "string" },
        force: { type: "boolean", short: "f" },
        "no-verify": { type: "boolean" },
        "require-checksum": { type: "boolean" },
        "no-auth": { type: "boolean" },
        "no-cache": { type: "boolean" },
        interactive: { type: "boolean", short: "i" },
        yes: { type: "boolean", short: "y" },
        list: { type: "boolean", short: "l" },
        releases: { type: "boolean" },
        "print-url": { type: "boolean" },
        "dry-run": { type: "boolean", short: "n" },
        json: { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        doctor: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    });
  } catch (error) {
    throw usage(error instanceof Error ? error.message.split(/\. |\n/)[0]!.replace(/\.?$/, ".") : String(error));
  }

  const { values, positionals } = parsed;
  if (values.interactive && values.yes) throw usage("--interactive and --yes contradict each other.");
  if (values.zip && !values.source) throw usage("--zip only makes sense together with --source.");

  return {
    target: positionals[0],
    patterns: [...positionals.slice(1), ...(values.asset ?? [])],
    tag: values.tag,
    pre: values.pre ?? false,
    all: values.all ?? false,
    source: values.source ?? false,
    zip: values.zip ?? false,
    outputDir: values["output-dir"] ?? ".",
    jobs: integer("jobs", values.jobs, 3, 1, 16),
    retries: integer("retries", values.retries, 3, 0, 20),
    tries: integer("tries", values.tries, 5, 1, 100),
    timeout: integer("timeout", values.timeout, 30, 1, 3600),
    os: values.os,
    arch: values.arch,
    force: values.force ?? false,
    verify: !values["no-verify"],
    requireChecksum: values["require-checksum"] ?? false,
    auth: !values["no-auth"],
    cache: !values["no-cache"],
    interactive: values.interactive ?? false,
    yes: values.yes ?? false,
    list: values.list ?? false,
    releases: values.releases ?? false,
    printUrl: values["print-url"] ?? false,
    dryRun: values["dry-run"] ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
    doctor: values.doctor ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    wgetArgs,
    legacyNoValidate: legacy.length > 0,
  };
}

export type Target =
  | { kind: "repo"; owner: string; repo: string; tag?: string; asset?: string }
  | { kind: "search"; query: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function repoTarget(owner: string, repo: string, tag?: string, asset?: string): Target {
  const name = repo.replace(/\.git$/, "");
  if (!OWNER.test(owner) || !REPO.test(name) || name === "." || name === "..") {
    throw usage(`"${owner}/${repo}" is not a valid GitHub repository.`);
  }
  const target: Target = { kind: "repo", owner, repo: name };
  if (tag) target.tag = tag;
  if (asset) target.asset = asset;
  return target;
}

/**
 * Accepts every way a human might point at a repo:
 *   owner/repo, owner/repo@tag, github.com/owner/repo, git@github.com:owner/repo.git,
 *   https://github.com/owner/repo/releases/tag/v1, …/releases/download/v1/file.tar.gz,
 * and, failing all that, bare words, which become a search query.
 */
export function parseTarget(input: string): Target {
  const spec = input.trim();
  if (spec === "") throw usage("Empty repository.");

  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(spec);
  if (ssh) return repoTarget(ssh[1]!, ssh[2]!);

  const looksLikeUrl = /^https?:\/\//i.test(spec) || /^(www\.)?github\.com\//i.test(spec);
  if (looksLikeUrl) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(spec) ? spec : `https://${spec}`);
    } catch {
      throw usage(`"${spec}" is not a valid URL.`);
    }
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) {
      throw usage(`"${url.hostname}" is not github.com. wgethub only speaks GitHub.`);
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [owner, repo, ...rest] = parts;
    if (!owner || !repo) throw usage(`"${spec}" does not point at a repository.`);
    if (rest[0] === "releases" && rest[1] === "tag" && rest.length > 2) {
      return repoTarget(owner, repo, rest.slice(2).join("/"));
    }
    if (rest[0] === "releases" && rest[1] === "download" && rest.length > 3) {
      return repoTarget(owner, repo, rest.slice(2, -1).join("/"), rest.at(-1));
    }
    return repoTarget(owner, repo);
  }

  const at = spec.indexOf("@");
  const path = at === -1 ? spec : spec.slice(0, at);
  const tag = at === -1 ? undefined : spec.slice(at + 1);
  const parts = path.split("/");
  if (parts.length === 2) {
    if (tag === "") throw usage(`"${spec}" has an empty tag after the @.`);
    return repoTarget(parts[0]!, parts[1]!, tag);
  }
  if (parts.length === 1 && at === -1) return { kind: "search", query: spec };
  throw usage(`"${spec}" is not a repository. Expected owner/repo, owner/repo@tag or a GitHub URL.`);
}

/** Case-insensitive glob (`*`, `?`). A pattern with no wildcards matches as a substring. */
export function matcher(pattern: string): (name: string) => boolean {
  const needle = pattern.toLowerCase();
  if (!/[*?]/.test(needle)) return (name) => name.toLowerCase().includes(needle);
  const source = needle.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  const regex = new RegExp(`^${source}$`);
  return (name) => regex.test(name.toLowerCase());
}
