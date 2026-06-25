import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadAgent } from "../agent-loader.js";

type YamlDocument = Record<string, unknown>;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../../");
const AGENTS_PATH = join(REPO_ROOT, ".github", "agents");
const WEEKLY_PATH = join(REPO_ROOT, ".github", "workflows", "pipeline-weekly.yml");
const DOMAIN_README = join(REPO_ROOT, "docs", "discovery", "domain", "README.md");
const SEED = join(REPO_ROOT, "docs", "discovery", "domain", "equipment-rental-enterprise");
const PUBLISH = join(REPO_ROOT, "scripts", "operating-model-publish.sh");

describe("domain operating-model: framework + seed", () => {
  it("documents the north star, the reusable method, and the citation rule", () => {
    const r = readFileSync(DOMAIN_README, "utf8");
    expect(r).toContain('"What does it take to operate an X?"');
    expect(r).toContain("method is code; the vertical is data");
    expect(r).toContain("no citation, no task");
  });

  it("frames personas as the domain-expert collaboration surface", () => {
    const r = readFileSync(DOMAIN_README, "utf8");
    expect(r).toContain("collaboration surface");
    expect(r).toContain("Frustrations are where agentic opportunities are born");
    expect(r).toContain("Domain-expert review");
  });

  it("seeds the enterprise-rental vertical (config + capability map)", () => {
    expect(existsSync(join(SEED, "_meta.yml"))).toBe(true);
    expect(existsSync(join(SEED, "operating-model.md"))).toBe(true);
    expect(readFileSync(join(SEED, "operating-model.md"), "utf8")).toContain("## Capability areas");
  });
});

describe("domain-cartographer: maps real work, never bypasses to build", () => {
  it("has the cartographer prompt contract", () => {
    const a = loadAgent(AGENTS_PATH, "domain-cartographer");
    expect(a.frontmatter.name).toBe("domain-cartographer");
    expect(a.frontmatter.tools).toEqual(["gh"]);
    expect(a.body).toContain("no citation, no task");
    expect(a.body).toContain("never open a build ticket"); // feeds discovery, no work orders
    expect(a.body).toContain("Coverage first, then refine, never churn"); // breadth-first coverage
    expect(a.body).toContain("do NOT rewrite a role that's good enough"); // refinement restraint, no churn
    expect(a.body).toContain("Keep discovering every run"); // continuous online discovery
    expect(a.body).toContain("Map the FULL stakeholder spectrum"); // all user tiers, not just operators
    expect(a.body).toContain("External end customers"); // the most-missed tier (portal/mobile)
    expect(a.body).toContain("Build the persona, not just a task list"); // personas, not bare tasks
    expect(a.body).toContain("Frustrations & motivations are first-class");
  });
});

describe("pipeline-weekly wiring (cartographer + operating-model publish)", () => {
  it("runs the cartographer then the deterministic publish, after the charter stages", () => {
    const raw = readFileSync(WEEKLY_PATH, "utf8");
    const workflow = yaml.load(raw) as YamlDocument;
    const steps = ((workflow["jobs"] as YamlDocument)["pipeline"] as YamlDocument)["steps"] as YamlDocument[];
    const idx = (id: string) => steps.findIndex((s) => s["id"] === id);

    const charter = idx("charter_publish");
    const carto = idx("domain_cartographer");
    const publish = idx("operating_model_publish");

    expect(carto).toBeGreaterThan(charter);
    expect(publish).toBeGreaterThan(carto);

    expect(steps[carto]!["run"]).toBe("npx tsx src/run-agent.ts --agent domain-cartographer");
    expect(steps[publish]!["run"]).toBe("bash scripts/operating-model-publish.sh");
    expect(steps[publish]!["if"]).toBe("always()");

    expect(readFileSync(PUBLISH, "utf8")).toContain("operating-model/weekly-");
  });

  it("wires the ticket bridge (epics) + feedback loop (reconcile), in order", () => {
    const workflow = yaml.load(readFileSync(WEEKLY_PATH, "utf8")) as YamlDocument;
    const steps = ((workflow["jobs"] as YamlDocument)["pipeline"] as YamlDocument)["steps"] as YamlDocument[];
    const idx = (id: string) => steps.findIndex((s) => s["id"] === id);

    const carto = idx("domain_cartographer");
    const reconcile = idx("operating_model_reconcile");
    const publish = idx("operating_model_publish");
    const epics = idx("operating_model_epics");

    // cartographer → reconcile → publish → epics
    expect(reconcile).toBeGreaterThan(carto);
    expect(publish).toBeGreaterThan(reconcile);
    expect(epics).toBeGreaterThan(publish);

    expect(steps[reconcile]!["run"]).toBe("bash scripts/operating-model-reconcile.sh equipment-rental-enterprise");
    expect(steps[epics]!["run"]).toBe("bash scripts/operating-model-epics.sh equipment-rental-enterprise");

    // epic bridge files into the product queue, NOT ready-for-dev (humans gate the build)
    const epicsScript = readFileSync(join(REPO_ROOT, "scripts", "operating-model-epics.sh"), "utf8");
    expect(epicsScript).toContain("queue:product,needs-triage");
    expect(epicsScript).not.toMatch(/--label[^"]*ready-for-dev/); // no --label carries ready-for-dev
    expect(epicsScript).toContain("&lt;task-id&gt;"); // preserve placeholder in rendered issue body
  });
});
