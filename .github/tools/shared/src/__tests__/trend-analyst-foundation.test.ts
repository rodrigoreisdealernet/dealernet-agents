import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadAgent } from "../agent-loader.js";

type YamlDocument = Record<string, unknown>;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../../");
const AGENTS_PATH = join(REPO_ROOT, ".github", "agents");
const PIPELINE_DAILY_PATH = join(REPO_ROOT, ".github", "workflows", "pipeline-daily.yml");

function loadYamlFile(path: string): YamlDocument {
  const parsed = yaml.load(readFileSync(path, "utf8"));
  expect(parsed).toBeTruthy();
  return parsed as YamlDocument;
}

describe("trend-analyst lane foundations", () => {
  it("keeps the trend-analyst prompt contract", () => {
    const agent = loadAgent(AGENTS_PATH, "trend-analyst");

    expect(agent.frontmatter.name).toBe("trend-analyst");
    expect(agent.frontmatter.tools).toEqual(["gh"]);

    // Mission: cross-ticket trends, roll-ups only — never per-incident tickets
    // (that boundary is what keeps it from duplicating the lane agents).
    expect(agent.body).toContain("You file roll-ups, never per-incident tickets");
    // Dedup + dedicated label so trend roll-ups never collide with auto:alert incidents.
    expect(agent.body).toContain("auto:trend");
    expect(agent.body).toContain("<!-- fingerprint:trend-<slug> -->");
    // Output volume cap mirrors the other corpus-scanning agents.
    expect(agent.body).toContain("Maximum 3 new roll-up issues per run");
    // Must name a shared cause AND a systemic fix — counting alone is not a trend.
    expect(agent.body).toContain("named shared cause AND a systemic fix");
  });

  it("keeps pipeline-daily stage order and wiring for trend-analyst", () => {
    const workflow = loadYamlFile(PIPELINE_DAILY_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const pipeline = jobs["pipeline"] as YamlDocument;
    const steps = pipeline["steps"] as YamlDocument[];

    const userStageIndex = steps.findIndex((step) => step["id"] === "user_docs_manager");
    const trendStageIndex = steps.findIndex((step) => step["id"] === "trend_analyst");

    expect(userStageIndex).toBeGreaterThanOrEqual(0);
    expect(trendStageIndex).toBeGreaterThan(userStageIndex);

    const trendStage = steps[trendStageIndex];
    expect(trendStage["name"]).toBe("Stage — Trend Analyst");
    expect(trendStage["continue-on-error"]).toBe(true);
    expect(trendStage["working-directory"]).toBe(".github/tools/shared");
    expect(trendStage["run"]).toBe("npx tsx src/run-agent.ts --agent trend-analyst");

    const summaryStep = steps.find((step) => step["name"] === "Summarise — Trend Analyst");
    expect(summaryStep).toBeTruthy();
    expect(summaryStep?.["run"]).toContain("| trend-analyst |");
  });
});
