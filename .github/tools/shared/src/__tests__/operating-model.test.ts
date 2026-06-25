import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newVertical,
  newRole,
  addTask,
  addEvidence,
  coverage,
  listRoles,
  render,
  renderModel,
  readMeta,
  parseRange,
  setImpl,
  CADENCES,
} from "../operating-model.js";

let root: string;
const V = "equipment-rental-enterprise";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "domain-"));
  newVertical(V, "Enterprise rental", "multi-branch + contractor", "What does it take to run an X?", {}, root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("operating-model: vertical + role scaffolding", () => {
  it("creates a vertical with meta + operating-model.md", () => {
    expect(existsSync(join(root, V, "_meta.yml"))).toBe(true);
    expect(existsSync(join(root, V, "operating-model.md"))).toBe(true);
    expect(() => newVertical(V, "x", "y", "z", {}, root)).toThrow(/already exists/);
  });

  it("creates roles and lists them (skipping TEMPLATE)", () => {
    newRole(V, "branch-operations-manager", "Branch Operations Manager", ["branch-ops"], root);
    expect(existsSync(join(root, V, "roles", "branch-operations-manager.md"))).toBe(true);
    expect(listRoles(V, root)).toEqual(["branch-operations-manager"]);
    expect(() => newRole(V, "Bad Slug", "x", [], root)).toThrow(/Invalid role slug/);
  });

  it("scaffolds a RICH PERSONA (the SME collaboration surface), not just a task list", () => {
    newRole(V, "yard-coordinator", "Yard Coordinator", [], root);
    const md = readFileSync(join(root, V, "roles", "yard-coordinator.md"), "utf8");
    for (const section of [
      "## Goals & motivations",
      "## Frustrations & pains",
      "## A day / week in the life",
      "## Decisions they own",
      "## Domain-expert review",
    ]) {
      expect(md).toContain(section);
    }
  });
});

describe("operating-model: no citation, no task", () => {
  beforeEach(() => newRole(V, "yard-coordinator", "Yard Coordinator", [], root));

  it("rejects a task with no evidence ref", () => {
    expect(() => addTask(V, "yard-coordinator", { task: "Stage equipment for dispatch", cadence: "daily" }, root)).toThrow(
      /no citation, no task/
    );
  });

  it("rejects a non-URL evidence ref and bad cadence/agentic", () => {
    expect(() =>
      addTask(V, "yard-coordinator", { task: "x task", cadence: "daily", evidence_refs: ["not-a-url"] }, root)
    ).toThrow(/must be a URL/);
    expect(() =>
      addTask(V, "yard-coordinator", { task: "x task", cadence: "fortnightly" as never, evidence_refs: ["https://e.com"] }, root)
    ).toThrow(/Invalid cadence/);
  });

  it("add-evidence requires a real URL + substantive excerpt + valid kind", () => {
    expect(() => addEvidence(V, "yard-coordinator", "industry", "nope", "a long enough excerpt", root)).toThrow(/real source URL/);
    expect(() => addEvidence(V, "yard-coordinator", "industry", "https://e.com", "short", root)).toThrow(/verbatim excerpt/);
    expect(() => addEvidence(V, "yard-coordinator", "bogus", "https://e.com", "a long enough excerpt", root)).toThrow(/Invalid kind/);
  });
});

describe("operating-model: tasks, render, coverage", () => {
  beforeEach(() => {
    newRole(V, "yard-coordinator", "Yard Coordinator", ["logistics"], root);
    addTask(
      V,
      "yard-coordinator",
      {
        task: "Stage equipment for next-day dispatch",
        cadence: "daily",
        pain: "high",
        tool_today: "whiteboard",
        agentic_potential: "assist",
        capability: "logistics",
        evidence_refs: ["https://example.com/yard-coordinator-jd"],
      },
      root
    );
    addTask(
      V,
      "yard-coordinator",
      {
        task: "Reconcile physical yard count vs system",
        cadence: "weekly",
        agentic_potential: "automate",
        capability: "fleet",
        evidence_refs: ["https://example.com/yard-ops"],
      },
      root
    );
  });

  it("renders a markdown task table between the markers", () => {
    const md = readFileSync(join(root, V, "roles", "yard-coordinator.md"), "utf8");
    expect(md).toContain("| Task | Cadence |");
    expect(md).toContain("Stage equipment for next-day dispatch");
    expect(md).toContain("`assist`");
  });

  it("coverage counts tasks by cadence + agentic and computes assessed %", () => {
    const c = coverage(V, root);
    expect(c.roles).toBe(1);
    expect(c.tasks).toBe(2);
    expect(c.byCadence).toEqual({ daily: 1, weekly: 1 });
    expect(c.byAgentic).toEqual({ assist: 1, automate: 1 });
    expect(c.agenticAssessedPct).toBe(100); // both assessed (not "unassessed")
    expect(c.tasksMissingEvidence).toBe(0);
  });

  it("unassessed tasks lower the assessed %", () => {
    addTask(
      V,
      "yard-coordinator",
      { task: "File incident reports", cadence: "adhoc", evidence_refs: ["https://example.com/safety"] },
      root
    );
    const c = coverage(V, root);
    expect(c.tasks).toBe(3);
    expect(c.agenticAssessedPct).toBe(67); // 2 of 3 assessed
  });

  it("CADENCES are the canonical five", () => {
    expect(CADENCES).toEqual(["daily", "weekly", "monthly", "yearly", "adhoc"]);
  });

  it("set-impl advances a task's implementation (the feedback loop) and re-renders", () => {
    newRole(V, "ops", "Ops", [], root);
    addTask(V, "ops", { task: "Ship it", cadence: "weekly", evidence_refs: ["https://e.com/x"] }, root);
    const before = coverage(V, root);
    setImpl(V, "ops", "t1", "supported", root);
    const after = coverage(V, root);
    expect(after.byImplementation.supported).toBe(1);
    expect(after.implementedPct).toBeGreaterThan(before.implementedPct);
    expect(() => setImpl(V, "ops", "nope", "supported", root)).toThrow(/no task/);
  });
});

describe("operating-model: ROI as calibrated 90% CI ranges (Hubbard)", () => {
  it("parseRange handles 'low-high' and a single point", () => {
    expect(parseRange("30-60")).toEqual({ low: 30, high: 60 });
    expect(parseRange("45")).toEqual({ low: 45, high: 45 });
    expect(parseRange(undefined)).toBeNull();
    expect(() => parseRange("abc")).toThrow(/bad range/);
  });

  it("new-vertical carries the rate + FTE assumptions", () => {
    const meta = readMeta(V, root);
    expect(meta.hours_per_fte_year).toBe(1800);
    const root2 = mkdtempSync(join(tmpdir(), "domain2-"));
    newVertical("v2", "V2", "seg", "ns", { defaultRate: { low: 40, high: 60 }, hoursPerFteYear: 2000 }, root2);
    expect(readMeta("v2", root2).default_loaded_hourly_rate).toEqual({ low: 40, high: 60 });
    expect(readMeta("v2", root2).hours_per_fte_year).toBe(2000);
    rmSync(root2, { recursive: true, force: true });
  });

  it("rolls captured labor into a $ range + FTE-equivalent for automated tasks only", () => {
    newRole(V, "yard-coordinator", "Yard Coordinator", [], root);
    // automated, fully modelled: 60 min × 250/yr × $50/hr × 80% capture = $10,000/yr (point ranges)
    addTask(
      V,
      "yard-coordinator",
      {
        task: "Reconcile yard count vs system",
        cadence: "daily",
        implementation: "automated",
        agentic_potential: "automate",
        evidence_refs: ["https://example.com/yard"],
        value: {
          minutes_per_occurrence: { low: 60, high: 60 },
          occurrences_per_year: { low: 250, high: 250 },
          loaded_hourly_rate: { low: 50, high: 50 },
          automation_capture_pct: { low: 0.8, high: 0.8 },
        },
      },
      root
    );
    // supported (not automated) → counts as implemented, but banks NO captured $
    addTask(
      V,
      "yard-coordinator",
      {
        task: "Log a delivery",
        cadence: "daily",
        implementation: "supported",
        evidence_refs: ["https://example.com/deliv"],
        value: {
          minutes_per_occurrence: { low: 10, high: 10 },
          occurrences_per_year: { low: 250, high: 250 },
          loaded_hourly_rate: { low: 50, high: 50 },
          automation_capture_pct: null,
        },
      },
      root
    );

    const c = coverage(V, root);
    expect(c.byImplementation).toEqual({ automated: 1, supported: 1 });
    expect(c.implementedPct).toBe(100); // both supported/automated
    expect(c.roi.modelledTasks).toBe(2);
    // Captured TODAY = automated task only: 60min×250/60 × 0.8 = 200 hrs → $10k
    expect(c.roi.annualHoursCaptured).toEqual({ low: 200, high: 200 });
    expect(c.roi.annualCostCaptured).toEqual({ low: 10000, high: 10000 });
    expect(c.roi.fteEquivalent.low).toBeCloseTo(200 / 1800, 4);
    // Addressable (the prize) = annual labor on the agentic candidate (the automate task): $12,500
    expect(c.roi.addressableCost).toEqual({ low: 12500, high: 12500 });
    // Capturable = addressable × capture (0.8) = $10,000 (the supported task is unassessed → excluded)
    expect(c.roi.capturableCost).toEqual({ low: 10000, high: 10000 });
  });

  it("addressable counts assist+automate candidates even when NOT yet built (the prize > $0)", () => {
    newRole(V, "ops", "Ops", [], root);
    addTask(
      V,
      "ops",
      {
        task: "Investigate and propose idle-fleet rebalancing across branches",
        cadence: "weekly",
        implementation: "none", // not built yet → captured = $0
        agentic_potential: "assist",
        evidence_refs: ["https://example.com/rebalance"],
        value: {
          minutes_per_occurrence: { low: 60, high: 120 },
          occurrences_per_year: { low: 48, high: 52 },
          loaded_hourly_rate: { low: 40, high: 60 },
          automation_capture_pct: { low: 0.4, high: 0.7 },
        },
      },
      root
    );
    const c = coverage(V, root);
    expect(c.roi.annualCostCaptured).toEqual({ low: 0, high: 0 }); // nothing automated/built yet
    expect(c.roi.addressableCost.low).toBeGreaterThan(0); // but the prize is real today
    expect(c.roi.capturableCost.low).toBeGreaterThan(0);
  });

  it("render-model writes a shareable Coverage & ROI block INTO the doc", () => {
    newRole(V, "yard-coordinator", "Yard Coordinator", [], root);
    addTask(
      V,
      "yard-coordinator",
      {
        task: "Reconcile yard count",
        cadence: "weekly",
        implementation: "automated",
        agentic_potential: "automate",
        evidence_refs: ["https://example.com/yard"],
        value: {
          minutes_per_occurrence: { low: 30, high: 90 },
          occurrences_per_year: { low: 48, high: 52 },
          loaded_hourly_rate: { low: 40, high: 60 },
          automation_capture_pct: { low: 0.6, high: 0.9 },
        },
      },
      root
    );
    renderModel(V, root);
    const doc = readFileSync(join(root, V, "operating-model.md"), "utf8");
    expect(doc).toContain("Roadmap coverage:");
    expect(doc).toContain("Addressable opportunity"); // the prize
    expect(doc).toContain("Capturable");
    expect(doc).toContain("Captured today");
    expect(doc).toContain("90% confidence intervals");
    expect(doc).toMatch(/\$[\d,]+–\$[\d,]+\/yr/); // a $ range, not a fake-precise point
  });
});
