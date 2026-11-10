// All human-facing output goes to stderr, so colour support is decided there.
const enabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stderr.isTTY) && process.env.TERM !== "dumb";
})();

const wrap = (open: number, close: number) => (text: string) =>
  enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const magenta = wrap(35, 39);

/** Fall back to ASCII on terminals that would render box-drawing as mojibake. */
export const unicode = (() => {
  if (process.env.WGETHUB_ASCII) return false;
  if (process.platform === "win32") return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM);
  if (process.env.TERM === "linux") return false;
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  return locale === "" || /utf-?8/i.test(locale);
})();

export const sym = unicode
  ? { ok: "✔", fail: "✖", warn: "▲", info: "●", pointer: "❯", star: "★", marked: "◉", unmarked: "◯", ellipsis: "…", dot: "·" }
  : { ok: "+", fail: "x", warn: "!", info: "*", pointer: ">", star: "*", marked: "[x]", unmarked: "[ ]", ellipsis: "...", dot: "-" };
