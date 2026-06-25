import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGitHubContext } from "../github-context.js";

describe("getGitHubContext", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env["GITHUB_REPOSITORY"] = "Volaris-AI/dia";
    process.env["GITHUB_RUN_ID"] = "12345";
    process.env["GITHUB_SERVER_URL"] = "https://github.com";
    process.env["GITHUB_WORKSPACE"] = "/home/runner/work/dia";
    process.env["GITHUB_EVENT_NAME"] = "schedule";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("parses owner and repo from GITHUB_REPOSITORY", () => {
    const ctx = getGitHubContext();
    expect(ctx.owner).toBe("Volaris-AI");
    expect(ctx.repo).toBe("dia");
  });

  it("builds the run URL correctly", () => {
    const ctx = getGitHubContext();
    expect(ctx.runUrl).toBe(
      "https://github.com/Volaris-AI/dia/actions/runs/12345"
    );
  });

  it("falls back gracefully when env vars are absent", () => {
    delete process.env["GITHUB_REPOSITORY"];
    delete process.env["GITHUB_RUN_ID"];
    const ctx = getGitHubContext();
    expect(ctx.owner).toBe("");
    expect(ctx.runUrl).toBe("(local)");
  });
});
