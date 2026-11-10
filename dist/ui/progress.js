import { cyan, dim, unicode } from "./colors.js";
import { formatBytes, formatDuration, pad, truncate, truncateMiddle, visibleWidth } from "./format.js";
const FRAMES = unicode ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["|", "/", "-", "\\"];
const FILLED = unicode ? "━" : "#";
const EMPTY = unicode ? "─" : ".";
export class Row {
    label;
    total;
    bytes = 0;
    phase = "queued";
    samples = [];
    constructor(label, total) {
        this.label = label;
        this.total = total;
    }
    set(bytes, now = Date.now()) {
        // A retry that restarts from zero must not leave a negative speed behind.
        if (bytes < this.bytes)
            this.samples = [];
        this.bytes = bytes;
        this.samples.push({ at: now, bytes });
        while (this.samples.length > 2 && now - this.samples[0].at > 4000)
            this.samples.shift();
    }
    /** Bytes per second over the last few seconds, which is steadier than an instantaneous reading. */
    speed() {
        const first = this.samples[0];
        const last = this.samples.at(-1);
        if (!first || !last || last.at - first.at < 300)
            return undefined;
        return ((last.bytes - first.bytes) * 1000) / (last.at - first.at);
    }
    render(frame, labelWidth, columns) {
        const label = pad(truncateMiddle(this.label, labelWidth), labelWidth);
        const active = this.phase === "downloading" || this.phase === "resuming" || this.phase.startsWith("retry");
        if (!active)
            return `  ${cyan(frame)} ${label}  ${dim(this.phase)}`;
        const speed = this.speed();
        const rate = speed !== undefined && speed > 0 ? `${formatBytes(speed)}/s` : "";
        if (this.total === undefined || this.total === 0) {
            return `  ${cyan(frame)} ${label}  ${formatBytes(this.bytes)}  ${dim(rate)}`;
        }
        const ratio = Math.min(1, this.bytes / this.total);
        const eta = speed !== undefined && speed > 0 ? `eta ${formatDuration((this.total - this.bytes) / speed)}` : "";
        const stats = `${String(Math.floor(ratio * 100)).padStart(3)}%  ${formatBytes(this.bytes)}/${formatBytes(this.total)}  ${pad(rate, 12)} ${eta}`.trimEnd();
        const note = this.phase.startsWith("retry") ? ` ${dim(`(${this.phase})`)}` : "";
        const room = columns - 10 - labelWidth - visibleWidth(stats) - visibleWidth(note) - 2;
        if (room < 8)
            return `  ${cyan(frame)} ${label}  ${stats}${note}`;
        const width = Math.min(28, room);
        const filled = Math.round(ratio * width);
        return `  ${cyan(frame)} ${label}  ${cyan(FILLED.repeat(filled))}${dim(EMPTY.repeat(width - filled))}  ${stats}${note}`;
    }
}
/**
 * A live region at the bottom of the terminal: one line per in-flight download,
 * with finished lines scrolling away above it. On a pipe or in CI it degrades
 * to plain log lines, and in quiet mode it says nothing at all.
 */
export class Board {
    stream;
    live;
    quiet;
    rows = [];
    height = 0;
    frame = 0;
    timer;
    constructor(stream, options) {
        this.stream = stream;
        this.live = options.live && !options.quiet;
        this.quiet = options.quiet;
    }
    add(label, total) {
        const row = new Row(label, total);
        this.rows.push(row);
        if (this.live && !this.timer) {
            this.stream.write("\x1b[?25l");
            this.timer = setInterval(() => this.draw(), 80);
            this.timer.unref();
        }
        return row;
    }
    /** Retire a row, leaving a permanent line in its place. */
    finish(row, line) {
        this.rows = this.rows.filter((candidate) => candidate !== row);
        this.log(line);
    }
    log(line) {
        if (this.quiet)
            return;
        this.erase();
        this.stream.write(line + "\n");
        this.draw();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        this.erase();
        this.rows = [];
        if (this.live)
            this.stream.write("\x1b[?25h");
    }
    erase() {
        if (!this.live || this.height === 0)
            return;
        this.stream.write(`\x1b[${this.height}A\r\x1b[0J`);
        this.height = 0;
    }
    draw() {
        if (!this.live)
            return;
        this.erase();
        if (this.rows.length === 0)
            return;
        const columns = Math.max(40, this.stream.columns || 80);
        const frame = FRAMES[this.frame++ % FRAMES.length];
        const labelWidth = Math.min(Math.max(...this.rows.map((row) => row.label.length)), Math.max(12, Math.floor(columns * 0.35)));
        // Never let a line wrap: the cursor arithmetic above depends on one row per line.
        const lines = this.rows.map((row) => clip(row.render(frame, labelWidth, columns), columns - 1));
        this.stream.write(lines.join("\n") + "\n");
        this.height = lines.length;
    }
}
function clip(line, width) {
    if (visibleWidth(line) <= width)
        return line;
    // Rare (very narrow terminals): drop styling rather than risk cutting an escape sequence in half.
    // eslint-disable-next-line no-control-regex
    return truncate(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), width);
}
