/**
 * alert-github-client.ts
 *
 * Thin GitHub REST API client used by alert-incident-bridge.ts.
 * Uses the native `fetch` API (Node 22+) with the GH_TOKEN for auth.
 */

import type { GitHubApiClient, GitHubIssue } from "./alert-incident-bridge.js";

const GH_API = "https://api.github.com";

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function ghFetch<T>(
  token: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${GH_API}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: { ...authHeaders(token), ...(options.headers ?? {}) },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub API ${path} → ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

export function createGitHubApiClient(token: string): GitHubApiClient {
  return {
    async searchIssues(owner, repo, searchToken) {
      const marker = `<!-- ${searchToken} -->`;
      const matches: GitHubIssue[] = [];
      let page = 1;

      while (true) {
        const pageItems = await ghFetch<Array<GitHubIssue & { pull_request?: unknown }>>(
          token,
          `/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`
        );
        if (pageItems.length === 0) break;

        for (const issue of pageItems) {
          if ("pull_request" in issue) continue;
          if ((issue.body ?? "").includes(marker)) {
            matches.push(issue);
          }
        }

        if (pageItems.length < 100) break;
        page += 1;
      }

      return [...matches].sort((a, b) => a.number - b.number);
    },

    async createIssue(owner, repo, title, body, labels) {
      return ghFetch<GitHubIssue>(token, `/repos/${owner}/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title, body, labels }),
      });
    },

    async updateIssue(owner, repo, issueNumber, body, state) {
      return ghFetch<GitHubIssue>(
        token,
        `/repos/${owner}/${repo}/issues/${issueNumber}`,
        {
          method: "PATCH",
          body: JSON.stringify({ body, ...(state ? { state } : {}) }),
        }
      );
    },

    async addIssueComment(owner, repo, issueNumber, comment) {
      await ghFetch(token, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: comment }),
      });
    },
  };
}
