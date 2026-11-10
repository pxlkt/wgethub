import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Cache } from "../src/cache.ts";
import { Exit, WgethubError } from "../src/errors.ts";
import { GitHub } from "../src/github.ts";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler, extra: { token?: string; cache?: Cache } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const warnings: string[] = [];
  const fake = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: init.headers as Record<string, string> });
    return handler(String(input), init);
  }) as typeof fetch;
  const github = new GitHub({ apiUrl: "https://api.test", fetch: fake, warn: (m) => warnings.push(m), sleep: async () => {}, ...extra });
  return { github, calls, warnings };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });
const tmpCache = () => new Cache(mkdtempSync(join(tmpdir(), "wgethub-cache-")));
const code = (expected: number) => (error: unknown) => error instanceof WgethubError && error.code === expected;

test("sends auth and API headers", async () => {
  const { github, calls } = client(() => json({ ok: true }), { token: "s3cret" });
  await github.request("/x");
  assert.equal(calls[0]!.headers.authorization, "Bearer s3cret");
  assert.equal(calls[0]!.headers.accept, "application/vnd.github+json");
  assert.ok(calls[0]!.headers["user-agent"]);
});

test("revalidates with the ETag and serves 304s from cache", async () => {
  const cache = tmpCache();
  let hits = 0;
  const handler: Handler = (_url, init) => {
    hits++;
    const tag = (init.headers as Record<string, string>)["if-none-match"];
    return tag === '"v1"' ? new Response(null, { status: 304 }) : json({ n: 1 }, { headers: { etag: '"v1"' } });
  };
  assert.deepEqual(await client(handler, { cache }).github.request("/r"), { n: 1 });
  assert.deepEqual(await client(handler, { cache }).github.request("/r"), { n: 1 });
  assert.equal(hits, 2);
});

test("cache entries are not shared between identities", async () => {
  const cache = tmpCache();
  await client(() => json({ secret: true }, { headers: { etag: '"p"' } }), { cache, token: "alice" }).github.request("/r");
  const anon = client(() => json({ secret: false }), { cache });
  assert.deepEqual(await anon.github.request("/r"), { secret: false });
  assert.equal(anon.calls[0]!.headers["if-none-match"], undefined);
});

test("retries transient failures", async () => {
  let n = 0;
  const { github } = client(() => {
    n++;
    if (n === 1) throw new TypeError("fetch failed");
    if (n === 2) return json({}, { status: 502 });
    return json({ fine: true });
  });
  assert.deepEqual(await github.request("/r"), { fine: true });
  assert.equal(n, 3);
});

test("falls back to stale cache when GitHub is down or rate limited", async () => {
  const cache = tmpCache();
  await client(() => json({ v: "cached" }, { headers: { etag: '"e"' } }), { cache }).github.request("/r");

  const offline = client(() => { throw new TypeError("fetch failed"); }, { cache });
  assert.deepEqual(await offline.github.request("/r"), { v: "cached" });
  assert.match(offline.warnings[0]!, /unreachable/);

  const limited = client(() => json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }), { cache });
  assert.deepEqual(await limited.github.request("/r"), { v: "cached" });
  assert.match(limited.warnings[0]!, /rate limit/);
});

test("maps failures to precise exit codes", async () => {
  const limited = () => json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } });
  await assert.rejects(client(limited).github.request("/r"), (error: unknown) => code(Exit.rateLimited)(error) && /resets in/.test((error as Error).message) && /GITHUB_TOKEN/.test((error as WgethubError).hint ?? ""));
  await assert.rejects(client(() => json({ message: "Not Found" }, { status: 404 })).github.request("/r"), code(Exit.notFound));
  await assert.rejects(client(() => json({ message: "Bad credentials" }, { status: 401 })).github.request("/r"), code(Exit.rateLimited));
  await assert.rejects(client(() => { throw new TypeError("fetch failed"); }).github.request("/r"), code(Exit.failure));
  await assert.rejects(client(() => json({ message: "nope" }, { status: 403 })).github.request("/r"), /403: nope/);
});

test("waits out a short secondary rate limit", async () => {
  let n = 0;
  const { github } = client(() => (++n === 1 ? json({ message: "slow down" }, { status: 429, headers: { "retry-after": "2" } }) : json({ ok: 1 })));
  assert.deepEqual(await github.request("/r"), { ok: 1 });
});

const release = (tag: string, extra: object = {}) => ({ id: 1, tag_name: tag, name: tag, draft: false, prerelease: false, published_at: null, html_url: "", tarball_url: null, zipball_url: null, assets: [], ...extra });

test("releaseByTag toggles the v prefix", async () => {
  const { github, calls } = client((url) => (url.endsWith("/releases/tags/v1.2.3") ? json(release("v1.2.3")) : json({}, { status: 404 })));
  assert.equal((await github.releaseByTag("o", "r", "1.2.3")).tag_name, "v1.2.3");
  assert.deepEqual(calls.map((call) => call.url.split("/tags/")[1]), ["1.2.3", "v1.2.3"]);
});

test("releaseByTag suggests real tags when it finds nothing", async () => {
  const { github } = client((url) => (url.includes("/releases?") ? json([release("v9"), release("v8")]) : json({}, { status: 404 })));
  await assert.rejects(github.releaseByTag("o", "r", "v1"), (error: unknown) => code(Exit.notFound)(error) && /v9, v8/.test((error as WgethubError).hint ?? ""));
});

test("latestRelease falls back to a pre-release, and distinguishes empty repos from missing ones", async () => {
  const pre = client((url) => (url.includes("/releases?") ? json([release("draft", { draft: true }), release("v2-rc1", { prerelease: true })]) : json({}, { status: 404 })));
  assert.equal((await pre.github.latestRelease("o", "r", false)).tag_name, "v2-rc1");
  assert.match(pre.warnings[0]!, /only has pre-releases/);

  const empty = client((url) => (url.includes("/releases?") ? json([]) : json({}, { status: 404 })));
  await assert.rejects(empty.github.latestRelease("o", "r", false), /has not published any releases/);

  const missing = client(() => json({}, { status: 404 }));
  await assert.rejects(missing.github.latestRelease("o", "r", false), /does not exist/);
});

test("signedUrl returns the redirect target and never leaks the token elsewhere", async () => {
  const { github, calls } = client(() => new Response(null, { status: 302, headers: { location: "https://cdn.test/signed?sig=1" } }), { token: "t" });
  assert.equal(await github.signedUrl("https://api.test/repos/o/r/releases/assets/1"), "https://cdn.test/signed?sig=1");
  assert.equal(calls[0]!.headers.accept, "application/octet-stream");
  assert.equal(await github.signedUrl("https://evil.test/steal"), undefined);
  assert.equal(calls.length, 1, "no request is made to a foreign origin");
  assert.equal(await client(() => json({})).github.signedUrl("https://api.test/x"), undefined, "anonymous clients have nothing to sign with");
});
