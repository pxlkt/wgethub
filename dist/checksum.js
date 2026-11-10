import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { assertSafeUrl } from "./wget.js";
export function hashFile(path, algorithm) {
    return new Promise((resolve, reject) => {
        const hash = createHash(algorithm);
        createReadStream(path)
            .on("error", reject)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => resolve(hash.digest("hex")));
    });
}
function algorithmFor(hex) {
    if (hex.length === 64)
        return "sha256";
    if (hex.length === 128)
        return "sha512";
    return undefined;
}
/** GitHub's own `digest` field on a release asset, e.g. "sha256:ab12…". */
export function parseDigest(digest) {
    const match = /^(sha256|sha512):([0-9a-f]+)$/i.exec(digest ?? "");
    if (!match)
        return undefined;
    const hex = match[2].toLowerCase();
    const algorithm = match[1].toLowerCase();
    return algorithmFor(hex) === algorithm ? { algorithm, hex, source: "GitHub digest" } : undefined;
}
/**
 * Parses every checksum-file dialect seen in the wild:
 *   GNU coreutils   `<hex>  file`  and  `<hex> *file`
 *   BSD / openssl   `SHA256 (file) = <hex>`  and  `SHA2-256(file)= <hex>`
 *   bare            `<hex>`
 */
export function parseChecksums(text) {
    const byName = new Map();
    let bare;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#"))
            continue;
        const bsd = /^[A-Za-z0-9-]+\s*\((.+)\)\s*=\s*([0-9a-fA-F]+)$/.exec(line);
        if (bsd && algorithmFor(bsd[2])) {
            byName.set(basename(bsd[1]), bsd[2].toLowerCase());
            continue;
        }
        const gnu = /^([0-9a-fA-F]+)\s+[* ]?(.+)$/.exec(line);
        if (gnu && algorithmFor(gnu[1])) {
            byName.set(basename(gnu[2]), gnu[1].toLowerCase());
            continue;
        }
        if (/^[0-9a-fA-F]+$/.test(line) && algorithmFor(line))
            bare ??= line.toLowerCase();
    }
    return { byName, bare };
}
function basename(path) {
    return path.trim().replace(/^.*[\\/]/, "");
}
const GENERIC = /^(.*[._-])?(sha(256|512)?sums?|checksums?)(\.txt|\.sha256)?$/i;
/** Candidate checksum files for `asset`, most specific first. */
export function checksumCandidates(asset, siblings) {
    const lower = asset.name.toLowerCase();
    const others = siblings.filter((sibling) => sibling.name !== asset.name);
    const dedicated = others.filter((sibling) => [".sha256", ".sha256sum", ".sha512", ".sha512sum", ".sha256.txt"].some((ext) => sibling.name.toLowerCase() === lower + ext));
    const generic = others.filter((sibling) => GENERIC.test(sibling.name) && !dedicated.includes(sibling));
    return [...dedicated, ...generic];
}
/** Small-text fetcher with a hard size cap; a checksum file has no business being megabytes. */
export function textFetcher(fetchImpl = fetch, limit = 2 * 1024 * 1024) {
    const memo = new Map();
    return (url) => {
        let pending = memo.get(url);
        if (!pending) {
            pending = (async () => {
                try {
                    assertSafeUrl(url);
                    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "wgethub" } });
                    if (!response.ok)
                        return undefined;
                    const text = await response.text();
                    return text.length > limit ? undefined : text;
                }
                catch {
                    return undefined;
                }
            })();
            memo.set(url, pending);
        }
        return pending;
    };
}
/**
 * Finds the strongest available expected hash for an asset:
 * GitHub's digest first, then checksum files published in the same release.
 */
export async function findExpected(asset, siblings, fetchText) {
    const digest = parseDigest(asset.digest);
    if (digest)
        return digest;
    for (const candidate of checksumCandidates(asset, siblings)) {
        const text = await fetchText(candidate.browser_download_url);
        if (!text)
            continue;
        const parsed = parseChecksums(text);
        const dedicated = candidate.name.toLowerCase().startsWith(asset.name.toLowerCase());
        const hex = parsed.byName.get(asset.name) ?? (dedicated ? parsed.bare : undefined);
        const algorithm = hex ? algorithmFor(hex) : undefined;
        if (hex && algorithm)
            return { algorithm, hex, source: candidate.name };
    }
    return undefined;
}
