import { execFileSync } from "node:child_process";

export interface Auth {
  token: string | undefined;
  source: string;
}

export const DEFAULT_API = "https://api.github.com";

/**
 * Token lookup order: GITHUB_TOKEN, GH_TOKEN, then the GitHub CLI's stored login.
 * The gh fallback is only used against github.com itself. We never hand a
 * borrowed token to a custom API host.
 */
export function discoverAuth(apiUrl: string, enabled: boolean, env: NodeJS.ProcessEnv = process.env): Auth {
  if (!enabled) return { token: undefined, source: "disabled (--no-auth)" };
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, source: "GH_TOKEN" };
  if (apiUrl === DEFAULT_API) {
    try {
      const token = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (token) return { token, source: "gh CLI" };
    } catch {
      // gh is not installed or not logged in
    }
  }
  return { token: undefined, source: "none (60 requests/hour)" };
}
