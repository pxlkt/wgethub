import assert from "node:assert/strict";
import { test } from "node:test";
import { type Platform, detectPlatform, pickBest, rankAssets, scoreAsset } from "../src/platform.ts";

const pick = (names: string[], platform: Platform) => pickBest(rankAssets(names.map((name) => ({ name })), platform))?.name;

// Asset lists copied from real releases: the naming conventions are the test.
const GH = [
  "gh_2.60.0_checksums.txt", "gh_2.60.0_linux_386.deb", "gh_2.60.0_linux_386.tar.gz", "gh_2.60.0_linux_amd64.deb",
  "gh_2.60.0_linux_amd64.rpm", "gh_2.60.0_linux_amd64.tar.gz", "gh_2.60.0_linux_arm64.tar.gz", "gh_2.60.0_linux_armv6.tar.gz",
  "gh_2.60.0_macOS_amd64.zip", "gh_2.60.0_macOS_arm64.zip", "gh_2.60.0_macOS_universal.pkg", "gh_2.60.0_windows_386.zip",
  "gh_2.60.0_windows_amd64.msi", "gh_2.60.0_windows_amd64.zip", "gh_2.60.0_windows_arm64.zip",
];
const RIPGREP = [
  "ripgrep-14.1.0-aarch64-apple-darwin.tar.gz", "ripgrep-14.1.0-aarch64-apple-darwin.tar.gz.sha256",
  "ripgrep-14.1.0-aarch64-unknown-linux-gnu.tar.gz", "ripgrep-14.1.0-armv7-unknown-linux-gnueabihf.tar.gz",
  "ripgrep-14.1.0-i686-pc-windows-msvc.zip", "ripgrep-14.1.0-i686-unknown-linux-gnu.tar.gz",
  "ripgrep-14.1.0-x86_64-apple-darwin.tar.gz", "ripgrep-14.1.0-x86_64-pc-windows-gnu.zip",
  "ripgrep-14.1.0-x86_64-pc-windows-msvc.zip", "ripgrep-14.1.0-x86_64-unknown-linux-musl.tar.gz",
  "ripgrep_14.1.0-1_amd64.deb",
];
const NEOVIM = [
  "nvim-linux-arm64.appimage", "nvim-linux-arm64.tar.gz", "nvim-linux-x86_64.appimage", "nvim-linux-x86_64.appimage.zsync",
  "nvim-linux-x86_64.tar.gz", "nvim-macos-arm64.tar.gz", "nvim-macos-x86_64.tar.gz", "nvim-win64.msi", "nvim-win64.zip",
];

test("picks the right gh build per platform", () => {
  assert.equal(pick(GH, { os: "linux", arch: "x64", libc: "gnu" }), "gh_2.60.0_linux_amd64.tar.gz");
  assert.equal(pick(GH, { os: "linux", arch: "arm64" }), "gh_2.60.0_linux_arm64.tar.gz");
  assert.equal(pick(GH, { os: "linux", arch: "arm" }), "gh_2.60.0_linux_armv6.tar.gz");
  assert.equal(pick(GH, { os: "linux", arch: "ia32" }), "gh_2.60.0_linux_386.tar.gz");
  assert.equal(pick(GH, { os: "darwin", arch: "arm64" }), "gh_2.60.0_macOS_arm64.zip");
  assert.equal(pick(GH, { os: "darwin", arch: "x64" }), "gh_2.60.0_macOS_amd64.zip");
  assert.equal(pick(GH, { os: "windows", arch: "x64" }), "gh_2.60.0_windows_amd64.zip");
  assert.equal(pick(GH, { os: "windows", arch: "arm64" }), "gh_2.60.0_windows_arm64.zip");
});

test("picks the right ripgrep build per platform", () => {
  assert.equal(pick(RIPGREP, { os: "linux", arch: "x64", libc: "gnu" }), "ripgrep-14.1.0-x86_64-unknown-linux-musl.tar.gz");
  assert.equal(pick(RIPGREP, { os: "linux", arch: "x64", libc: "musl" }), "ripgrep-14.1.0-x86_64-unknown-linux-musl.tar.gz");
  assert.equal(pick(RIPGREP, { os: "linux", arch: "arm64", libc: "gnu" }), "ripgrep-14.1.0-aarch64-unknown-linux-gnu.tar.gz");
  assert.equal(pick(RIPGREP, { os: "linux", arch: "arm" }), "ripgrep-14.1.0-armv7-unknown-linux-gnueabihf.tar.gz");
  assert.equal(pick(RIPGREP, { os: "darwin", arch: "arm64" }), "ripgrep-14.1.0-aarch64-apple-darwin.tar.gz");
  assert.equal(pick(RIPGREP, { os: "darwin", arch: "x64" }), "ripgrep-14.1.0-x86_64-apple-darwin.tar.gz");
});

test("picks the right neovim build per platform", () => {
  assert.equal(pick(NEOVIM, { os: "linux", arch: "x64", libc: "gnu" }), "nvim-linux-x86_64.tar.gz");
  assert.equal(pick(NEOVIM, { os: "darwin", arch: "arm64" }), "nvim-macos-arm64.tar.gz");
  assert.equal(pick(NEOVIM, { os: "windows", arch: "x64" }), "nvim-win64.zip");
});

test("refuses to guess when a release is ambiguous", () => {
  assert.equal(pick(["tool-a.tar.gz", "tool-b.tar.gz"], { os: "linux", arch: "x64" }), undefined);
  assert.equal(pick(["app-linux-x64-gtk.tar.gz", "app-linux-x64-qt6.tar.gz"], { os: "linux", arch: "x64" }), undefined);
  assert.equal(pick(GH, { os: "freebsd", arch: "x64" }), undefined);
  assert.equal(pick(["a.sha256", "checksums.txt"], { os: "linux", arch: "x64" }), undefined);
  assert.equal(pick([], { os: "linux", arch: "x64" }), undefined);
});

test("a release with a single real artefact needs no guessing", () => {
  assert.equal(pick(["plugin.jar", "plugin.jar.sha256"], { os: "linux", arch: "x64" }), "plugin.jar");
  assert.equal(pick(["only-for-windows.exe"], { os: "linux", arch: "x64" }), undefined);
});

test("token boundaries: darwin is not win, x86_64 is not x86, arm64 is not arm", () => {
  const linux: Platform = { os: "linux", arch: "x64" };
  assert.ok(scoreAsset("tool-darwin-x86_64.tar.gz", { os: "windows", arch: "x64" }) < 0);
  assert.ok(scoreAsset("tool-linux-x86_64.tar.gz", { os: "linux", arch: "ia32" }) < 0);
  assert.ok(scoreAsset("tool-linux-arm64.tar.gz", { os: "linux", arch: "arm" }) < 0);
  assert.ok(scoreAsset("tool-linux-x86_64.tar.gz", linux) > scoreAsset("tool-linux-x86_64-debug.tar.gz", linux));
  assert.ok(scoreAsset("tool-linux-x86_64.tar.gz", linux) > scoreAsset("tool-linux-x86_64.deb", linux));
});

test("Apple silicon prefers native but accepts Intel under Rosetta", () => {
  const m1: Platform = { os: "darwin", arch: "arm64" };
  assert.equal(pick(["t-darwin-amd64.tar.gz", "t-linux-amd64.tar.gz"], m1), "t-darwin-amd64.tar.gz");
  assert.equal(pick(["t-darwin-amd64.tar.gz", "t-darwin-arm64.tar.gz"], m1), "t-darwin-arm64.tar.gz");
});

test("detectPlatform normalises aliases", () => {
  assert.deepEqual(detectPlatform({ os: "macOS", arch: "aarch64" }), { os: "darwin", arch: "arm64" });
  assert.deepEqual(detectPlatform({ os: "win", arch: "amd64" }), { os: "windows", arch: "x64" });
});
