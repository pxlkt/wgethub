import { createInterface, emitKeypressEvents } from "node:readline";
import { Interrupted } from "../errors.js";
import { bold, cyan, dim, green, sym } from "./colors.js";
import { truncate, visibleWidth } from "./format.js";
/** Score a fuzzy match; null means no match. Substrings beat scattered subsequences. */
export function fuzzyScore(query, text) {
    const haystack = text.toLowerCase();
    let total = 0;
    for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
        const index = haystack.indexOf(term);
        if (index !== -1) {
            total += 1000 - index;
            continue;
        }
        let score = 0;
        let from = 0;
        let previous = -2;
        for (const char of term) {
            const found = haystack.indexOf(char, from);
            if (found === -1)
                return null;
            score += found === previous + 1 ? 3 : 1;
            if (found === 0 || /[^a-z0-9]/.test(haystack[found - 1]))
                score += 2;
            score -= (found - from) * 0.1;
            previous = found;
            from = found + 1;
        }
        total += score;
    }
    return total;
}
/** Indices of the choices matching `query`, best first. An empty query keeps the original order. */
export function filterChoices(choices, query) {
    if (query.trim() === "")
        return choices.map((_, index) => index);
    return choices
        .map((choice, index) => ({ index, score: fuzzyScore(query, `${choice.label} ${choice.hint ?? ""}`) }))
        .filter((entry) => entry.score !== null)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.index);
}
/** Pure state transition for the picker, so the keyboard handling is unit-testable without a TTY. */
export function reduce(state, key, choices, multi, page = 8) {
    const filtered = filterChoices(choices, state.query);
    const clamp = (cursor) => Math.max(0, Math.min(filtered.length - 1, cursor));
    const retype = (query) => ({ ...state, query, cursor: 0 });
    if (key.ctrl && (key.name === "c" || key.name === "d"))
        return { ...state, done: "cancel" };
    if (key.name === "escape")
        return state.query ? retype("") : { ...state, done: "cancel" };
    if (key.name === "return" || key.name === "enter")
        return filtered.length ? { ...state, done: "submit" } : state;
    if (key.name === "up" || (key.ctrl && key.name === "p"))
        return { ...state, cursor: clamp(state.cursor - 1) };
    if (key.name === "down" || (key.ctrl && key.name === "n"))
        return { ...state, cursor: clamp(state.cursor + 1) };
    if (key.name === "pageup")
        return { ...state, cursor: clamp(state.cursor - page) };
    if (key.name === "pagedown")
        return { ...state, cursor: clamp(state.cursor + page) };
    if (key.name === "home")
        return { ...state, cursor: 0 };
    if (key.name === "end")
        return { ...state, cursor: clamp(Infinity) };
    if (key.name === "backspace")
        return retype(state.query.slice(0, -1));
    if (key.ctrl && key.name === "u")
        return retype("");
    if (key.name === "tab") {
        const index = filtered[state.cursor];
        if (!multi || index === undefined)
            return state;
        const marked = new Set(state.marked);
        if (!marked.delete(index))
            marked.add(index);
        return { ...state, marked, cursor: clamp(state.cursor + 1) };
    }
    // eslint-disable-next-line no-control-regex
    if (key.sequence && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(key.sequence))
        return retype(state.query + key.sequence);
    return state;
}
/**
 * A fuzzy-filtering picker drawn on stderr. Resolves with the chosen values
 * (one, or several in multi mode) and rejects with Interrupted on Esc / Ctrl-C.
 */
export function pick(options) {
    const { message, choices } = options;
    const multi = options.multi ?? false;
    const input = process.stdin;
    const output = process.stderr;
    const pageSize = Math.max(3, Math.min(options.pageSize ?? 10, (output.rows || 24) - 4));
    return new Promise((resolve, reject) => {
        let state = { query: "", cursor: 0, marked: new Set(), done: undefined };
        let height = 0;
        const draw = () => {
            const columns = Math.max(30, (output.columns || 80) - 1);
            const filtered = filterChoices(choices, state.query);
            const top = Math.max(0, Math.min(state.cursor - Math.floor(pageSize / 2), filtered.length - pageSize));
            const lines = [`${cyan("?")} ${bold(message)} ${dim(sym.pointer)} ${state.query}${dim("_")}  ${dim(`${filtered.length}/${choices.length}`)}`];
            for (const index of filtered.slice(top, top + pageSize)) {
                const choice = choices[index];
                const current = filtered[state.cursor] === index;
                const mark = multi ? (state.marked.has(index) ? green(sym.marked) : dim(sym.unmarked)) + " " : "";
                const prefix = `${current ? cyan(sym.pointer) : " "} ${mark}`;
                const room = columns - visibleWidth(prefix);
                const label = truncate(choice.label, room);
                const hint = choice.hint ? truncate(choice.hint, Math.max(0, room - visibleWidth(label) - 2)) : "";
                lines.push(`${prefix}${current ? bold(label) : label}${hint ? "  " + dim(hint) : ""}`);
            }
            if (filtered.length === 0)
                lines.push(dim("  nothing matches"));
            lines.push(dim(truncate(`  ↑↓ move ${sym.dot} type to filter ${sym.dot} ${multi ? `tab to mark several ${sym.dot} ` : ""}enter to confirm ${sym.dot} esc to cancel`, columns)));
            output.write((height ? `\x1b[${height}A\r\x1b[0J` : "") + lines.join("\n") + "\n");
            height = lines.length;
        };
        const finish = () => {
            input.off("keypress", onKey);
            if (input.isTTY)
                input.setRawMode(false);
            input.pause();
            output.write(`\x1b[${height}A\r\x1b[0J\x1b[?25h`);
        };
        const onKey = (_text, key) => {
            state = reduce(state, key ?? {}, choices, multi, pageSize);
            if (state.done === "cancel") {
                finish();
                reject(new Interrupted());
            }
            else if (state.done === "submit") {
                const filtered = filterChoices(choices, state.query);
                const indices = multi && state.marked.size > 0 ? [...state.marked].sort((a, b) => a - b) : [filtered[state.cursor]];
                finish();
                const summary = indices.map((index) => choices[index].label).join(", ");
                output.write(`${green(sym.ok)} ${bold(message)} ${dim(sym.pointer)} ${truncate(summary, Math.max(20, (output.columns || 80) - message.length - 8))}\n`);
                resolve(indices.map((index) => choices[index].value));
            }
            else {
                draw();
            }
        };
        emitKeypressEvents(input);
        if (input.isTTY)
            input.setRawMode(true);
        input.resume();
        output.write("\x1b[?25l");
        input.on("keypress", onKey);
        draw();
    });
}
/** A single line of free text. Rejects with Interrupted on Ctrl-C or end of input. */
export function ask(message) {
    return new Promise((resolve, reject) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        let answered = false;
        rl.on("SIGINT", () => rl.close());
        rl.on("close", () => {
            if (!answered) {
                process.stderr.write("\n");
                reject(new Interrupted());
            }
        });
        rl.question(`${cyan("?")} ${bold(message)} ${dim(sym.pointer)} `, (answer) => {
            answered = true;
            rl.close();
            resolve(answer.trim());
        });
    });
}
