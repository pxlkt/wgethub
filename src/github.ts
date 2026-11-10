import { createHash } from "node:crypto";
import type { Cache } from "./cache.ts";
import { Exit, WgethubError, sleep as defaultSleep } from "./errors.ts";
import { formatDuration } from "./ui/format.ts";

export interface Asset {
  id: number;
  name: string;
  size: number;
  /** API URL; with a token and `Accept: application/octet-stream` it redirects to the bytes. */
  url: string;
  browser_download_url: string;
  digest?: string | null;
  download_count?: number;
}

export interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
  tarball_url: string | null;
  zipball_url: string | null;
  assets: Asset[];
}

export interface RepoHit {
  full_name: string;
  description: string | null;
  stargazers_count: number;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

export interface GitHubOptions {
  apiUrl: string;
  token?: string | undefined;
  cache?: Cache | undefined;
  fetch?: typeof fetch;
  warn?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  /** How many times a flaky request is retried before we give up (or fall back to cache). */
  retries?: number;
}

const enc = encodeURIComponent;

export class GitHub {
  readonly apiUrl: string;
  readonly token: string | undefined;
  private readonly cache: Cache | undefined;
  private readonly fetch: typeof fetch;
  private readonly warn: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  private readonly retries: number;
  private warnedStale = false;

  constructor(options: GitHubOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.cache = options.cache;
    this.fetch = options.fetch ?? fetch;
    this.warn = options.warn ?? (() => {});
    this.sleep = options.sleep ?? ((ms) => defaultSleep(ms));
    this.userAgent = options.userAgent ?? "wgethub";
    this.retries = options.retries ?? 3;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": this.userAgent,
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private stale<T>(body: unknown, why: string): T {
    if (!this.warnedStale) {
      this.warnedStale = true;
      this.warn(`${why}; using cached release data, which may be out of date.`);
    }
    return body as T;
  }

  /**
   * GET a JSON resource, as stubbornly as is reasonable:
   *  - revalidates with If-None-Match, so unchanged data is a cheap 304
   *  - retries network errors and 5xx with exponential backoff and jitter
   *  - waits out short secondary rate limits (Retry-After)
   *  - when GitHub is unreachable or we are rate limited, serves the last
   *    good copy from the cache instead of failing
   */
  async request<T>(path: string): Promise<T> {
    const url = this.apiUrl + path;
    // Never serve one identity's cached view of a private repo to another.
    const identity = this.token ? createHash("sha256").update(this.token).digest("hex").slice(0, 12) : "anon";
    const key = `${identity} ${url}`;
    const cached = this.cache?.get(key);
    const headers = this.headers(cached ? { "if-none-match": cached.etag } : {});

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.retries;
      const backoff = Math.min(8000, 400 * 2 ** attempt) * (0.75 + Math.random() / 2);

      let response: Response;
      try {
        response = await this.fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      } catch (error) {
        if (!last) {
          await this.sleep(backoff);
          continue;
        }
        if (cached) return this.stale<T>(cached.body, "GitHub is unreachable");
        const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
        throw new WgethubError(`Could not reach ${new URL(url).host}: ${reason}`, Exit.failure, "Check your connection (and any proxy settings).");
      }

      if (response.status === 304 && cached) return cached.body as T;

      if (response.ok) {
        const body = (await response.json()) as T;
        const etag = response.headers.get("etag");
        if (etag) this.cache?.set(key, { url, etag, body, savedAt: Date.now() });
        return body;
      }

      const message = await response
        .json()
        .then((body) => String((body as { message?: unknown }).message ?? ""))
        .catch(() => "");

      if (response.status === 404) throw new WgethubError(`Not found: ${path}`, Exit.notFound);

      if (response.status === 401) {
        throw new WgethubError("GitHub rejected the token (401 Bad credentials).", Exit.rateLimited, "Refresh GITHUB_TOKEN / `gh auth login`, or pass --no-auth to go anonymous.");
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const limited =
        (response.status === 403 || response.status === 429) &&
        (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after") || /rate limit/i.test(message));

      if (limited) {
        if (!last && retryAfter > 0 && retryAfter <= 20) {
          await this.sleep(retryAfter * 1000);
          continue;
        }
        if (cached) return this.stale<T>(cached.body, "GitHub rate limit reached");
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const wait = retryAfter > 0 ? retryAfter : reset > 0 ? Math.max(0, reset - Date.now() / 1000) : undefined;
        throw new WgethubError(
          `GitHub API rate limit reached${wait === undefined ? "" : ` (resets in ${formatDuration(wait)})`}.`,
          Exit.rateLimited,
          this.token ? "Wait for the reset and try again." : "Set GITHUB_TOKEN or run `gh auth login` for 5,000 requests/hour instead of 60.",
        );
      }

      if (response.status >= 500) {
        if (!last) {
          await this.sleep(backoff);
          continue;
        }
        if (cached) return this.stale<T>(cached.body, `GitHub is having a bad day (HTTP ${response.status})`);
      }

      throw new WgethubError(`GitHub API error ${response.status}${message ? `: ${message}` : ""}`, Exit.failure);
    }
  }

  listReleases(owner: string, repo: string): Promise<Release[]> {
    return this.request<Release[]>(`/repos/${enc(owner)}/${enc(repo)}/releases?per_page=100`);
  }

  /**
   * The release a human means by "latest". GitHub's /releases/latest ignores
   * pre-releases and 404s for repos that only ship pre-releases, so we fall
   * back to the newest published release of any kind and say so.
   */
  async latestRelease(owner: string, repo: string, includePre: boolean): Promise<Release> {
    if (!includePre) {
      try {
        return await this.request<Release>(`/repos/${enc(owner)}/${enc(repo)}/releases/latest`);
      } catch (error) {
        if (!(error instanceof WgethubError) || error.code !== Exit.notFound) throw error;
      }
    }
    let releases: Release[];
    try {
      releases = await this.listReleases(owner, repo);
    } catch (error) {
      if (error instanceof WgethubError && error.code === Exit.notFound) throw this.noSuchRepo(owner, repo);
      throw error;
    }
    const newest = releases.find((release) => !release.draft);
    if (!newest) {
      throw new WgethubError(`${owner}/${repo} has not published any releases.`, Exit.notFound, "Add --source to download the source code of the default branch instead.");
    }
    if (!includePre && newest.prerelease) this.warn(`${owner}/${repo} only has pre-releases; using ${newest.tag_name}.`);
    return newest;
  }

  /** Looks a tag up exactly, then with the `v` prefix toggled, because nobody remembers which one a project uses. */
  async releaseByTag(owner: string, repo: string, tag: string): Promise<Release> {
    const variants = [tag, tag.startsWith("v") ? tag.slice(1) : `v${tag}`].filter(Boolean);
    for (const variant of variants) {
      try {
        return await this.request<Release>(`/repos/${enc(owner)}/${enc(repo)}/releases/tags/${enc(variant)}`);
      } catch (error) {
        if (!(error instanceof WgethubError) || error.code !== Exit.notFound) throw error;
      }
    }
    let known: Release[];
    try {
      known = await this.listReleases(owner, repo);
    } catch (error) {
      if (error instanceof WgethubError && error.code === Exit.notFound) throw this.noSuchRepo(owner, repo);
      throw error;
    }
    const recent = known.slice(0, 5).map((release) => release.tag_name).join(", ");
    throw new WgethubError(`${owner}/${repo} has no release tagged "${tag}".`, Exit.notFound, recent ? `Recent tags: ${recent}` : undefined);
  }

  private noSuchRepo(owner: string, repo: string): WgethubError {
    return new WgethubError(
      `Repository ${owner}/${repo} does not exist${this.token ? " (or your token cannot see it)" : " (or it is private)"}.`,
      Exit.notFound,
      this.token ? undefined : "For private repositories set GITHUB_TOKEN or run `gh auth login`.",
    );
  }

  /** Search by name first, most-starred first, since that is what people mean; fall back to a full-text search. */
  async searchRepos(query: string, limit = 8): Promise<RepoHit[]> {
    type Result = { items?: RepoHit[] };
    const byName = await this.request<Result>(`/search/repositories?q=${enc(`${query} in:name`)}&sort=stars&per_page=${limit}`);
    if (byName.items?.length) return byName.items;
    const anywhere = await this.request<Result>(`/search/repositories?q=${enc(query)}&per_page=${limit}`);
    return anywhere.items ?? [];
  }

  async rateLimit(): Promise<RateLimit> {
    const result = await this.request<{ resources: { core: RateLimit } }>("/rate_limit");
    return result.resources.core;
  }

  /**
   * Turns an API download URL into the short-lived signed URL it redirects to.
   * This is how private assets reach wget without the token ever appearing on
   * wget's command line (visible in `ps`) or being replayed to the CDN.
   */
  async signedUrl(apiDownloadUrl: string, accept = "application/octet-stream"): Promise<string | undefined> {
    if (!this.token) return undefined;
    try {
      if (new URL(apiDownloadUrl).origin !== new URL(this.apiUrl).origin) return undefined;
      const response = await this.fetch(apiDownloadUrl, {
        headers: this.headers({ accept }),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      await response.body?.cancel().catch(() => {});
      return response.status >= 300 && response.status < 400 ? (response.headers.get("location") ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }
}
