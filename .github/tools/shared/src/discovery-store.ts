#!/usr/bin/env node
/**
 * discovery-store.ts — deterministic helper for the discovery dossier store
 * (`docs/discovery/`). The discovery-crew agents (market-scout, product-strategist,
 * discovery-critic) call this CLI instead of hand-editing dossier frontmatter, so the
 * maturity-ladder ENTRY BARS are enforced in code, not just asked for in a prompt
 * (the "factory LLM rules must be code" lesson).
 *
 * An idea climbs exactly one rung at a time and only when its bar is met:
 *   signal → opportunity → idea → validated → ready
 *
 * Storage layout (canonical source of truth, git-tracked, PR-reviewable):
 *   docs/discovery/ideas/<slug>.md            — one dossier, YAML frontmatter + body
 *   docs/discovery/evidence/<slug>/evidence.jsonl — append-only evidence log
 *
 * Subcommands:
 *   new-idea <slug> "<title>" [--rung R] [--initiative N]
 *   add-evidence <slug> <kind> <url> "<excerpt>" [--by who]
 *   set-field <slug> <dotted.key> <value>
 *   set-rung <slug> <rung> [--by who] [--why "..."] [--force]
 *   touch <slug>
 *   list [--rung R] [--stale-first] [--json]
 *   meets-bar <slug> <target-rung>       (exit 0 if the bar is met, else 2 + reasons)
 *   evidence-count <slug>
 *
 * Path resolution: DISCOVERY_ROOT env wins (used by tests); otherwise repo-root/docs/discovery.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

export const RUNGS = ["signal", "opportunity", "idea", "validated", "ready"] as const;
export type Rung = (typeof RUNGS)[number];

export const EVIDENCE_KINDS = ["competitor", "review", "news", "market", "feasibility", "customer"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface RiceScore {
  reach: number | null;
  impact: number | null;
  confidence: number | null;
  effort: number | null;
  rice: number | null;
}

export interface DossierFrontmatter {
  slug: string;
  title: string;
  rung: Rung;
  score: RiceScore;
  linked_issue: number | null;
  initiative: number | null;
  differentiator: string;
  agentic_potential: "unassessed" | "none" | "assist" | "automate";
  evidence_count: number;
  created: string;
  last_reviewed: string;
}

export interface Dossier {
  frontmatter: DossierFrontmatter;
  body: string;
}

export interface EvidenceRecord {
  retrieved_at: string;
  source_url: string;
  kind: EvidenceKind;
  excerpt: string;
  captured_by: string;
}

export interface BarResult {
  ok: boolean;
  reasons: string[];
}

// ── paths ────────────────────────────────────────────────────────────────────

export function discoveryRoot(): string {
  const env = process.env.DISCOVERY_ROOT;
  if (env) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  // src → shared → tools → .github → repo-root
  return join(resolve(here, "../../../.."), "docs", "discovery");
}

function ideasDir(root = discoveryRoot()): string {
  return join(root, "ideas");
}
function ideaPath(slug: string, root = discoveryRoot()): string {
  return join(ideasDir(root), `${slug}.md`);
}
function evidenceFile(slug: string, root = discoveryRoot()): string {
  return join(root, "evidence", slug, "evidence.jsonl");
}

function nowIso(): string {
  return new Date().toISOString();
}
function today(): string {
  return nowIso().slice(0, 10);
}

// ── frontmatter read / write ───────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseDossier(raw: string): Dossier {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) throw new Error("Dossier is missing YAML frontmatter (--- ... ---)");
  const frontmatter = yaml.load(m[1]!) as DossierFrontmatter;
  return { frontmatter, body: m[2] ?? "" };
}

export function serializeDossier(d: Dossier): string {
  const fm = yaml.dump(d.frontmatter, { lineWidth: 100, noRefs: true }).trimEnd();
  const body = d.body.startsWith("\n") ? d.body : `\n${d.body}`;
  return `---\n${fm}\n---\n${body}`;
}

export function readDossier(slug: string, root = discoveryRoot()): Dossier {
  const path = ideaPath(slug, root);
  if (!existsSync(path)) throw new Error(`No dossier for slug '${slug}' at ${path}`);
  return parseDossier(readFileSync(path, "utf8"));
}

export function writeDossier(d: Dossier, root = discoveryRoot()): void {
  mkdirSync(ideasDir(root), { recursive: true });
  writeFileSync(ideaPath(d.frontmatter.slug, root), serializeDossier(d));
}

// ── operations ───────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function newIdea(
  slug: string,
  title: string,
  opts: { rung?: Rung; initiative?: number } = {},
  root = discoveryRoot()
): Dossier {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid slug '${slug}' (use kebab-case: a-z, 0-9, -)`);
  if (existsSync(ideaPath(slug, root))) throw new Error(`Dossier '${slug}' already exists — use list/set-field`);
  const date = today();
  const dossier: Dossier = {
    frontmatter: {
      slug,
      title,
      rung: opts.rung ?? "signal",
      score: { reach: null, impact: null, confidence: null, effort: null, rice: null },
      linked_issue: null,
      initiative: opts.initiative ?? null,
      differentiator: "",
      agentic_potential: "unassessed",
      evidence_count: 0,
      created: date,
      last_reviewed: date,
    },
    body: [
      `# ${title}`,
      "",
      "## Problem / Opportunity",
      "_What pain or market gap is this? Who feels it?_",
      "",
      "## Hypothesis (the bet)",
      "_If we build X, then Y. State the wager plainly._",
      "",
      "## Evidence summary",
      "_Synthesis of the evidence log. Every claim must trace to a record in evidence.jsonl._",
      "",
      "## Differentiation (vs Renterra / RentalMan)",
      "_Why us, why now, why better than the competition._",
      "",
      "## Agentic angle",
      "_Per docs/agentic-charter.md: what does a human decide/route here that the system could",
      "investigate-and-propose (or safely act on with audit)? Name the insertion point, the",
      "human-approval boundary, and the fallback-when-unsure — or 'none' + which anti-pattern._",
      "",
      "## Scope sketch & open questions",
      "_Rough boundaries + the questions that must be answered before design._",
      "",
      "## Decision log",
      `- ${date} — created at rung \`${opts.rung ?? "signal"}\``,
      "",
    ].join("\n"),
  };
  writeDossier(dossier, root);
  return dossier;
}

export function evidenceCount(slug: string, root = discoveryRoot()): number {
  const path = evidenceFile(slug, root);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
}

export function addEvidence(
  slug: string,
  kind: string,
  url: string,
  excerpt: string,
  capturedBy = "market-scout",
  root = discoveryRoot()
): EvidenceRecord {
  if (!existsSync(ideaPath(slug, root))) throw new Error(`No dossier for slug '${slug}' — create it first`);
  if (!EVIDENCE_KINDS.includes(kind as EvidenceKind))
    throw new Error(`Invalid kind '${kind}' (one of: ${EVIDENCE_KINDS.join(", ")})`);
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`Evidence requires a real source URL (got '${url}')`);
  if (!excerpt || excerpt.trim().length < 10)
    throw new Error("Evidence requires a verbatim excerpt (>=10 chars) — no citation, no evidence");

  const record: EvidenceRecord = {
    retrieved_at: nowIso(),
    source_url: url,
    kind: kind as EvidenceKind,
    excerpt: excerpt.trim(),
    captured_by: capturedBy,
  };
  const path = evidenceFile(slug, root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");

  const d = readDossier(slug, root);
  d.frontmatter.evidence_count = evidenceCount(slug, root);
  d.frontmatter.last_reviewed = today();
  writeDossier(d, root);
  return record;
}

/** Is the dossier eligible to climb to `target`? Enforced bars (rules-as-code). */
export function meetsBar(slug: string, target: Rung, root = discoveryRoot()): BarResult {
  const d = readDossier(slug, root);
  const fm = d.frontmatter;
  const count = evidenceCount(slug, root);
  const reasons: string[] = [];

  const currentIdx = RUNGS.indexOf(fm.rung);
  const targetIdx = RUNGS.indexOf(target);
  if (targetIdx === -1) reasons.push(`unknown rung '${target}'`);
  if (targetIdx > currentIdx + 1) reasons.push(`cannot skip rungs (at '${fm.rung}', target '${target}')`);

  switch (target) {
    case "opportunity":
      if (count < 2) reasons.push(`needs >=2 evidence records (has ${count})`);
      break;
    case "idea":
      if (!fm.differentiator || fm.differentiator.trim().length < 10)
        reasons.push("needs a stated differentiator (vs Renterra / RentalMan)");
      break;
    case "validated":
      if (count < 3) reasons.push(`needs >=3 evidence records (has ${count})`);
      if (fm.score.rice == null) reasons.push("needs a computed RICE score");
      break;
    case "ready":
      if (fm.rung !== "validated") reasons.push("must be 'validated' before 'ready'");
      if (count < 3) reasons.push(`needs >=3 evidence records (has ${count})`);
      if (fm.score.rice == null) reasons.push("needs a computed RICE score");
      break;
  }
  return { ok: reasons.length === 0, reasons };
}

function setNested(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (typeof cur[k] !== "object" || cur[k] == null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function coerce(value: string): unknown {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

export function setField(slug: string, dottedKey: string, value: string, root = discoveryRoot()): Dossier {
  const d = readDossier(slug, root);
  setNested(d.frontmatter as unknown as Record<string, unknown>, dottedKey, coerce(value));
  d.frontmatter.last_reviewed = today();
  writeDossier(d, root);
  return d;
}

export function touch(slug: string, root = discoveryRoot()): void {
  const d = readDossier(slug, root);
  d.frontmatter.last_reviewed = today();
  writeDossier(d, root);
}

export function setRung(
  slug: string,
  rung: Rung,
  opts: { by?: string; why?: string; force?: boolean } = {},
  root = discoveryRoot()
): BarResult {
  if (!RUNGS.includes(rung)) throw new Error(`Unknown rung '${rung}'`);
  const bar = meetsBar(slug, rung, root);
  if (!bar.ok && !opts.force) return bar;

  const d = readDossier(slug, root);
  const from = d.frontmatter.rung;
  d.frontmatter.rung = rung;
  d.frontmatter.last_reviewed = today();
  const note = `- ${today()} — rung \`${from}\` → \`${rung}\`${opts.by ? ` by ${opts.by}` : ""}${
    opts.force && !bar.ok ? " (FORCED)" : ""
  }${opts.why ? ` — ${opts.why}` : ""}`;
  d.body = d.body.includes("## Decision log")
    ? d.body.replace(/(## Decision log\n)/, `$1${note}\n`)
    : `${d.body}\n## Decision log\n${note}\n`;
  writeDossier(d, root);
  return { ok: true, reasons: bar.ok ? [] : [`forced past unmet bar: ${bar.reasons.join("; ")}`] };
}

export function list(
  opts: { rung?: Rung; staleFirst?: boolean } = {},
  root = discoveryRoot()
): DossierFrontmatter[] {
  const dir = ideasDir(root);
  if (!existsSync(dir)) return [];
  const items = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "TEMPLATE.md")
    .map((f) => parseDossier(readFileSync(join(dir, f), "utf8")).frontmatter)
    .filter((fm) => !opts.rung || fm.rung === opts.rung);
  if (opts.staleFirst) items.sort((a, b) => a.last_reviewed.localeCompare(b.last_reviewed));
  return items;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const out = (v: unknown) => process.stdout.write(typeof v === "string" ? v + "\n" : JSON.stringify(v, null, 2) + "\n");
  try {
    switch (cmd) {
      case "new-idea": {
        const init = flag(rest, "--initiative");
        const d = newIdea(rest[0]!, rest[1]!, {
          rung: flag(rest, "--rung") as Rung | undefined,
          initiative: init ? Number(init) : undefined,
        });
        out(`created docs/discovery/ideas/${d.frontmatter.slug}.md (rung: ${d.frontmatter.rung})`);
        break;
      }
      case "add-evidence": {
        const r = addEvidence(rest[0]!, rest[1]!, rest[2]!, rest[3]!, flag(rest, "--by") ?? "market-scout");
        out(`evidence added to '${rest[0]}' (${r.kind}); evidence_count=${evidenceCount(rest[0]!)}`);
        break;
      }
      case "set-field":
        setField(rest[0]!, rest[1]!, rest[2]!);
        out(`set ${rest[1]}='${rest[2]}' on '${rest[0]}'`);
        break;
      case "set-rung": {
        const res = setRung(rest[0]!, rest[1]! as Rung, {
          by: flag(rest, "--by"),
          why: flag(rest, "--why"),
          force: has(rest, "--force"),
        });
        if (!res.ok) {
          process.stderr.write(`BLOCKED: '${rest[0]}' does not meet bar for '${rest[1]}':\n- ${res.reasons.join("\n- ")}\n`);
          process.exit(2);
        }
        out(`'${rest[0]}' → rung '${rest[1]}'${res.reasons.length ? ` (${res.reasons[0]})` : ""}`);
        break;
      }
      case "touch":
        touch(rest[0]!);
        out(`touched '${rest[0]}' (last_reviewed=${today()})`);
        break;
      case "list": {
        const items = list({ rung: flag(rest, "--rung") as Rung | undefined, staleFirst: has(rest, "--stale-first") });
        if (has(rest, "--json")) out(items);
        else out(items.map((i) => `${i.rung.padEnd(11)} ${i.last_reviewed} ev=${i.evidence_count} ${i.slug} — ${i.title}`).join("\n") || "(no dossiers)");
        break;
      }
      case "meets-bar": {
        const res = meetsBar(rest[0]!, rest[1]! as Rung);
        if (res.ok) out(`OK: '${rest[0]}' meets bar for '${rest[1]}'`);
        else {
          process.stderr.write(`NO: '${rest[0]}' does not meet bar for '${rest[1]}':\n- ${res.reasons.join("\n- ")}\n`);
          process.exit(2);
        }
        break;
      }
      case "evidence-count":
        out(String(evidenceCount(rest[0]!)));
        break;
      default:
        process.stderr.write(
          "usage: discovery-store.ts <new-idea|add-evidence|set-field|set-rung|touch|list|meets-bar|evidence-count> ...\n"
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
