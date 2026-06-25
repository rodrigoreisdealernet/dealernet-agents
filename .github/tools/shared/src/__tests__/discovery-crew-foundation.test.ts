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
const README_PATH = join(REPO_ROOT, "docs", "discovery", "README.md");
const PUBLISH_PATH = join(REPO_ROOT, "scripts", "discovery-publish.sh");

function loadYamlFile(path: string): YamlDocument {
  const parsed = yaml.load(readFileSync(path, "utf8"));
  expect(parsed).toBeTruthy();
  return parsed as YamlDocument;
}

describe("discovery crew: agent prompt contracts", () => {
  it("market-scout gathers cited signal and stays out of downstream lanes", () => {
    const a = loadAgent(AGENTS_PATH, "market-scout");
    expect(a.frontmatter.name).toBe("market-scout");
    expect(a.frontmatter.tools).toEqual(["gh"]);
    expect(a.body).toContain("no citation, no evidence");
    expect(a.body).toContain("3 new dossiers"); // per-night cap
    expect(a.body).toContain("never set a rung above `signal`");
  });

  it("product-strategist advances one rung at a time and never reaches ready", () => {
    const a = loadAgent(AGENTS_PATH, "product-strategist");
    expect(a.frontmatter.name).toBe("product-strategist");
    expect(a.frontmatter.tools).toEqual(["gh"]);
    expect(a.body).toContain("at most 3 rung promotions per run");
    expect(a.body).toContain("Never promote to `ready`");
    expect(a.body).toContain("Never create build tickets");
  });

  it("discovery-critic is the sole gate to ready and keeps the build gate human", () => {
    const a = loadAgent(AGENTS_PATH, "discovery-critic");
    expect(a.frontmatter.name).toBe("discovery-critic");
    expect(a.frontmatter.tools).toEqual(["gh"]);
    expect(a.body).toContain("only** actor that promotes `validated → ready`");
    expect(a.body).toContain("discovery:ready");
    expect(a.body).toContain("go/no-go");
    expect(a.body).toContain("Citations resolve"); // adversarial verification
  });

  it("the discovery store and approval chain are documented", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("idea-maturity ladder");
    expect(readme).toContain("no citation, no evidence");
    const publish = readFileSync(PUBLISH_PATH, "utf8");
    expect(publish).toContain("discovery/nightly-");
  });
});

describe("discovery crew: pipeline-daily wiring", () => {
  it("runs scout → strategist → critic → publish, after trend-analyst", () => {
    const workflow = loadYamlFile(PIPELINE_DAILY_PATH);
    const steps = ((workflow["jobs"] as YamlDocument)["pipeline"] as YamlDocument)["steps"] as YamlDocument[];
    const idx = (id: string) => steps.findIndex((s) => s["id"] === id);

    const trend = idx("trend_analyst");
    const scout = idx("market_scout");
    const strategist = idx("product_strategist");
    const critic = idx("discovery_critic");
    const publish = idx("discovery_publish");

    expect(trend).toBeGreaterThanOrEqual(0);
    expect(scout).toBeGreaterThan(trend);
    expect(strategist).toBeGreaterThan(scout);
    expect(critic).toBeGreaterThan(strategist);
    expect(publish).toBeGreaterThan(critic);

    expect(steps[scout]!["run"]).toBe("npx tsx src/run-agent.ts --agent market-scout");
    expect(steps[strategist]!["run"]).toBe("npx tsx src/run-agent.ts --agent product-strategist");
    expect(steps[critic]!["run"]).toBe("npx tsx src/run-agent.ts --agent discovery-critic");

    // The publish step is deterministic (not an agent) and always runs to capture output.
    expect(steps[publish]!["run"]).toBe("bash scripts/discovery-publish.sh");
    expect(steps[publish]!["if"]).toBe("always()");
  });
});
