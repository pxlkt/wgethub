import { sym } from "./colors.js";
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return "?";
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return "?";
    const s = Math.round(seconds);
    if (s < 60)
        return `${s}s`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
export function timeAgo(iso, now = Date.now()) {
    if (!iso)
        return "unpublished";
    const then = Date.parse(iso);
    if (Number.isNaN(then))
        return "unknown";
    const seconds = Math.max(0, (now - then) / 1000);
    const steps = [
        [60, "second"],
        [60, "minute"],
        [24, "hour"],
        [30, "day"],
        [12, "month"],
        [Infinity, "year"],
    ];
    let value = seconds;
    for (const [size, name] of steps) {
        if (value < size) {
            const n = Math.floor(value);
            if (name === "second")
                return "just now";
            return `${n} ${name}${n === 1 ? "" : "s"} ago`;
        }
        value /= size;
    }
    return "long ago";
}
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function stripAnsi(text) {
    return text.replace(ANSI, "");
}
export function visibleWidth(text) {
    return [...stripAnsi(text)].length;
}
/** Cut plain text down to `width` columns, marking the cut with an ellipsis. */
export function truncate(text, width) {
    const chars = [...text];
    if (chars.length <= width)
        return text;
    if (width <= 1)
        return chars.slice(0, Math.max(0, width)).join("");
    return chars.slice(0, width - 1).join("") + (sym.ellipsis.length === 1 ? sym.ellipsis : "~");
}
/** Like truncate, but keeps the tail, because for filenames the extension is the useful part. */
export function truncateMiddle(text, width) {
    const chars = [...text];
    if (chars.length <= width)
        return text;
    if (width <= 4)
        return truncate(text, width);
    const tail = Math.floor((width - 1) / 2);
    const head = width - 1 - tail;
    return chars.slice(0, head).join("") + (sym.ellipsis.length === 1 ? sym.ellipsis : "~") + chars.slice(-tail).join("");
}
export function pad(text, width) {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
/** Quote an argv for display, so a dry run can be pasted straight into a shell. */
export function shellQuote(args) {
    return args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(" ");
}
