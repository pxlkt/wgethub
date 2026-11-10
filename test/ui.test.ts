import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, formatDuration, shellQuote, timeAgo, truncate, truncateMiddle } from "../src/ui/format.ts";
import { type Choice, type PickerState, filterChoices, fuzzyScore, reduce } from "../src/ui/picker.ts";
import { Row } from "../src/ui/progress.ts";

test("formatBytes / formatDuration", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(150 * 1024 * 1024), "150 MiB");
  assert.equal(formatBytes(-1), "?");
  assert.equal(formatDuration(4.4), "4s");
  assert.equal(formatDuration(65), "1m 05s");
  assert.equal(formatDuration(3725), "1h 02m");
  assert.equal(formatDuration(Infinity), "?");
});

test("timeAgo", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  assert.equal(timeAgo("2026-01-09T23:59:50Z", now), "just now");
  assert.equal(timeAgo("2026-01-09T22:00:00Z", now), "2 hours ago");
  assert.equal(timeAgo("2026-01-09T00:00:00Z", now), "1 day ago");
  assert.equal(timeAgo("2024-01-10T00:00:00Z", now), "2 years ago");
  assert.equal(timeAgo(null, now), "unpublished");
});

test("truncation keeps what matters", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal([...truncate("abcdefghij", 5)].length, 5);
  const middle = truncateMiddle("ripgrep-14.1.0-x86_64-unknown-linux-musl.tar.gz", 20);
  assert.equal([...middle].length, 20);
  assert.ok(middle.endsWith(".tar.gz"), "the extension survives");
});

test("shellQuote produces pasteable commands", () => {
  assert.equal(shellQuote(["wget", "--tries=5", "https://x.test/a b", "it's"]), `wget --tries=5 'https://x.test/a b' 'it'\\''s'`);
});

test("fuzzyScore ranks substrings above scattered matches and rejects misses", () => {
  assert.equal(fuzzyScore("xyz", "linux-amd64"), null);
  assert.ok(fuzzyScore("amd", "linux-amd64")! > fuzzyScore("lamd", "linux-amd64")!);
  assert.ok(fuzzyScore("linux amd64", "tool-linux-amd64.tar.gz") !== null, "terms match independently");
  assert.ok(fuzzyScore("lnxamd", "tool-linux-amd64.tar.gz") !== null, "subsequence still matches");
  assert.equal(fuzzyScore("linux zzz", "tool-linux-amd64.tar.gz"), null);
});

const choices: Choice<string>[] = ["linux-amd64.tar.gz", "linux-arm64.tar.gz", "darwin-arm64.zip", "windows-amd64.zip"].map((label) => ({ label, value: label }));
const start: PickerState = { query: "", cursor: 0, marked: new Set(), done: undefined };
const type = (state: PickerState, text: string, multi = false) => [...text].reduce((s, ch) => reduce(s, { sequence: ch, name: ch }, choices, multi), state);

test("filterChoices keeps order for an empty query and narrows otherwise", () => {
  assert.deepEqual(filterChoices(choices, ""), [0, 1, 2, 3]);
  assert.deepEqual(filterChoices(choices, "arm64"), [1, 2]);
  assert.deepEqual(filterChoices(choices, "zip windows"), [3]);
});

test("picker: typing filters, arrows are clamped, enter submits", () => {
  let state = type(start, "arm");
  assert.equal(state.query, "arm");
  state = reduce(state, { name: "down" }, choices, false);
  state = reduce(state, { name: "down" }, choices, false);
  assert.equal(state.cursor, 1, "cannot move past the last match");
  state = reduce(state, { name: "up" }, choices, false);
  state = reduce(state, { name: "up" }, choices, false);
  assert.equal(state.cursor, 0);
  assert.equal(reduce(state, { name: "return" }, choices, false).done, "submit");
});

test("picker: enter does nothing when nothing matches; backspace recovers", () => {
  let state = type(start, "qqq");
  assert.equal(reduce(state, { name: "return" }, choices, false).done, undefined);
  state = reduce(state, { name: "u", ctrl: true }, choices, false);
  assert.equal(state.query, "");
  assert.equal(reduce(type(start, "ab"), { name: "backspace" }, choices, false).query, "a");
});

test("picker: escape clears the filter first, then cancels; ctrl-c always cancels", () => {
  const typed = type(start, "arm");
  const cleared = reduce(typed, { name: "escape" }, choices, false);
  assert.equal(cleared.query, "");
  assert.equal(cleared.done, undefined);
  assert.equal(reduce(cleared, { name: "escape" }, choices, false).done, "cancel");
  assert.equal(reduce(typed, { name: "c", ctrl: true }, choices, false).done, "cancel");
});

test("picker: tab marks in multi mode only, and marks survive re-filtering", () => {
  assert.equal(reduce(start, { name: "tab" }, choices, false).marked.size, 0);
  let state = reduce(type(start, "darwin", true), { name: "tab" }, choices, true);
  assert.deepEqual([...state.marked], [2]);
  state = reduce(reduce(state, { name: "u", ctrl: true }, choices, true), { name: "tab" }, choices, true);
  assert.deepEqual([...state.marked].sort(), [0, 2]);
  state = reduce({ ...state, cursor: 0 }, { name: "tab" }, choices, true);
  assert.deepEqual([...state.marked], [2], "tab toggles");
});

test("picker ignores control sequences as text", () => {
  assert.equal(reduce(start, { sequence: "\x1b[A", name: undefined }, choices, false).query, "");
  assert.equal(reduce(start, { sequence: "x", meta: true }, choices, false).query, "");
});

test("progress row: speed is windowed and survives a restart", () => {
  const row = new Row("file", 1000);
  assert.equal(row.speed(), undefined);
  row.set(0, 0);
  row.set(500, 1000);
  assert.equal(row.speed(), 500);
  row.set(0, 1500);
  assert.equal(row.speed(), undefined, "a retry from zero resets the window");
  row.phase = "downloading";
  assert.match(row.render("*", 10, 100), /0%/);
});
