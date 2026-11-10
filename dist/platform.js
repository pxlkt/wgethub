/** Figures out which release asset was built for the machine we are running on. */
const OS_ALIASES = {
    win32: "windows", win: "windows", windows: "windows",
    macos: "darwin", mac: "darwin", osx: "darwin", darwin: "darwin",
    linux: "linux", freebsd: "freebsd", android: "android",
};
const ARCH_ALIASES = {
    x64: "x64", amd64: "x64", x86_64: "x64", "x86-64": "x64",
    arm64: "arm64", aarch64: "arm64",
    arm: "arm", armv7: "arm", armv7l: "arm", armhf: "arm",
    ia32: "ia32", x86: "ia32", i386: "ia32", i686: "ia32", "386": "ia32",
};
function detectLibc() {
    if (process.platform !== "linux")
        return undefined;
    try {
        const report = process.report?.getReport();
        return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
    }
    catch {
        return undefined;
    }
}
export function detectPlatform(overrides = {}) {
    const os = overrides.os?.toLowerCase() ?? process.platform;
    const arch = overrides.arch?.toLowerCase() ?? process.arch;
    const platform = { os: OS_ALIASES[os] ?? os, arch: ARCH_ALIASES[arch] ?? arch };
    // Only trust the libc probe when we are describing this very machine.
    const libc = overrides.os || overrides.arch ? undefined : detectLibc();
    if (libc)
        platform.libc = libc;
    return platform;
}
/** A token only counts when it is not glued to other letters or digits ("win" must not match "darwin"). */
const word = (alternatives) => new RegExp(`(?<![a-z0-9])(?:${alternatives})(?![a-z0-9])`);
const OS_PATTERNS = [
    ["android", word("android")],
    ["linux", word("linux(?:64|32)?|ubuntu|debian|manylinux\\w*")],
    ["darwin", word("darwin|macos(?:x)?|mac(?:64)?|osx|apple")],
    ["windows", word("windows|win(?:32|64)?|msvc|mingw(?:32|64)?")],
    ["freebsd", word("freebsd")],
    ["openbsd", word("openbsd")],
    ["netbsd", word("netbsd")],
];
const OS_EXTENSIONS = [
    ["windows", /\.(exe|msi|msix)$/],
    ["darwin", /\.(dmg|pkg)$/],
    ["linux", /\.(deb|rpm|appimage|flatpak|snap)$/],
];
const ARCH_PATTERNS = [
    ["x64", word("x86[_-]64|amd64|x64|win64|linux64|mac64|64-?bit")],
    ["arm64", word("arm64|aarch64|armv8")],
    ["arm", word("armv[567]l?|armhf|armel|arm|arm32")],
    ["ia32", word("i[3-6]86|x86(?![_-]64)|386|win32|linux32|32-?bit")],
    ["riscv64", word("riscv64")],
    ["ppc64le", word("ppc64le|ppc64|powerpc64le")],
    ["s390x", word("s390x")],
    ["universal", word("universal2?|noarch")],
];
/** Things that live next to the real artefact but are never what you came for. */
const SIDECAR = /(\.(sha\d*|sha\d+sums?|md5|sig|asc|pem|crt|cert|minisig|sigstore|sbom|spdx|json|jsonl|txt|ya?ml|pub|bundle|blockmap)$)|checksums?|sha256sums?/;
const DEBUG = /(?<![a-z0-9])(debug|dbg|dsym|symbols?|pdb|debuginfo|src|sources?)(?![a-z0-9])/;
const FORMATS = [
    [/\.(tar\.gz|tgz)$/, 9],
    [/\.tar\.xz$/, 8],
    [/\.zip$/, 7],
    [/\.tar\.zst$/, 6],
    [/\.tar\.bz2$/, 5],
    [/\.appimage$/, 4],
    [/\.(dmg|pkg|msi|exe)$/, 3],
    [/\.(deb|rpm)$/, 2],
];
export function isSidecar(name) {
    return SIDECAR.test(name.toLowerCase());
}
/**
 * Score how well an asset name fits a platform. Higher is better; anything
 * below MATCH_THRESHOLD never named our OS or CPU, so it is a guess.
 */
export function scoreAsset(name, platform) {
    const lower = name.toLowerCase();
    if (isSidecar(lower))
        return -1000;
    let score = 0;
    const named = new Set(OS_PATTERNS.filter(([, re]) => re.test(lower)).map(([os]) => os));
    for (const [os, re] of OS_EXTENSIONS)
        if (re.test(lower))
            named.add(os);
    if (named.has(platform.os))
        score += 40;
    else if (named.size > 0)
        score -= 200;
    const archs = new Set(ARCH_PATTERNS.filter(([, re]) => re.test(lower)).map(([arch]) => arch));
    // "x86" inside "x86_64" is already excluded by the word boundary, but "arm" also matches armv7 names.
    if (archs.has("arm64"))
        archs.delete("arm");
    if (archs.has(platform.arch))
        score += 30;
    else if (archs.has("universal"))
        score += 20;
    else if (archs.has("x64") && platform.arch === "arm64" && (platform.os === "darwin" || platform.os === "windows")) {
        score += 5; // runs under Rosetta / Prism, but a native build should win
    }
    else if (archs.size > 0)
        score -= 100;
    if (platform.os === "linux") {
        const musl = /(?<![a-z0-9])musl/.test(lower);
        const gnu = /(?<![a-z0-9])(gnu|glibc)/.test(lower);
        if (platform.libc === "musl")
            score += musl ? 10 : gnu ? -50 : 0;
        else if (platform.libc === "gnu")
            score += gnu ? 3 : musl ? 1 : 0; // static musl builds run anywhere
    }
    if (DEBUG.test(lower))
        score -= 60;
    const format = FORMATS.find(([re]) => re.test(lower));
    if (format)
        score += platform.os === "windows" && /\.zip$/.test(lower) ? 10 : format[1];
    return score;
}
export const MATCH_THRESHOLD = 30;
export function rankAssets(assets, platform) {
    return assets
        .map((asset) => ({ asset, score: scoreAsset(asset.name, platform) }))
        .sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));
}
/**
 * The asset we are willing to pick without asking: a clear, unique winner.
 * Returns undefined when the release is ambiguous. Guessing wrong silently is
 * worse than asking.
 */
export function pickBest(ranked) {
    const candidates = ranked.filter((entry) => entry.score > -1000);
    const [first, second] = candidates;
    if (!first)
        return undefined;
    if (candidates.length === 1 && first.score > -100)
        return first.asset;
    if (first.score < MATCH_THRESHOLD)
        return undefined;
    if (second && second.score === first.score)
        return undefined;
    return first.asset;
}
