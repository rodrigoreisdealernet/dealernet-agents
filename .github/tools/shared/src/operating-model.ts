#!/usr/bin/env node
/**
 * operating-model.ts — deterministic helper for the DOMAIN OPERATING-MODEL store
 * (`docs/discovery/domain/`). This is the north-star layer that sits ABOVE the discovery
 * dossiers: it answers "what does it take to operate an X?" by decomposing a vertical into
 * roles → real tasks (with cadence) → the capability each needs and its agentic potential.
 *
 * The framework is VERTICAL-PARAMETERIZED: the method (schema, evidence rules, coverage) is
 * code; the vertical ("equipment-rental-enterprise", "uk-pub", …) is data. Run the same
 * machinery for any industry — that is the reusability bet.
 *
 * Two disciplines enforced here in code (not just prompts):
 *   1. No citation, no task — every task must carry >=1 evidence ref, and add-evidence
 *      rejects records without a real URL + a substantive excerpt. A hallucinated operating
 *      model is worse than none.
 *   2. Coverage is measurable — `coverage` reports roles, tasks by cadence, and the % of
 *      tasks that have had their agentic potential assessed, so we can see the gaps.
 *
 * Layout:
 *   docs/discovery/domain/<vertical>/_meta.yml                 — vertical config
 *   docs/discovery/domain/<vertical>/operating-model.md        — the capability map (human)
 *   docs/discovery/domain/<vertical>/roles/<role>.md           — role narrative + rendered table
 *   docs/discovery/domain/<vertical>/roles/<role>.tasks.jsonl  — structured task records (truth)
 *   docs/discovery/domain/<vertical>/evidence/<role>/evidence.jsonl — cited evidence log
 *
 * Path resolution: DOMAIN_ROOT env wins (tests); else repo-root/docs/discovery/domain.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

export const CADENCES = ["daily", "weekly", "monthly", "yearly", "adhoc"] as const;
export type Cadence = (typeof CADENCES)[number];

export const AGENTIC = ["unassessed", "none", "assist", "automate"] as const;
export type AgenticPotential = (typeof AGENTIC)[number];

export const IMPLEMENTATION = ["none", "partial", "supported", "automated"] as const;
export type Implementation = (typeof IMPLEMENTATION)[number];

export const EVIDENCE_KINDS = ["role-posting", "industry", "sme-interview", "competitor", "regulatory", "our-users"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * A 90% confidence interval (Hubbard, "How to Measure Anything"): a calibrated estimate is a
 * RANGE you'd bet you're 90% sure contains the true value — not a fake-precise point. ROI is
 * rolled up from these ranges via Monte Carlo, so the output is an honest interval with an
 * expected value, never an invented single number. A wide range is fine — it says "here's how
 * little we know," and even a few real data points (the rule of five) tighten it fast.
 */
export interface Range {
  low: number;
  high: number;
}

export interface TaskValue {
  minutes_per_occurrence: Range | null;
  occurrences_per_year: Range | null; // null → derived from cadence
  loaded_hourly_rate: Range | null; // null → vertical default
  automation_capture_pct: Range | null; // 0..1 — fraction of this task's labor the system removes
}

export interface TaskRecord {
  id: string;
  task: string;
  cadence: Cadence;
  frequency: string;
  pain: string;
  tool_today: string;
  decision_content: string;
  agentic_potential: AgenticPotential;
  implementation: Implementation;
  capability: string;
  value: TaskValue;
  evidence_refs: string[];
}

export interface VerticalMeta {
  slug: string;
  name: string;
  segment: string;
  north_star: string;
  default_loaded_hourly_rate: Range | null; // ASSUMPTION — set per vertical; validate with SMEs
  hours_per_fte_year: number; // for FTE-equivalent rollups
  created: string;
}

export interface RoiRollup {
  modelledTasks: number; // tasks with enough inputs to estimate
  valueModelCoveragePct: number; // % of all tasks that are modelled (the honest denominator)
  // THE PRIZE — annual labor on tasks that are agentic candidates (assist|automate), 90% CI.
  addressableCost: Range;
  addressableHours: Range;
  // ACHIEVABLE — addressable × per-task capture estimate (where given), 90% CI.
  capturableCost: Range;
  capturableHours: Range;
  capturableFte: Range; // capturableHours / hours_per_fte_year
  // REALIZED TODAY — captured by tasks already `automated` in the product, 90% CI.
  annualHoursCaptured: Range;
  annualCostCaptured: Range;
  fteEquivalent: Range; // annualHoursCaptured / hours_per_fte_year
}

export interface Coverage {
  vertical: string;
  roles: number;
  tasks: number;
  byCadence: Record<string, number>;
  byAgentic: Record<string, number>;
  byImplementation: Record<string, number>;
  agenticAssessedPct: number;
  implementedPct: number; // raw: (supported + automated) / tasks
  implementedPctValueWeighted: number; // weighted by expected annual labor cost
  tasksMissingEvidence: number;
  roi: RoiRollup;
}

// Default occurrences/year as a 90% CI by cadence (working-time, not calendar).
const CADENCE_OCCURRENCES: Record<Cadence, Range | null> = {
  daily: { low: 200, high: 260 },
  weekly: { low: 40, high: 52 },
  monthly: { low: 10, high: 12 },
  yearly: { low: 1, high: 4 },
  adhoc: null,
};

const rangeMid = (r: Range): number => (r.low + r.high) / 2;
const rangeMul = (a: Range, b: Range): Range => ({ low: a.low * b.low, high: a.high * b.high });
const rangeScale = (r: Range, k: number): Range => ({ low: r.low / k, high: r.high / k });
const rangeAdd = (a: Range, b: Range): Range => ({ low: a.low + b.low, high: a.high + b.high });
const ZERO: Range = { low: 0, high: 0 };

// ── paths ──────────────────────────────────────────────────────────────────────

export function domainRoot(): string {
  const env = process.env.DOMAIN_ROOT;
  if (env) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(resolve(here, "../../../.."), "docs", "discovery", "domain");
}
const vDir = (v: string, root = domainRoot()) => join(root, v);
const rolesDir = (v: string, root = domainRoot()) => join(vDir(v, root), "roles");
const roleMd = (v: string, role: string, root = domainRoot()) => join(rolesDir(v, root), `${role}.md`);
const roleTasks = (v: string, role: string, root = domainRoot()) => join(rolesDir(v, root), `${role}.tasks.jsonl`);
const evidenceFile = (v: string, role: string, root = domainRoot()) =>
  join(vDir(v, root), "evidence", role, "evidence.jsonl");
const metaFile = (v: string, root = domainRoot()) => join(vDir(v, root), "_meta.yml");

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

// ── operations ───────────────────────────────────────────────────────────────

export function newVertical(
  slug: string,
  name: string,
  segment: string,
  northStar: string,
  opts: { defaultRate?: Range | null; hoursPerFteYear?: number } = {},
  root = domainRoot()
): VerticalMeta {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid vertical slug '${slug}' (kebab-case)`);
  if (existsSync(metaFile(slug, root))) throw new Error(`Vertical '${slug}' already exists`);
  mkdirSync(rolesDir(slug, root), { recursive: true });
  const meta: VerticalMeta = {
    slug,
    name,
    segment,
    north_star: northStar,
    default_loaded_hourly_rate: opts.defaultRate ?? null, // ASSUMPTION — validate with SMEs
    hours_per_fte_year: opts.hoursPerFteYear ?? 1800,
    created: today(),
  };
  writeFileSync(metaFile(slug, root), yaml.dump(meta));
  writeFileSync(
    join(vDir(slug, root), "operating-model.md"),
    [
      `# Operating model — ${name}`,
      "",
      `> **North star:** ${northStar}`,
      `> **Segment:** ${segment}`,
      "",
      "The capability map for this vertical: what it takes to operate the business, decomposed",
      "into capability areas → roles → real tasks. Roles live in [`roles/`](./roles/); coverage is",
      "reported by `operating-model.ts coverage`. Every task must cite evidence.",
      "",
      "## Coverage & ROI",
      "<!-- COVERAGE:BEGIN (generated by `operating-model.ts render-model` — do not hand-edit) -->",
      "_Not yet computed. Run `operating-model.ts render-model " + slug + "`._",
      "<!-- COVERAGE:END -->",
      "",
      "## Capability areas",
      "_The major functional areas of the business. Each maps to one or more roles._",
      "",
      "## Roles",
      "_Maintained as the cartographer adds them. See `roles/`._",
      "",
    ].join("\n")
  );
  return meta;
}

export function newRole(
  vertical: string,
  role: string,
  title: string,
  capabilityAreas: string[] = [],
  root = domainRoot()
): void {
  if (!existsSync(metaFile(vertical, root))) throw new Error(`No vertical '${vertical}' — create it first`);
  if (!SLUG_RE.test(role)) throw new Error(`Invalid role slug '${role}' (kebab-case)`);
  if (existsSync(roleMd(vertical, role, root))) throw new Error(`Role '${role}' already exists`);
  mkdirSync(rolesDir(vertical, root), { recursive: true });
  const fm = {
    role,
    title,
    vertical,
    capability_areas: capabilityAreas,
    created: today(),
    last_reviewed: today(),
  };
  writeFileSync(
    roleMd(vertical, role, root),
    [
      `---`,
      yaml.dump(fm).trimEnd(),
      `---`,
      "",
      `# ${title}`,
      "",
      "> **Persona dossier — a living, SME-refinable view of this role.** The task inventory is",
      "> built from cited evidence; the qualitative layer (goals, motivations, frustrations) is a",
      "> draft *for domain experts to validate, correct, and scope* in the Domain-expert review",
      "> section below. The persona is the point — it is only as good as the experts who refine it.",
      "",
      "## Identity & context",
      "_Where they sit (branch / regional / HQ), team size, who they report to, the scale they",
      "operate at (enterprise multi-branch + contractor/project)._",
      "",
      "## Goals & motivations",
      "_What they're trying to achieve and why it matters to them — the outcomes they're measured",
      "on (utilization, on-time delivery, branch P&L, DSO…). The 'why' behind the tasks._",
      "",
      "## A day / week in the life",
      "_The rhythm of the role — how the cadence of the tasks below actually feels._",
      "",
      "## Frustrations & pains",
      "_Where time, judgment, and stress concentrate today; the 'if only' moments. Cite where you",
      "can — review sites and SME interviews voice these directly. This is where agentic",
      "opportunities are born: a frustration is an un-served job._",
      "",
      "## Tools today",
      "_The systems they live in — and the swivel-chair between them._",
      "",
      "## Decisions they own",
      "_The judgment calls. Feeds the agentic angle (assist vs automate) of the tasks below._",
      "",
      "## Tasks",
      "<!-- TASKS:BEGIN (generated from " + `${role}.tasks.jsonl` + " — do not hand-edit) -->",
      "_No tasks yet. Add via `operating-model.ts add-task`._",
      "<!-- TASKS:END -->",
      "",
      `## What "amazing" would do for them`,
      "_Their answer to the north star, from their seat: if the software were amazing, what changes",
      "in their day? Strong agentic candidates (per docs/agentic-charter.md) feed the discovery",
      "pipeline as opportunities — they do NOT become build tickets here._",
      "",
      "## Domain-expert review",
      "_For SMEs / real operators: what's right, what's wrong, what's missing, where to scope._",
      "- [ ] Reviewed by: _&lt;name, date&gt;_",
      "",
    ].join("\n")
  );
  writeFileSync(roleTasks(vertical, role, root), "");
}

export function addEvidence(
  vertical: string,
  role: string,
  kind: string,
  url: string,
  excerpt: string,
  root = domainRoot()
): void {
  if (!existsSync(roleMd(vertical, role, root))) throw new Error(`No role '${role}' in '${vertical}'`);
  if (!EVIDENCE_KINDS.includes(kind as EvidenceKind))
    throw new Error(`Invalid kind '${kind}' (one of: ${EVIDENCE_KINDS.join(", ")})`);
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`Evidence requires a real source URL (got '${url}')`);
  if (!excerpt || excerpt.trim().length < 10)
    throw new Error("Evidence requires a verbatim excerpt (>=10 chars) — no citation, no task");
  const path = evidenceFile(vertical, role, root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ retrieved_at: nowIso(), source_url: url, kind, excerpt: excerpt.trim() }) + "\n");
}

export function addTask(vertical: string, role: string, task: Partial<TaskRecord>, root = domainRoot()): TaskRecord {
  if (!existsSync(roleMd(vertical, role, root))) throw new Error(`No role '${role}' in '${vertical}' — create it first`);
  if (!task.task || task.task.trim().length < 3) throw new Error("task text required");
  const cadence = (task.cadence ?? "adhoc") as Cadence;
  if (!CADENCES.includes(cadence)) throw new Error(`Invalid cadence '${cadence}' (one of: ${CADENCES.join(", ")})`);
  const agentic = (task.agentic_potential ?? "unassessed") as AgenticPotential;
  if (!AGENTIC.includes(agentic)) throw new Error(`Invalid agentic_potential '${agentic}'`);
  const refs = task.evidence_refs ?? [];
  if (refs.length === 0) throw new Error("no citation, no task — at least one evidence_ref (URL) is required");
  for (const r of refs) if (!/^https?:\/\/\S+$/.test(r)) throw new Error(`evidence_ref must be a URL (got '${r}')`);

  const impl = (task.implementation ?? "none") as Implementation;
  if (!IMPLEMENTATION.includes(impl)) throw new Error(`Invalid implementation '${impl}' (one of: ${IMPLEMENTATION.join(", ")})`);
  const v = task.value ?? {};
  const capture = (v as TaskValue).automation_capture_pct;
  if (capture && (capture.low < 0 || capture.high > 1)) throw new Error("automation_capture_pct range must be within 0..1");

  const id = task.id ?? `t${readJsonl<TaskRecord>(roleTasks(vertical, role, root)).length + 1}`;
  const record: TaskRecord = {
    id,
    task: task.task.trim(),
    cadence,
    frequency: task.frequency ?? "",
    pain: task.pain ?? "",
    tool_today: task.tool_today ?? "",
    decision_content: task.decision_content ?? "",
    agentic_potential: agentic,
    implementation: impl,
    capability: task.capability ?? "",
    value: {
      minutes_per_occurrence: (v as TaskValue).minutes_per_occurrence ?? null,
      occurrences_per_year: (v as TaskValue).occurrences_per_year ?? null,
      loaded_hourly_rate: (v as TaskValue).loaded_hourly_rate ?? null,
      automation_capture_pct: capture ?? null,
    },
    evidence_refs: refs,
  };
  appendFileSync(roleTasks(vertical, role, root), JSON.stringify(record) + "\n");
  touchRole(vertical, role, root);
  render(vertical, role, root);
  return record;
}

function touchRole(vertical: string, role: string, root = domainRoot()): void {
  const raw = readFileSync(roleMd(vertical, role, root), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return;
  const fm = yaml.load(m[1]!) as Record<string, unknown>;
  fm["last_reviewed"] = today();
  writeFileSync(roleMd(vertical, role, root), `---\n${yaml.dump(fm).trimEnd()}\n---\n${m[2]}`);
}

/**
 * Advance a single task's implementation status (the feedback loop: when a built/automated
 * PR ships, this is called so roadmap-coverage % and captured ROI climb). Deterministic.
 */
export function setImpl(
  vertical: string,
  role: string,
  taskId: string,
  impl: Implementation,
  root = domainRoot()
): TaskRecord {
  if (!IMPLEMENTATION.includes(impl)) throw new Error(`Invalid implementation '${impl}'`);
  const path = roleTasks(vertical, role, root);
  const tasks = readJsonl<TaskRecord>(path);
  const t = tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`no task '${taskId}' in ${vertical}/${role}`);
  t.implementation = impl;
  writeFileSync(path, tasks.map((x) => JSON.stringify(x)).join("\n") + (tasks.length ? "\n" : ""));
  touchRole(vertical, role, root);
  render(vertical, role, root);
  return t;
}

/** Regenerate the markdown task table in <role>.md from the JSONL (source of truth). */
export function render(vertical: string, role: string, root = domainRoot()): void {
  const tasks = readJsonl<TaskRecord>(roleTasks(vertical, role, root));
  const header =
    "| Task | Cadence | Pain | Tool today | Impl | Agentic | Capability |\n|------|---------|------|-----------|------|---------|-----------|";
  const rows = tasks.map(
    (t) =>
      `| ${t.task} | ${t.cadence} | ${t.pain || "—"} | ${t.tool_today || "—"} | \`${t.implementation ?? "none"}\` | \`${t.agentic_potential}\` | ${t.capability || "—"} |`
  );
  const table = tasks.length ? [header, ...rows].join("\n") : "_No tasks yet._";
  const raw = readFileSync(roleMd(vertical, role, root), "utf8");
  const replaced = raw.replace(
    /<!-- TASKS:BEGIN[^>]*-->[\s\S]*?<!-- TASKS:END -->/,
    `<!-- TASKS:BEGIN (generated from ${role}.tasks.jsonl — do not hand-edit) -->\n${table}\n<!-- TASKS:END -->`
  );
  writeFileSync(roleMd(vertical, role, root), replaced);
}

export function listRoles(vertical: string, root = domainRoot()): string[] {
  const dir = rolesDir(vertical, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "TEMPLATE.md")
    .map((f) => f.replace(/\.md$/, ""));
}

export function readMeta(vertical: string, root = domainRoot()): VerticalMeta {
  return yaml.load(readFileSync(metaFile(vertical, root), "utf8")) as VerticalMeta;
}

/**
 * Per-task annual labor as 90% CIs. A task is "modelled" only if we can derive minutes,
 * occurrences, and a rate — otherwise it's excluded from the $ rollup (and the report says so).
 * Returns the annual cost/hours plus the task's capture estimate; the caller buckets it into
 * addressable (assist|automate), capturable (× capture), and captured-today (automated only).
 */
function taskEconomics(
  t: TaskRecord,
  meta: VerticalMeta
): { cost: Range; hours: Range; capture: Range | null } | null {
  const mins = t.value?.minutes_per_occurrence;
  const occ = t.value?.occurrences_per_year ?? CADENCE_OCCURRENCES[t.cadence];
  const rate = t.value?.loaded_hourly_rate ?? meta.default_loaded_hourly_rate;
  if (!mins || !occ || !rate) return null;
  const hours = rangeScale(rangeMul(mins, occ), 60); // (minutes × occ) / 60
  const cost = rangeMul(hours, rate);
  return { cost, hours, capture: t.value?.automation_capture_pct ?? null };
}

export function coverage(vertical: string, root = domainRoot()): Coverage {
  const meta = readMeta(vertical, root);
  const roles = listRoles(vertical, root);
  const byCadence: Record<string, number> = {};
  const byAgentic: Record<string, number> = {};
  const byImplementation: Record<string, number> = {};
  let tasks = 0;
  let assessed = 0;
  let implemented = 0; // supported + automated
  let missingEvidence = 0;
  let modelledTasks = 0;
  let addrHours: Range = { ...ZERO }; // addressable (assist|automate) — the prize
  let addrCost: Range = { ...ZERO };
  let capableHours: Range = { ...ZERO }; // achievable (addressable × capture)
  let capableCost: Range = { ...ZERO };
  let capHours: Range = { ...ZERO }; // realized today (automated only)
  let capCost: Range = { ...ZERO };
  let costAll = 0; // expected (midpoint) annual cost of modelled tasks
  let costImplemented = 0; // expected annual cost of supported+automated modelled tasks

  for (const role of roles) {
    for (const t of readJsonl<TaskRecord>(roleTasks(vertical, role, root))) {
      tasks++;
      byCadence[t.cadence] = (byCadence[t.cadence] ?? 0) + 1;
      byAgentic[t.agentic_potential] = (byAgentic[t.agentic_potential] ?? 0) + 1;
      const impl = t.implementation ?? "none";
      byImplementation[impl] = (byImplementation[impl] ?? 0) + 1;
      if (t.agentic_potential !== "unassessed") assessed++;
      if (impl === "supported" || impl === "automated") implemented++;
      if (!t.evidence_refs || t.evidence_refs.length === 0) missingEvidence++;

      const econ = taskEconomics(t, meta);
      if (econ) {
        modelledTasks++;
        const expected = rangeMid(econ.cost);
        costAll += expected;
        if (impl === "supported" || impl === "automated") costImplemented += expected;
        const isCandidate = t.agentic_potential === "assist" || t.agentic_potential === "automate";
        if (isCandidate) {
          addrHours = rangeAdd(addrHours, econ.hours);
          addrCost = rangeAdd(addrCost, econ.cost);
          if (econ.capture) {
            capableHours = rangeAdd(capableHours, rangeMul(econ.hours, econ.capture));
            capableCost = rangeAdd(capableCost, rangeMul(econ.cost, econ.capture));
          }
        }
        if (impl === "automated" && econ.capture) {
          capHours = rangeAdd(capHours, rangeMul(econ.hours, econ.capture));
          capCost = rangeAdd(capCost, rangeMul(econ.cost, econ.capture));
        }
      }
    }
  }

  const fte = meta.hours_per_fte_year || 1800;
  return {
    vertical,
    roles: roles.length,
    tasks,
    byCadence,
    byAgentic,
    byImplementation,
    agenticAssessedPct: tasks ? Math.round((assessed / tasks) * 100) : 0,
    implementedPct: tasks ? Math.round((implemented / tasks) * 100) : 0,
    implementedPctValueWeighted: costAll ? Math.round((costImplemented / costAll) * 100) : 0,
    tasksMissingEvidence: missingEvidence,
    roi: {
      modelledTasks,
      valueModelCoveragePct: tasks ? Math.round((modelledTasks / tasks) * 100) : 0,
      addressableCost: addrCost,
      addressableHours: addrHours,
      capturableCost: capableCost,
      capturableHours: capableHours,
      capturableFte: rangeScale(capableHours, fte),
      annualHoursCaptured: capHours,
      annualCostCaptured: capCost,
      fteEquivalent: rangeScale(capHours, fte),
    },
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const dollarRange = (r: Range) => `${money(r.low)}–${money(r.high)}/yr`;

/** Write the Coverage & ROI block into operating-model.md from the current coverage rollup. */
export function renderModel(vertical: string, root = domainRoot()): Coverage {
  const c = coverage(vertical, root);
  const r = c.roi;
  const block = [
    `_Directional estimate (90% confidence intervals, Hubbard-style) — calibrated, not measured; validate with SMEs. Last computed: ${today()}._`,
    "",
    `- **Roadmap coverage:** ${c.implementedPct}% of tasks implemented (\`supported\`+\`automated\`); **${c.implementedPctValueWeighted}% value-weighted**.`,
    `- **Tasks mapped:** ${c.tasks} across ${c.roles} roles · agentic-assessed ${c.agenticAssessedPct}% · ROI-modelled ${r.valueModelCoveragePct}% (the $ figures cover only these).`,
    `- **Addressable opportunity** (the prize — annual labor on \`assist\`+\`automate\` tasks): **${dollarRange(r.addressableCost)}**.`,
    `- **Capturable** (× per-task automation-capture estimate): ${dollarRange(r.capturableCost)} ≈ **${r.capturableFte.low.toFixed(1)}–${r.capturableFte.high.toFixed(1)} FTE**.`,
    `- **Captured today** (tasks already \`automated\` in the product): ${dollarRange(r.annualCostCaptured)} ≈ ${r.fteEquivalent.low.toFixed(1)}–${r.fteEquivalent.high.toFixed(1)} FTE.`,
    "",
    "_Three honest numbers: **addressable** = the size of the prize, **capturable** = achievable if we automate the candidates, **captured today** = realized now (grows as the roadmap ships). Wide ranges are honest — a few real SME data points tighten them fast (the rule of five)._",
  ].join("\n");
  const path = join(vDir(vertical, root), "operating-model.md");
  const raw = readFileSync(path, "utf8");
  const replaced = raw.replace(
    /<!-- COVERAGE:BEGIN[^>]*-->[\s\S]*?<!-- COVERAGE:END -->/,
    `<!-- COVERAGE:BEGIN (generated by \`operating-model.ts render-model\` — do not hand-edit) -->\n${block}\n<!-- COVERAGE:END -->`
  );
  writeFileSync(path, replaced);
  return c;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}

/** Parse a 90% CI from "low-high" or a single "n" (point → low=high). Returns null if absent. */
export function parseRange(s: string | undefined): Range | null {
  if (!s) return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)(?:\s*-\s*(-?\d+(?:\.\d+)?))?$/);
  if (!m) throw new Error(`bad range '${s}' (use "low-high" or a single number)`);
  const low = Number(m[1]);
  const high = m[2] !== undefined ? Number(m[2]) : low;
  return { low, high };
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const out = (v: unknown) => process.stdout.write(typeof v === "string" ? v + "\n" : JSON.stringify(v, null, 2) + "\n");
  try {
    switch (cmd) {
      case "new-vertical":
        newVertical(rest[0]!, rest[1]!, flag(rest, "--segment") ?? "", flag(rest, "--north-star") ?? "", {
          defaultRate: parseRange(flag(rest, "--rate")),
          hoursPerFteYear: flag(rest, "--fte") ? Number(flag(rest, "--fte")) : undefined,
        });
        out(`created vertical '${rest[0]}'`);
        break;
      case "new-role":
        newRole(rest[0]!, rest[1]!, rest[2]!, (flag(rest, "--capability") ?? "").split(",").filter(Boolean));
        out(`created role '${rest[1]}' in '${rest[0]}'`);
        break;
      case "add-evidence":
        addEvidence(rest[0]!, rest[1]!, rest[2]!, rest[3]!, rest[4]!);
        out(`evidence added to ${rest[0]}/${rest[1]}`);
        break;
      case "add-task": {
        const t = addTask(rest[0]!, rest[1]!, {
          task: flag(rest, "--task"),
          cadence: flag(rest, "--cadence") as Cadence | undefined,
          frequency: flag(rest, "--frequency"),
          pain: flag(rest, "--pain"),
          tool_today: flag(rest, "--tool"),
          decision_content: flag(rest, "--decision"),
          agentic_potential: flag(rest, "--agentic") as AgenticPotential | undefined,
          implementation: flag(rest, "--impl") as Implementation | undefined,
          capability: flag(rest, "--capability"),
          value: {
            minutes_per_occurrence: parseRange(flag(rest, "--minutes")),
            occurrences_per_year: parseRange(flag(rest, "--occurrences")),
            loaded_hourly_rate: parseRange(flag(rest, "--rate")),
            automation_capture_pct: parseRange(flag(rest, "--capture")),
          },
          evidence_refs: (flag(rest, "--evidence") ?? "").split(",").filter(Boolean),
        });
        out(`added task '${t.id}' to ${rest[0]}/${rest[1]}`);
        break;
      }
      case "render":
        render(rest[0]!, rest[1]!);
        out(`rendered ${rest[0]}/${rest[1]}`);
        break;
      case "set-impl": {
        const t = setImpl(rest[0]!, rest[1]!, rest[2]!, rest[3]! as Implementation);
        out(`${rest[0]}/${rest[1]}/${t.id} implementation → ${t.implementation}`);
        break;
      }
      case "render-model": {
        const c = renderModel(rest[0]!);
        out(`rendered Coverage & ROI into ${rest[0]}/operating-model.md (${c.implementedPct}% implemented, ${c.roi.modelledTasks} modelled tasks)`);
        break;
      }
      case "list-roles":
        out(listRoles(rest[0]!).join("\n") || "(no roles)");
        break;
      case "coverage":
      case "roi":
        out(coverage(rest[0]!));
        break;
      default:
        process.stderr.write(
          "usage: operating-model.ts <new-vertical|new-role|add-evidence|add-task|set-impl|render|render-model|list-roles|coverage|roi> ...\n"
        );
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
