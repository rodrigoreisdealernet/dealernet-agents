import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubApiClient } from "../alert-github-client.js";

describe("createGitHubApiClient.searchIssues", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses paginated issues list with local fingerprint-body matching", async () => {
    const filler = Array.from({ length: 98 }, (_, idx) => ({
      number: 100 + idx,
      title: `non-match-${idx}`,
      body: "no fingerprint marker",
      state: "open",
      html_url: `https://example/issues/${100 + idx}`,
      labels: [],
    }));
    const firstPage = [
      {
        number: 12,
        title: "newer duplicate",
        body: "body\n\n<!-- fingerprint:e2e-dev-failure -->",
        state: "open",
        html_url: "https://example/issues/12",
        labels: [],
      },
      {
        number: 99,
        title: "pull request masquerading as issue",
        body: "body\n\n<!-- fingerprint:e2e-dev-failure -->",
        state: "open",
        html_url: "https://example/issues/99",
        labels: [],
        pull_request: {},
      },
      ...filler,
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(firstPage), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              number: 7,
              title: "older canonical",
              body: "body\n\n<!-- fingerprint:e2e-dev-failure -->",
              state: "open",
              html_url: "https://example/issues/7",
              labels: [],
            },
          ]),
          { status: 200 }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = createGitHubApiClient("token");
    const matches = await client.searchIssues(
      "Volaris-AI",
      "dia",
      "fingerprint:e2e-dev-failure"
    );

    const requestedPaths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requestedPaths[0]).toContain(
      "/repos/Volaris-AI/dia/issues?state=open&per_page=100&page=1"
    );
    expect(requestedPaths[1]).toContain(
      "/repos/Volaris-AI/dia/issues?state=open&per_page=100&page=2"
    );
    expect(requestedPaths.some((path) => path.includes("/search/issues"))).toBe(false);
    expect(matches.map((issue) => issue.number)).toEqual([7, 12]);
  });
});
