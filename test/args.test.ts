import assert from "node:assert/strict";
import { test } from "node:test";
import { matcher, parseCli, parseTarget } from "../src/args.ts";
import { Exit, WgethubError } from "../src/errors.ts";

const usageError = (error: unknown) => error instanceof WgethubError && error.code === Exit.usage;

test("parseTarget understands every spelling of a repo", () => {
  const plain = { kind: "repo", owner: "cli", repo: "cli" };
  assert.deepEqual(parseTarget("cli/cli"), plain);
  assert.deepEqual(parseTarget("  cli/cli  "), plain);
  assert.deepEqual(parseTarget("github.com/cli/cli"), plain);
  assert.deepEqual(parseTarget("https://github.com/cli/cli"), plain);
  assert.deepEqual(parseTarget("https://github.com/cli/cli.git"), plain);
  assert.deepEqual(parseTarget("https://github.com/cli/cli/tree/trunk/docs"), plain);
  assert.deepEqual(parseTarget("https://github.com/cli/cli/releases/latest"), plain);
  assert.deepEqual(parseTarget("git@github.com:cli/cli.git"), plain);
});

test("parseTarget extracts tags and assets", () => {
  assert.deepEqual(parseTarget("cli/cli@v2.60.0"), { kind: "repo", owner: "cli", repo: "cli", tag: "v2.60.0" });
  assert.deepEqual(parseTarget("https://github.com/cli/cli/releases/tag/v2.60.0"), { kind: "repo", owner: "cli", repo: "cli", tag: "v2.60.0" });
  assert.deepEqual(parseTarget("https://github.com/o/r/releases/tag/pkg%2Fv1"), { kind: "repo", owner: "o", repo: "r", tag: "pkg/v1" });
  assert.deepEqual(parseTarget("https://github.com/cli/cli/releases/download/v2.60.0/gh_2.60.0_linux_amd64.tar.gz"), {
    kind: "repo", owner: "cli", repo: "cli", tag: "v2.60.0", asset: "gh_2.60.0_linux_amd64.tar.gz",
  });
});

test("parseTarget turns bare words into a search and rejects nonsense", () => {
  assert.deepEqual(parseTarget("ripgrep"), { kind: "search", query: "ripgrep" });
  assert.throws(() => parseTarget(""), usageError);
  assert.throws(() => parseTarget("a/b/c"), usageError);
  assert.throws(() => parseTarget("cli/cli@"), usageError);
  assert.throws(() => parseTarget("https://gitlab.com/a/b"), usageError);
  assert.throws(() => parseTarget("-bad/repo"), usageError);
  assert.throws(() => parseTarget("owner/re po"), usageError);
  assert.throws(() => parseTarget("owner/$(rm -rf ~)"), usageError);
});

test("parseCli applies defaults and splits wget passthrough", () => {
  const options = parseCli(["cli/cli", "*.deb", "-a", "amd64", "-o", "out", "-j", "8", "--", "--limit-rate=1m", "-4"]);
  assert.equal(options.target, "cli/cli");
  assert.deepEqual(options.patterns, ["*.deb", "amd64"]);
  assert.equal(options.outputDir, "out");
  assert.equal(options.jobs, 8);
  assert.equal(options.verify, true);
  assert.equal(options.auth, true);
  assert.deepEqual(options.wgetArgs, ["--limit-rate=1m", "-4"]);
});

test("parseCli rejects bad input with a usage error", () => {
  assert.throws(() => parseCli(["--nope"]), usageError);
  assert.throws(() => parseCli(["x/y", "--jobs", "0"]), usageError);
  assert.throws(() => parseCli(["x/y", "--jobs", "many"]), usageError);
  assert.throws(() => parseCli(["x/y", "--zip"]), usageError);
  assert.throws(() => parseCli(["x/y", "-i", "-y"]), usageError);
});

test("parseCli tolerates the v1 -nv flag", () => {
  const options = parseCli(["-nv", "x/y"]);
  assert.equal(options.legacyNoValidate, true);
  assert.equal(options.target, "x/y");
});

test("matcher does substrings and case-insensitive globs", () => {
  assert.equal(matcher("amd64")("gh_linux_AMD64.tar.gz"), true);
  assert.equal(matcher("*.deb")("gh_linux_amd64.deb"), true);
  assert.equal(matcher("*.deb")("gh_linux_amd64.deb.sha256"), false);
  assert.equal(matcher("gh_?.tar.gz")("gh_1.tar.gz"), true);
  assert.equal(matcher("a+b(1).zip")("A+B(1).zip"), true);
  assert.equal(matcher("*.zip")("x.tar.gz"), false);
});
