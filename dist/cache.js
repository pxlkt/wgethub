import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export function defaultCacheDir(env = process.env) {
    if (env.WGETHUB_CACHE_DIR)
        return env.WGETHUB_CACHE_DIR;
    if (env.XDG_CACHE_HOME)
        return join(env.XDG_CACHE_HOME, "wgethub");
    if (process.platform === "darwin")
        return join(homedir(), "Library", "Caches", "wgethub");
    if (process.platform === "win32" && env.LOCALAPPDATA)
        return join(env.LOCALAPPDATA, "wgethub", "cache");
    return join(homedir(), ".cache", "wgethub");
}
/**
 * A tiny ETag cache for API responses. Strictly best-effort: a read-only home
 * directory or a corrupt entry must never break a download, so every failure
 * here is swallowed and treated as a cache miss.
 */
export class Cache {
    dir;
    constructor(dir = defaultCacheDir()) {
        this.dir = dir;
    }
    file(key) {
        return join(this.dir, createHash("sha256").update(key).digest("hex").slice(0, 32) + ".json");
    }
    get(key) {
        try {
            const entry = JSON.parse(readFileSync(this.file(key), "utf8"));
            return typeof entry.etag === "string" && "body" in entry ? entry : undefined;
        }
        catch {
            return undefined;
        }
    }
    set(key, entry) {
        try {
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            const file = this.file(key);
            const temp = `${file}.${process.pid}.tmp`;
            writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
            renameSync(temp, file); // atomic: a concurrent reader sees the old entry or the new one, never half
        }
        catch {
            // cache is optional
        }
    }
}
