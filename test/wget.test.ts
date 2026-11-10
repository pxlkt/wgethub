import assert from "node:assert/strict";
import { test } from "node:test";
import { safeName, pool } from "../src/download.ts";
import { WgethubError } from "../src/errors.ts";
import { type WgetInfo, assertSafeUrl, buildArgs, explainExit, isRetriable } from "../src/wget.ts";

const job = { url: "https://github.com/o/r/releases/download/v1/a.tar.gz", dest: "/tmp/a.tar.gz.part", resume: true, tries: 5, timeout: 30, userAgent: "wgethub/test", extra: ["--limit-rate=1m"] };
const info = (flavor: WgetInfo["flavor"], version?: string): WgetInfo => ({ bin: "wget", flavor, version, banner: "" });

test("buildArgs: GNU wget gets the full robustness kit", () => {
  const args = buildArgs(info("gnu", "1.25.0"), job);
  for (const flag of ["--continue", "--tries=5", "--retry-connrefused", "--timeout=30", "--retry-on-http-error=429,500,502,503,504", "--limit-rate=1m"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args.at(-1), job.url, "the URL is last");
  assert.equal(args.at(-2), "--output-document=/tmp/a.tar.gz.part");
});

test("buildArgs: only flags the installed wget understands", () => {
  assert.ok(!buildArgs(info("gnu", "1.19.4"), job).some((arg) => arg.startsWith("--retry-on-http-error")));
  assert.ok(buildArgs(info("wget2", "2.1.0"), job).some((arg) => arg.startsWith("--retry-on-http-error")));
  const busybox = buildArgs(info("busybox"), job);
  assert.ok(busybox.every((arg) => !arg.startsWith("--") || arg === "--limit-rate=1m"), "busybox only gets short flags");
  assert.deepEqual(busybox.slice(-3), ["-O", job.dest, job.url]);
  assert.ok(!buildArgs(info("gnu", "1.25.0"), { ...job, resume: false }).includes("--continue"));
});

test("assertSafeUrl: https only, http for loopback, nothing else", () => {
  assert.ok(assertSafeUrl("https://github.com/x"));
  assert.ok(assertSafeUrl("http://127.0.0.1:8080/x"));
  assert.throws(() => assertSafeUrl("http://github.com/x"), WgethubError);
  assert.throws(() => assertSafeUrl("ftp://example.com/x"), WgethubError);
  assert.throws(() => assertSafeUrl("file:///etc/passwd"), WgethubError);
  assert.throws(() => assertSafeUrl("--post-file=/etc/passwd"), WgethubError);
  assert.throws(() => buildArgs(info("gnu", "1.25.0"), { ...job, url: "-O /etc/cron.d/x" }), WgethubError);
});

test("exit codes are explained and classified", () => {
  assert.match(explainExit(4, "gnu"), /network failure/);
  assert.match(explainExit(8, "gnu"), /server/);
  assert.match(explainExit(null, "gnu"), /signal/);
  assert.equal(isRetriable(4, "gnu"), true);
  assert.equal(isRetriable(3, "gnu"), false, "a full disk does not get better by retrying");
  assert.equal(isRetriable(5, "gnu"), false, "nor does a bad certificate");
  assert.equal(isRetriable(1, "busybox"), true);
});

test("safeName refuses path traversal", () => {
  assert.equal(safeName("tool-1.0.tar.gz"), "tool-1.0.tar.gz");
  for (const evil of ["../../.bashrc", "/etc/passwd", "a/b", "..", ".", "", "a\\b", "x\0y"]) {
    assert.throws(() => safeName(evil), WgethubError, JSON.stringify(evil));
  }
});

test("pool bounds concurrency and collects failures without short-circuiting", async () => {
  let running = 0;
  let peak = 0;
  const results = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    if (n === 3) throw new Error("boom");
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map((r) => (r.status === "fulfilled" ? r.value : "x")), [10, 20, "x", 40, 50, 60]);
});
