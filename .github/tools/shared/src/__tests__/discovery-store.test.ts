import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newIdea,
  addEvidence,
  evidenceCount,
  meetsBar,
  setRung,
  setField,
  touch,
  list,
  readDossier,
  RUNGS,
} from "../discovery-store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "discovery-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discovery-store: dossier lifecycle", () => {
  it("creates a dossier at the signal rung with template body", () => {
    const d = newIdea("nl-reporting", "Natural-language reporting", {}, root);
    expect(d.frontmatter.rung).toBe("signal");
    expect(d.frontmatter.evidence_count).toBe(0);
    expect(d.frontmatter.agentic_potential).toBe("unassessed");
    expect(d.body).toContain("## Agentic angle");
    expect(existsSync(join(root, "ideas", "nl-reporting.md"))).toBe(true);
    expect(d.body).toContain("## Decision log");
    expect(d.body).toContain("## Differentiation (vs Renterra / RentalMan)");
  });

  it("rejects bad slugs and duplicates", () => {
    expect(() => newIdea("Bad Slug", "x", {}, root)).toThrow(/Invalid slug/);
    newIdea("dup", "x", {}, root);
    expect(() => newIdea("dup", "x", {}, root)).toThrow(/already exists/);
  });

  it("RUNGS are the canonical five in order", () => {
    expect(RUNGS).toEqual(["signal", "opportunity", "idea", "validated", "ready"]);
  });
});

describe("discovery-store: evidence integrity (no citation, no evidence)", () => {
  beforeEach(() => newIdea("x", "X", {}, root));

  it("requires a real URL and a substantive excerpt", () => {
    expect(() => addEvidence("x", "competitor", "not-a-url", "a long enough excerpt here", "scout", root)).toThrow(
      /real source URL/
    );
    expect(() => addEvidence("x", "competitor", "https://e.com", "short", "scout", root)).toThrow(/verbatim excerpt/);
    expect(() => addEvidence("x", "bogus", "https://e.com", "a long enough excerpt here", "scout", root)).toThrow(
      /Invalid kind/
    );
  });

  it("appends evidence and bumps evidence_count in frontmatter", () => {
    addEvidence("x", "competitor", "https://getrenterra.com", "Renterra ships NL reporting in their suite", "scout", root);
    addEvidence("x", "review", "https://g2.com/x", "Users complain reporting is manual and slow", "scout", root);
    expect(evidenceCount("x", root)).toBe(2);
    expect(readDossier("x", root).frontmatter.evidence_count).toBe(2);
    const jsonl = readFileSync(join(root, "evidence", "x", "evidence.jsonl"), "utf8").trim().split("\n");
    expect(jsonl).toHaveLength(2);
    expect(JSON.parse(jsonl[0]!).source_url).toBe("https://getrenterra.com");
    expect(JSON.parse(jsonl[0]!).retrieved_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("discovery-store: rung bars are enforced in code", () => {
  beforeEach(() => newIdea("x", "X", {}, root));

  it("blocks opportunity until >=2 evidence records", () => {
    expect(meetsBar("x", "opportunity", root).ok).toBe(false);
    addEvidence("x", "news", "https://a.com", "evidence one is here now", "scout", root);
    expect(meetsBar("x", "opportunity", root).ok).toBe(false);
    addEvidence("x", "news", "https://b.com", "evidence two is here now", "scout", root);
    expect(meetsBar("x", "opportunity", root).ok).toBe(true);
  });

  it("set-rung refuses an unmet bar and returns reasons", () => {
    const res = setRung("x", "opportunity", {}, root);
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/evidence/);
    expect(readDossier("x", root).frontmatter.rung).toBe("signal");
  });

  it("cannot skip rungs", () => {
    addEvidence("x", "news", "https://a.com", "evidence one is here now", "scout", root);
    addEvidence("x", "news", "https://b.com", "evidence two is here now", "scout", root);
    addEvidence("x", "news", "https://c.com", "evidence three is here now", "scout", root);
    setField("x", "score.rice", "42", root);
    expect(meetsBar("x", "validated", root).reasons.join(" ")).toMatch(/skip rungs/);
  });

  it("validated needs >=3 evidence AND a RICE score; ready needs validated", () => {
    for (const u of ["a", "b", "c"]) addEvidence("x", "market", `https://${u}.com`, "evidence excerpt long enough", "scout", root);
    setField("x", "differentiator", "Beats Renterra by doing it natively in-workflow", root);
    expect(setRung("x", "opportunity", {}, root).ok).toBe(true);
    expect(setRung("x", "idea", {}, root).ok).toBe(true);
    expect(setRung("x", "validated", {}, root).ok).toBe(false); // no RICE yet
    setField("x", "score.rice", "30", root);
    expect(setRung("x", "validated", { by: "product-strategist" }, root).ok).toBe(true);
    expect(setRung("x", "ready", { by: "discovery-critic" }, root).ok).toBe(true);
    expect(readDossier("x", root).frontmatter.rung).toBe("ready");
  });

  it("--force overrides the bar but records it in the decision log", () => {
    const res = setRung("x", "opportunity", { by: "human", force: true, why: "manual override" }, root);
    expect(res.ok).toBe(true);
    const d = readDossier("x", root);
    expect(d.frontmatter.rung).toBe("opportunity");
    expect(d.body).toContain("FORCED");
  });
});

describe("discovery-store: set-field, touch, list", () => {
  it("set-field coerces types and supports dotted keys", () => {
    newIdea("x", "X", {}, root);
    setField("x", "score.reach", "1000", root);
    setField("x", "linked_issue", "777", root);
    const fm = readDossier("x", root).frontmatter;
    expect(fm.score.reach).toBe(1000);
    expect(fm.linked_issue).toBe(777);
  });

  it("list filters by rung and can sort stale-first", () => {
    newIdea("a", "A", {}, root);
    newIdea("b", "B", {}, root);
    setField("a", "last_reviewed", "2026-01-01", root);
    setField("b", "last_reviewed", "2026-06-01", root);
    touch("b", root);
    const stale = list({ staleFirst: true }, root);
    expect(stale[0]!.slug).toBe("a");
    expect(list({ rung: "signal" }, root)).toHaveLength(2);
    expect(list({ rung: "ready" }, root)).toHaveLength(0);
  });
});
