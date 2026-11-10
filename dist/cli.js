#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { matcher, parseCli, parseTarget } from "./args.js";
import { DEFAULT_API, discoverAuth } from "./auth.js";
import { Cache, defaultCacheDir } from "./cache.js";
import { findExpected, textFetcher } from "./checksum.js";
import { downloadOne, pool } from "./download.js";
import { Exit, Interrupted, WgethubError } from "./errors.js";
import { GitHub } from "./github.js";
import { detectPlatform, isSidecar, pickBest, rankAssets } from "./platform.js";
import { bold, cyan, dim, green, red, sym, yellow } from "./ui/colors.js";
import { formatBytes, formatDuration, pad, shellQuote, timeAgo } from "./ui/format.js";
import { ask, pick } from "./ui/picker.js";
import { Board } from "./ui/progress.js";
import { buildArgs, detectWget } from "./wget.js";
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const USER_AGENT = `wgethub/${VERSION}`;
const HELP = `${bold("wgethub")} ${dim(`v${VERSION}`)}  the unreasonably robust way to wget a GitHub release

${bold("Usage")}
  wgethub                                 interactive: search, pick a release, pick files
  wgethub <owner/repo>[@tag] [asset...]   download the build that fits this machine
  wgethub <github url>                    repo, release and asset URLs all work
  wgethub <owner/repo> -- <wget flags>    everything after -- goes straight to wget

${bold("What to download")}
  -t, --tag <tag>          a specific release (v1.2.3 and 1.2.3 both resolve)
      --pre                let "latest" include pre-releases
  -a, --asset <pattern>    asset to fetch: substring or glob, repeatable
  -A, --all                every asset in the release
  -s, --source             the source tarball instead of release assets
      --zip                with --source: a zipball instead
      --os <os>            pick assets for another OS (linux, darwin, windows)
      --arch <arch>        pick assets for another CPU (x64, arm64, arm, ia32)
  -i, --interactive        always show the pickers
  -y, --yes                never prompt; fail instead of asking

${bold("How to download")}
  -o, --output-dir <dir>   where files go (default: here)
  -j, --jobs <n>           parallel downloads (default 3)
      --retries <n>        extra wgethub-level attempts per file (default 3)
      --tries <n>          wget's own --tries per attempt (default 5)
      --timeout <sec>      wget network timeout (default 30)
  -f, --force              overwrite existing files
      --no-verify          skip checksum verification
      --require-checksum   fail unless a SHA-256/512 is available to verify against

${bold("Look, don't touch")}
  -l, --list               list the release's assets
      --releases           list the repo's releases
      --print-url          print download URLs and exit
  -n, --dry-run            show the wget commands without running them
      --doctor             report on wget, auth, rate limit and platform

${bold("Output")}
      --json               machine-readable result on stdout
  -q, --quiet              errors only
      --no-auth            ignore GITHUB_TOKEN / GH_TOKEN / gh login
      --no-cache           do not read or write the ETag cache
  -h, --help   -V, --version

${bold("Examples")}
  wgethub cli/cli                         latest gh build for this OS and CPU
  wgethub BurntSushi/ripgrep@14.1.0       a specific version
  wgethub neovim/neovim '*.appimage'      choose by pattern
  wgethub sharkdp/bat --os windows --arch arm64
  wgethub torvalds/linux --source         source tarball
  wgethub cli/cli -- --limit-rate=2m      rate-limited by wget itself

${dim("Human output goes to stderr; stdout carries only paths, URLs or JSON, so it pipes cleanly.")}
`;
const err = (line) => process.stderr.write(line + "\n");
async function resolveRepo(session) {
    const { options, github, canPrompt } = session;
    let input = options.target;
    for (;;) {
        if (input === undefined) {
            if (!canPrompt)
                throw new WgethubError("No repository given.", Exit.usage, "Usage: wgethub <owner/repo>[@tag] [asset...]");
            input = await ask("Repository (owner/repo, URL, or search words)");
            if (input === "") {
                input = undefined;
                continue;
            }
        }
        let target;
        try {
            target = parseTarget(input);
        }
        catch (error) {
            if (options.target !== undefined || !(error instanceof WgethubError))
                throw error;
            err(`${red(sym.fail)} ${error.message}`);
            input = undefined;
            continue;
        }
        if (target.kind === "repo")
            return target;
        const hits = await github.searchRepos(target.query);
        if (hits.length === 0) {
            if (options.target !== undefined)
                throw new WgethubError(`No repository matches "${target.query}".`, Exit.notFound);
            err(`${red(sym.fail)} No repository matches "${target.query}".`);
            input = undefined;
            continue;
        }
        if (!canPrompt) {
            throw new WgethubError(`"${target.query}" is not an owner/repo.`, Exit.usage, `Did you mean ${hits.slice(0, 3).map((hit) => hit.full_name).join(", ")}?`);
        }
        const [chosen] = await pick({
            message: "Repository",
            choices: hits.map((hit) => ({
                label: hit.full_name,
                hint: `${sym.star} ${hit.stargazers_count.toLocaleString("en")}${hit.description ? `  ${hit.description}` : ""}`,
                value: hit.full_name,
            })),
        });
        return parseTarget(chosen);
    }
}
async function resolveRelease(session, owner, repo, tag, browse) {
    const { options, github } = session;
    if (tag)
        return github.releaseByTag(owner, repo, tag);
    if (!browse)
        return github.latestRelease(owner, repo, options.pre);
    const releases = (await github.listReleases(owner, repo).catch((error) => {
        if (error instanceof WgethubError && error.code === Exit.notFound)
            return undefined;
        throw error;
    }))?.filter((release) => !release.draft);
    // Let latestRelease produce the precise "no such repo" / "no releases" error.
    if (!releases || releases.length === 0)
        return github.latestRelease(owner, repo, true);
    const [chosen] = await pick({
        message: "Release",
        choices: releases.map((release) => ({
            label: release.tag_name,
            hint: releaseHint(release),
            value: release,
        })),
    });
    return chosen;
}
function releaseHint(release) {
    return [
        release.name && release.name !== release.tag_name ? release.name : undefined,
        timeAgo(release.published_at),
        `${release.assets.length} asset${release.assets.length === 1 ? "" : "s"}`,
        release.prerelease ? "pre-release" : undefined,
    ]
        .filter(Boolean)
        .join(` ${sym.dot} `);
}
async function chooseAssets(session, release, patterns, browse) {
    const { options, platform, canPrompt } = session;
    const { assets } = release;
    if (assets.length === 0) {
        throw new WgethubError(`Release ${release.tag_name} has no downloadable assets.`, Exit.notFound, "Add --source to download its source code instead.");
    }
    if (options.all)
        return assets;
    if (patterns.length > 0) {
        const chosen = new Set();
        for (const pattern of patterns) {
            const exact = assets.filter((asset) => asset.name === pattern);
            const matches = exact.length ? exact : assets.filter((asset) => matcher(pattern)(asset.name));
            if (matches.length === 0) {
                throw new WgethubError(`No asset in ${release.tag_name} matches "${pattern}".`, Exit.notFound, `Available: ${assets.map((asset) => asset.name).join(", ")}`);
            }
            for (const match of matches)
                chosen.add(match);
        }
        return [...chosen];
    }
    const ranked = rankAssets(assets, platform);
    const best = pickBest(ranked);
    if (best && !browse) {
        session.log(dim(`  auto-selected for ${describe(platform)} ${sym.dot} use --list to see all ${assets.length} assets`));
        return [best];
    }
    if (canPrompt) {
        return pick({
            message: "Assets",
            multi: true,
            choices: ranked.map(({ asset }) => ({
                label: asset.name,
                hint: `${formatBytes(asset.size)}${asset === best ? `  ${sym.star} fits this machine` : ""}`,
                value: asset,
            })),
        });
    }
    const candidates = ranked.filter((entry) => !isSidecar(entry.asset.name)).slice(0, 8);
    throw new WgethubError(`Cannot tell which asset of ${release.tag_name} fits ${describe(platform)}.`, Exit.usage, `Name one (or a pattern): ${candidates.map((entry) => entry.asset.name).join(", ")}`);
}
function describe(platform) {
    return `${platform.os}/${platform.arch}${platform.libc ? ` (${platform.libc})` : ""}`;
}
function sourceJob(session, owner, repo, release) {
    const { options, github } = session;
    const kind = options.zip ? "zipball" : "tarball";
    const ref = release?.tag_name;
    const url = (options.zip ? release?.zipball_url : release?.tarball_url) ?? `${github.apiUrl}/repos/${owner}/${repo}/${kind}${ref ? `/${encodeURIComponent(ref)}` : ""}`;
    const label = (ref ?? "HEAD").replace(/[^\w.-]+/g, "-");
    return {
        name: `${repo}-${label}.${options.zip ? "zip" : "tar.gz"}`,
        url,
        size: undefined,
        expected: undefined,
        resumable: false,
        authedUrl: () => github.signedUrl(url, "application/vnd.github+json"),
    };
}
async function doctor(session, wget, authSource) {
    const { github, platform } = session;
    const row = (name, value) => err(`  ${pad(dim(name), 10)} ${value}`);
    err(`${bold("wgethub")} ${VERSION}`);
    row("wget", wget ? `${green(sym.ok)} ${wget.banner} ${dim(`[${wget.flavor}]`)}` : `${red(sym.fail)} not found on PATH`);
    row("node", process.version);
    row("platform", describe(platform));
    row("auth", authSource);
    row("api", github.apiUrl);
    row("cache", session.options.cache ? defaultCacheDir() : "disabled (--no-cache)");
    try {
        const limit = await github.rateLimit();
        const left = `${limit.remaining}/${limit.limit} requests left`;
        row("rate", `${limit.remaining > 0 ? green(sym.ok) : red(sym.fail)} ${left}, resets in ${formatDuration(Math.max(0, limit.reset - Date.now() / 1000))}`);
    }
    catch (error) {
        row("rate", `${red(sym.fail)} ${error instanceof Error ? error.message : String(error)}`);
        return Exit.failure;
    }
    return wget ? Exit.ok : Exit.noWget;
}
function summarise(result) {
    const how = result.status === "already-complete" ? "already here" : result.status === "resumed" ? "resumed" : formatDuration(result.seconds);
    const proven = result.verified.startsWith("sha");
    return `${green(sym.ok)} ${result.name}  ${dim(`${formatBytes(result.bytes)} ${sym.dot} ${how} ${sym.dot}`)} ${proven ? green(result.verified) : yellow(result.verified)}`;
}
async function main(argv) {
    const options = parseCli(argv);
    if (options.help) {
        process.stdout.write(HELP);
        return Exit.ok;
    }
    if (options.version) {
        process.stdout.write(VERSION + "\n");
        return Exit.ok;
    }
    const log = (line) => {
        if (!options.quiet)
            err(line);
    };
    const warn = (line) => err(`${yellow(sym.warn)} ${line}`);
    if (options.legacyNoValidate)
        warn("--no-validate / -nv is no longer needed: wgethub 2 already makes a single API request.");
    const apiUrl = (process.env.WGETHUB_API_URL || DEFAULT_API).replace(/\/+$/, "");
    const auth = discoverAuth(apiUrl, options.auth);
    const github = new GitHub({
        apiUrl,
        token: auth.token,
        cache: options.cache ? new Cache() : undefined,
        warn,
        userAgent: USER_AGENT,
    });
    const session = {
        options,
        github,
        platform: detectPlatform({ os: options.os, arch: options.arch }),
        canPrompt: Boolean(process.stdin.isTTY && process.stderr.isTTY) && !options.yes && !options.json && !process.env.CI,
        log,
        warn,
    };
    if (options.interactive && !session.canPrompt) {
        throw new WgethubError("--interactive needs a terminal.", Exit.usage);
    }
    const wget = detectWget();
    if (options.doctor)
        return doctor(session, wget, auth.source);
    const inspectOnly = options.list || options.releases || options.printUrl;
    if (!wget && !inspectOnly) {
        throw new WgethubError("wget is not installed (or not on PATH).", Exit.noWget, "Install it with your package manager, e.g. `sudo apt install wget`, `brew install wget` or `winget install wget`.");
    }
    if (wget?.flavor === "busybox" && !inspectOnly)
        warn("BusyBox wget detected: downloads work, but without wget-level retries.");
    // With no arguments at all, or with -i, walk the user through every choice.
    const browse = session.canPrompt && (options.interactive || options.target === undefined);
    const target = await resolveRepo(session);
    const { owner, repo } = target;
    const slug = `${owner}/${repo}`;
    if (options.releases) {
        const releases = (await github.listReleases(owner, repo)).filter((release) => !release.draft);
        if (options.json) {
            process.stdout.write(JSON.stringify(releases.map(({ tag_name, name, prerelease, published_at, html_url, assets }) => ({ tag: tag_name, name, prerelease, published_at, url: html_url, assets: assets.length })), null, 2) + "\n");
        }
        else {
            const width = Math.max(...releases.map((release) => release.tag_name.length), 3);
            for (const release of releases)
                process.stdout.write(`${pad(release.tag_name, width)}  ${releaseHint(release)}\n`);
            if (releases.length === 0)
                log(dim(`${slug} has no releases.`));
        }
        return Exit.ok;
    }
    const tag = options.tag ?? target.tag;
    let release;
    try {
        release = await resolveRelease(session, owner, repo, tag, browse && !tag);
    }
    catch (error) {
        // A repo with no releases still has source code, as long as it actually exists.
        const noReleases = error instanceof WgethubError && error.code === Exit.notFound && /has not published/.test(error.message);
        if (!(options.source && !tag && noReleases))
            throw error;
    }
    if (release) {
        log(`${cyan(sym.info)} ${bold(slug)} ${dim(sym.dot)} ${bold(release.tag_name)}${release.prerelease ? yellow(" pre-release") : ""} ${dim(`${sym.dot} ${timeAgo(release.published_at)}`)}`);
    }
    else {
        log(`${cyan(sym.info)} ${bold(slug)} ${dim(`${sym.dot} default branch`)}`);
    }
    if (options.list && release) {
        const ranked = rankAssets(release.assets, session.platform);
        const best = pickBest(ranked);
        if (options.json) {
            process.stdout.write(JSON.stringify({ repo: slug, tag: release.tag_name, assets: release.assets.map((asset) => ({ name: asset.name, size: asset.size, url: asset.browser_download_url, digest: asset.digest ?? null, recommended: asset === best })) }, null, 2) + "\n");
        }
        else {
            const width = Math.max(...release.assets.map((asset) => asset.name.length), 4);
            for (const { asset } of ranked) {
                process.stdout.write(`${asset === best ? green(sym.star) : " "} ${pad(asset.name, width)}  ${pad(formatBytes(asset.size), 10)}${asset.digest ? dim(" sha256") : ""}\n`);
            }
            if (release.assets.length === 0)
                log(dim("This release has no assets."));
            else if (best)
                log(dim(`${sym.star} = best match for ${describe(session.platform)}`));
        }
        return Exit.ok;
    }
    // Decide what to fetch.
    let jobs;
    if (options.source) {
        jobs = [sourceJob(session, owner, repo, release)];
    }
    else {
        const patterns = [...(target.asset ? [target.asset] : []), ...options.patterns];
        const assets = await chooseAssets(session, release, patterns, browse);
        const fetchText = textFetcher();
        jobs = await Promise.all(assets.map(async (asset) => ({
            name: asset.name,
            url: asset.browser_download_url,
            size: asset.size,
            expected: options.verify ? await findExpected(asset, release.assets, fetchText) : undefined,
            resumable: true,
            authedUrl: () => github.signedUrl(asset.url),
        })));
    }
    if (options.printUrl) {
        for (const job of jobs)
            process.stdout.write(job.url + "\n");
        return Exit.ok;
    }
    if (options.requireChecksum) {
        const unprovable = jobs.filter((job) => !job.expected);
        if (unprovable.length > 0) {
            throw new WgethubError(`No checksum is published for: ${unprovable.map((job) => job.name).join(", ")}`, Exit.verify, "Drop --require-checksum to fall back to a size check.");
        }
    }
    const dir = resolve(options.outputDir);
    const controller = new AbortController();
    const context = {
        wget: wget,
        dir,
        retries: options.retries,
        tries: options.tries,
        timeout: options.timeout,
        force: options.force,
        verify: options.verify,
        userAgent: USER_AGENT,
        extraArgs: options.wgetArgs,
        signal: controller.signal,
    };
    if (options.dryRun) {
        for (const job of jobs) {
            const args = buildArgs(wget, { url: job.url, dest: resolve(dir, `${job.name}.part`), resume: job.resumable, tries: options.tries, timeout: options.timeout, userAgent: USER_AGENT, extra: options.wgetArgs });
            process.stdout.write(`${shellQuote([wget.bin, ...args])}\n`);
            log(dim(`  then verify ${job.expected ? `${job.expected.algorithm} (${job.expected.source})` : job.size !== undefined ? "size" : "nothing (no checksum published)"} and rename to ${job.name}`));
        }
        return Exit.ok;
    }
    try {
        mkdirSync(dir, { recursive: true });
    }
    catch (error) {
        throw new WgethubError(`Cannot create ${dir}: ${error.message}`, Exit.download);
    }
    const board = new Board(process.stderr, { live: Boolean(process.stderr.isTTY) && process.env.TERM !== "dumb", quiet: options.quiet });
    const interrupt = () => controller.abort();
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const started = Date.now();
    let settled;
    try {
        settled = await pool(jobs, options.jobs, async (job) => {
            const row = board.add(job.name, job.size);
            try {
                const result = await downloadOne(job, context, {
                    progress: (bytes) => row.set(bytes),
                    phase: (text) => {
                        row.phase = text;
                    },
                });
                board.finish(row, summarise(result));
                return result;
            }
            catch (error) {
                if (!(error instanceof Interrupted))
                    board.finish(row, `${red(sym.fail)} ${job.name}`);
                throw error;
            }
        });
    }
    finally {
        board.stop();
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
    }
    const done = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
    const failures = settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : []));
    if (options.json) {
        process.stdout.write(JSON.stringify({
            repo: slug,
            tag: release?.tag_name ?? null,
            files: done.map(({ name, path, bytes, status, verified, checksum }) => ({ name, path, bytes, status, verified, checksum: checksum ?? null })),
            failed: jobs.filter((_, index) => settled[index].status === "rejected").map((job) => job.name),
        }, null, 2) + "\n");
    }
    else if (!process.stdout.isTTY) {
        for (const result of done)
            process.stdout.write(result.path + "\n");
    }
    if (failures.some((failure) => failure instanceof Interrupted)) {
        err(`${yellow(sym.warn)} Interrupted. Partial downloads were kept as .part files; run the same command again to resume.`);
        return Exit.interrupted;
    }
    if (failures.length > 0) {
        for (const failure of failures)
            report(failure);
        return failures.map((failure) => (failure instanceof WgethubError ? failure.code : Exit.failure)).find((code) => code !== Exit.ok) ?? Exit.failure;
    }
    if (done.length > 1) {
        const bytes = done.reduce((sum, result) => sum + result.bytes, 0);
        log(dim(`  ${done.length} files ${sym.dot} ${formatBytes(bytes)} ${sym.dot} ${formatDuration((Date.now() - started) / 1000)} ${sym.dot} saved to ${dir}`));
    }
    return Exit.ok;
}
function report(error) {
    if (error instanceof Interrupted) {
        process.stderr.write("\x1b[?25h");
        return error.code;
    }
    if (error instanceof WgethubError) {
        const [headline, ...rest] = error.message.split("\n");
        err(`${red(sym.fail)} ${headline}`);
        for (const line of rest)
            err(dim(`  ${line}`));
        if (error.hint)
            err(`  ${dim("hint:")} ${error.hint}`);
        return error.code;
    }
    err(`${red(sym.fail)} Unexpected error. This is a bug in wgethub, please report it:`);
    err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return Exit.failure;
}
// A closed pipe (`wgethub --list x/y | head -1`) is not an error.
process.stdout.on("error", (error) => {
    if (error.code === "EPIPE")
        process.exit(0);
});
main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
}, (error) => {
    process.exitCode = report(error);
});
