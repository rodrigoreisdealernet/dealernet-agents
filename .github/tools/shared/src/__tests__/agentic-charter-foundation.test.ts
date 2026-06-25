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
const CHARTER_PATH = join(REPO_ROOT, "docs", "agentic-charter.md");
const WEEKLY_PATH = join(REPO_ROOT, ".github", "workflows", "pipeline-weekly.yml");
const PUBLISH_PATH = join(REPO_ROOT, "scripts", "agentic-charter-publish.sh");

describe("agentic charter: the living definition", () => {
  it("states the floor, the loop, the lens and anti-patterns", () => {
    const c = readFileSync(CHARTER_PATH, "utf8");
    expect(c).toContain("agents propose; humans dispose");
    expect(c).toContain("load-config → scope → investigate → gate → human-approve → write → audit");
    expect(c).toContain("agentic-angle lens");
    expect(c).toContain("Anti-patterns");
    expect(c).toContain("How this charter evolves");
  });
});

describe("agentic-reflector: proposes, never disposes", () => {
  it("has the reflector prompt contract", () => {
    const a = loadAgent(AGENTS_PATH, "agentic-reflector");
    expect(a.frontmatter.name).toBe("agentic-reflector");
    expect(a.frontmatter.tools).toEqual(["gh"]);
    expect(a.body).toContain("Propose, never apply");
    expect(a.body).toContain("Cite or cut");
    expect(a.body).toContain("Never lower"); // the floor is sacred
  });
});

describe("agentic-angle lens is injected into ticket design", () => {
  it("factory-architect requires an agentic angle in every design", () => {
    const a = loadAgent(AGENTS_PATH, "factory-architect");
    expect(a.body).toContain("agentic-angle lens");
    expect(a.body).toContain("Agentic angle");
  });

  it("product-strategist assesses the agentic angle and classifies potential", () => {
    const a = loadAgent(AGENTS_PATH, "product-strategist");
    expect(a.body).toContain("Assess the agentic angle");
    expect(a.body).toContain("agentic_potential");
  });
});

describe("pipeline-weekly wiring", () => {
  it("runs the reflector then the deterministic charter publish, weekly", () => {
    const raw = readFileSync(WEEKLY_PATH, "utf8");
    expect(raw).toContain("cron: '0 7 * * *'"); // TEMP daily (bootstrap); revert to '0 7 * * 0' weekly

    const workflow = yaml.load(raw) as YamlDocument;
    const steps = ((workflow["jobs"] as YamlDocument)["pipeline"] as YamlDocument)["steps"] as YamlDocument[];
    const idx = (id: string) => steps.findIndex((s) => s["id"] === id);

    const reflector = idx("agentic_reflector");
    const publish = idx("charter_publish");
    expect(reflector).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(reflector);

    expect(steps[reflector]!["run"]).toBe("npx tsx src/run-agent.ts --agent agentic-reflector");
    expect(steps[publish]!["run"]).toBe("bash scripts/agentic-charter-publish.sh");
    expect(steps[publish]!["if"]).toBe("always()");

    expect(readFileSync(PUBLISH_PATH, "utf8")).toContain("agentic-charter/weekly-");
  });
});
