import { spawn, spawnSync } from "node:child_process";
import { Exit, WgethubError } from "./errors.js";
/** Identify the wget on this machine. Returns undefined when there is none. */
export function detectWget(bin = process.env.WGETHUB_WGET || "wget") {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (probe.error)
        return undefined;
    const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
    const banner = output.trim().split("\n")[0]?.trim() ?? "";
    const wget2 = /GNU Wget2 (\d[\w.]*)/.exec(output);
    if (wget2)
        return { bin, flavor: "wget2", version: wget2[1], banner };
    const gnu = /GNU Wget (\d[\w.]*)/.exec(output);
    if (gnu)
        return { bin, flavor: "gnu", version: gnu[1], banner };
    if (/busybox/i.test(output)) {
        return { bin, flavor: "busybox", version: /BusyBox v(\d[\w.]*)/i.exec(output)?.[1], banner: banner || "BusyBox wget" };
    }
    return { bin, flavor: "unknown", version: undefined, banner: banner || bin };
}
function atLeast(version, major, minor) {
    const [a = 0, b = 0] = (version ?? "").split(".").map((part) => parseInt(part, 10) || 0);
    return a > major || (a === major && b >= minor);
}
/**
 * wget is handed a URL as an argv element (never through a shell), and only
 * ever an https one. Plain http is tolerated for loopback, which is what the
 * test-suite and local mirrors use.
 */
export function assertSafeUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new WgethubError(`Refusing to download from a malformed URL: ${raw}`, Exit.download);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new WgethubError(`Refusing to download over ${url.protocol.replace(":", "")}: ${raw}`, Exit.download);
    }
    return url;
}
/** Build the argv for one download, using only flags this flavour of wget understands. */
export function buildArgs(info, job) {
    const url = assertSafeUrl(job.url).href;
    if (info.flavor === "busybox") {
        return ["-q", ...(job.resume ? ["-c"] : []), "-T", String(job.timeout), "-U", job.userAgent, ...job.extra, "-O", job.dest, url];
    }
    const args = [
        "--no-verbose",
        `--tries=${job.tries}`,
        "--waitretry=5",
        "--retry-connrefused",
        `--timeout=${job.timeout}`,
        "--max-redirect=10",
        `--user-agent=${job.userAgent}`,
    ];
    if (job.resume)
        args.push("--continue");
    if (info.flavor === "wget2" || (info.flavor === "gnu" && atLeast(info.version, 1, 20))) {
        args.push("--retry-on-http-error=429,500,502,503,504");
    }
    args.push(...job.extra, `--output-document=${job.dest}`, url);
    return args;
}
const EXIT_MEANINGS = {
    1: "generic error",
    2: "wget could not parse its options",
    3: "file I/O error (disk full or no write permission?)",
    4: "network failure",
    5: "TLS certificate verification failed",
    6: "authentication failed",
    7: "protocol error",
    8: "the server answered with an error (missing file or no access)",
};
export function explainExit(code, flavor) {
    if (code === null)
        return "wget was killed by a signal";
    if (flavor === "busybox" || flavor === "unknown")
        return `wget exited with status ${code}`;
    return `wget exit ${code}: ${EXIT_MEANINGS[code] ?? "unknown error"}`;
}
/** Exit codes worth another attempt. Everything else will fail the same way again. */
export function isRetriable(code, flavor) {
    if (code === null)
        return false;
    if (flavor === "busybox" || flavor === "unknown")
        return code !== 0;
    return code === 1 || code === 4 || code === 7;
}
export function runWget(info, args, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(info.bin, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-4000);
        });
        const kill = () => child.kill("SIGTERM");
        signal.addEventListener("abort", kill, { once: true });
        if (signal.aborted)
            kill();
        child.on("error", (error) => {
            signal.removeEventListener("abort", kill);
            reject(new WgethubError(`Could not start wget: ${error.message}`, Exit.noWget));
        });
        child.on("close", (code) => {
            signal.removeEventListener("abort", kill);
            resolve({ code, stderr: stderr.trim() });
        });
    });
}
