import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checksumCandidates, findExpected, hashFile, parseChecksums, parseDigest } from "../src/checksum.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(128);

test("parseDigest accepts well-formed GitHub digests only", () => {
  assert.deepEqual(parseDigest(`sha256:${A}`), { algorithm: "sha256", hex: A, source: "GitHub digest" });
  assert.equal(parseDigest(`sha256:${A.toUpperCase()}`)?.hex, A);
  assert.equal(parseDigest(`sha512:${C}`)?.algorithm, "sha512");
  assert.equal(parseDigest("sha256:abc"), undefined);
  assert.equal(parseDigest(`md5:${A}`), undefined);
  assert.equal(parseDigest(null), undefined);
  assert.equal(parseDigest(undefined), undefined);
});

test("parseChecksums reads GNU, BSD and bare formats", () => {
  const parsed = parseChecksums(
    [`# comment`, `${A}  tool.tar.gz`, `${B} *dist/tool.zip`, `SHA256 (tool.deb) = ${A}`, `SHA2-512(tool.rpm)= ${C}`, ``, `not a checksum line`, `${B.toUpperCase()}`].join("\r\n"),
  );
  assert.equal(parsed.byName.get("tool.tar.gz"), A);
  assert.equal(parsed.byName.get("tool.zip"), B, "binary-mode marker and directory are stripped");
  assert.equal(parsed.byName.get("tool.deb"), A);
  assert.equal(parsed.byName.get("tool.rpm"), C);
  assert.equal(parsed.bare, B);
  assert.equal(parsed.byName.size, 4);
});

test("checksumCandidates prefers the dedicated file over the shared one", () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}` });
  const assets = ["tool.tar.gz", "tool.tar.gz.sha256", "SHA256SUMS", "tool_1.0_checksums.txt", "tool.zip", "notes.txt"].map(asset);
  assert.deepEqual(checksumCandidates(assets[0]!, assets).map((a) => a.name), ["tool.tar.gz.sha256", "SHA256SUMS", "tool_1.0_checksums.txt"]);
  assert.deepEqual(checksumCandidates(assets[2]!, assets).map((a) => a.name), ["tool_1.0_checksums.txt"]);
});

test("findExpected: digest wins, then checksum files, then nothing", async () => {
  const files: Record<string, string> = {
    "https://x.test/tool.tar.gz.sha256": `${B}\n`,
    "https://x.test/SHA256SUMS": `${A}  tool.zip\n${A}  other.bin\n`,
  };
  let fetches = 0;
  const fetchText = async (url: string) => {
    fetches++;
    return files[url];
  };
  const asset = (name: string, digest?: string) => ({ name, browser_download_url: `https://x.test/${name}`, digest });
  const all = [asset("tool.tar.gz"), asset("tool.zip"), asset("tool.tar.gz.sha256"), asset("SHA256SUMS"), asset("lonely.bin")];

  assert.equal((await findExpected(asset("tool.zip", `sha256:${B}`), all, fetchText))?.source, "GitHub digest");
  assert.equal(fetches, 0, "a digest needs no network");
  assert.deepEqual(await findExpected(all[0]!, all, fetchText), { algorithm: "sha256", hex: B, source: "tool.tar.gz.sha256" });
  assert.deepEqual(await findExpected(all[1]!, all, fetchText), { algorithm: "sha256", hex: A, source: "SHA256SUMS" });
  assert.equal(await findExpected(all[4]!, all, fetchText), undefined, "a bare hash in someone else's file is not ours");
});

test("hashFile matches a known vector", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "wgethub-")), "abc");
  writeFileSync(file, "abc");
  assert.equal(await hashFile(file, "sha256"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
