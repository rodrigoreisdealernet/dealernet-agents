import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgent } from "../agent-loader.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = join(resolve(TEST_DIR, "../../../../../"), ".github", "agents");

// The operating model / personas only earn their keep if the agents that PLAN work and JUDGE
// quality actually consume them. These lock that loop closed.
describe("operating model is consumed by the planning + quality + design agents", () => {
  it("Product Owner grounds prioritization in the operating model / personas", () => {
    const a = loadAgent(AGENTS_PATH, "product-owner");
    expect(a.body).toContain("Ground every decision in the operating model");
    expect(a.body).toContain("docs/discovery/domain");
    expect(a.body).toContain("high-pain, high-frequency");
    expect(a.body).toContain("agentic angle"); // factor automation leverage at triage
  });

  it("QA Manager grounds the quality bar in the persona's real job", () => {
    const a = loadAgent(AGENTS_PATH, "qa-manager");
    expect(a.body).toContain("Ground the bar in the persona");
    expect(a.body).toContain("docs/discovery/domain");
    expect(a.body).toContain('"what amazing would do for them"');
    expect(a.body).toContain("Degrade gracefully"); // soft lens while the map is thin
  });

  it("Factory Architect grounds the design in the operating model (alongside its agentic lens)", () => {
    const a = loadAgent(AGENTS_PATH, "factory-architect");
    expect(a.body).toContain("Ground the design in the operating model");
    expect(a.body).toContain("whose real job does this serve");
    // preserved: the agentic-angle lens added earlier must still be present
    expect(a.body).toContain("agentic-angle lens");
  });
});
