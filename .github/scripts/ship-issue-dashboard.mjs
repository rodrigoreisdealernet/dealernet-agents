#!/usr/bin/env node
// ship-issue-dashboard.mjs — dependency-free live status page for /ship-issue runs.
// Maintains <base>.json (status model) and re-renders <base>.html after every change.
//
// Usage:
//   init  <base> --issue <n> --title "<title>" --slug <slug> --branch <branch> --issue-url <url>
//   set   <base> <stepId> <status> [--summary "..."] [--artifact "Label=href" ...]
//                                   [--pr <n> --pr-url <url>] [--gate spec-approval|merge|none]
//                                   [--note "..."]
//   render <base>
//
// Step ids: spec, approve, code, tests, test-review, code-review, merge
// Statuses: pending, running, done, waiting, failed, skipped

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const STEPS = [
  ["spec", "01 · Spec"],
  ["approve", "02 · Approve (human gate)"],
  ["code", "03 · Code"],
  ["tests", "04 · Tests"],
  ["test-review", "05 · Test review"],
  ["code-review", "06 · Code review"],
  ["merge", "Merge (human gate)"],
];
const STATUSES = ["pending", "running", "done", "waiting", "failed", "skipped"];

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        if (key === "artifact") {
          (flags.artifact ??= []).push(next);
        } else {
          flags[key] = next;
        }
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function jsonPath(base) {
  return `${base}.json`;
}
function htmlPath(base) {
  return `${base}.html`;
}

function load(base) {
  const p = jsonPath(base);
  if (!existsSync(p)) throw new Error(`No status model at ${p} — run 'init' first.`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function save(base, model) {
  model.updatedAt = new Date().toISOString();
  mkdirSync(dirname(jsonPath(base)), { recursive: true });
  writeFileSync(jsonPath(base), JSON.stringify(model, null, 2));
  writeFileSync(htmlPath(base), render(model));
}

const STATUS_COLOR = {
  pending: "#9ca3af",
  running: "#2563eb",
  done: "#16a34a",
  waiting: "#d97706",
  failed: "#dc2626",
  skipped: "#6b7280",
};
const STATUS_ICON = {
  pending: "○",
  running: "◐",
  done: "●",
  waiting: "⏸",
  failed: "✕",
  skipped: "—",
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function render(m) {
  const done = m.steps.filter((s) => s.status === "done").length;
  const pct = Math.round((done / m.steps.length) * 100);
  const gateStep = m.steps.find((s) => s.gate && s.status === "waiting");
  const banner = gateStep
    ? `<div class="banner">🚧 Waiting on human gate: <b>${esc(gateStep.gate)}</b></div>`
    : "";
  const rows = m.steps
    .map((s) => {
      const c = STATUS_COLOR[s.status] || "#9ca3af";
      const arts = (s.artifacts || [])
        .map((a) => `<a href="${esc(a.href)}">${esc(a.label)}</a>`)
        .join(" · ");
      const notes = (s.notes || [])
        .slice(-5)
        .map((n) => `<li>${esc(n)}</li>`)
        .join("");
      return `<tr class="${s.status}">
        <td class="ic" style="color:${c}">${STATUS_ICON[s.status] || "○"}</td>
        <td class="lbl">${esc(s.label)}<div class="st" style="color:${c}">${esc(s.status)}</div></td>
        <td class="meta">
          ${s.summary ? `<div class="sum">${esc(s.summary)}</div>` : ""}
          ${arts ? `<div class="arts">${arts}</div>` : ""}
          ${notes ? `<ul class="notes">${notes}</ul>` : ""}
        </td>
      </tr>`;
    })
    .join("");
  const prLink = m.prUrl ? `· <a href="${esc(m.prUrl)}">PR #${esc(m.pr)}</a>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>ship-issue #${esc(m.issue)} — ${esc(m.title)}</title>
<style>
  :root{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  body{margin:0;background:#0b0e14;color:#e5e7eb;padding:24px}
  .wrap{max-width:860px;margin:0 auto}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#9ca3af;font-size:13px;margin-bottom:16px}
  .sub a{color:#60a5fa;text-decoration:none}
  .bar{height:8px;background:#1f2937;border-radius:99px;overflow:hidden;margin:12px 0 20px}
  .bar>i{display:block;height:100%;background:#16a34a;width:${pct}%}
  .banner{background:#7c2d12;color:#fed7aa;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:14px}
  table{width:100%;border-collapse:collapse}
  td{padding:12px 8px;border-top:1px solid #1f2937;vertical-align:top}
  .ic{font-size:18px;width:28px;text-align:center}
  .lbl{font-weight:600;width:200px}
  .st{font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
  .sum{font-size:14px;color:#d1d5db}
  .arts{margin-top:6px;font-size:13px}
  .arts a{color:#60a5fa;text-decoration:none}
  .notes{margin:8px 0 0;padding-left:18px;color:#9ca3af;font-size:12px}
  tr.running{background:#0f1b33}
  .foot{color:#6b7280;font-size:12px;margin-top:20px}
</style></head><body><div class="wrap">
<h1>ship-issue #${esc(m.issue)} — ${esc(m.title)}</h1>
<div class="sub"><a href="${esc(m.issueUrl)}">issue</a> · branch <code>${esc(m.branch)}</code> ${prLink} · ${pct}% complete</div>
<div class="bar"><i></i></div>
${banner}
<table><tbody>${rows}</tbody></table>
<div class="foot">auto-refreshes every 5s · last update ${esc(m.updatedAt)}</div>
</div></body></html>`;
}

function cmdInit(base, flags) {
  const model = {
    issue: flags.issue,
    title: flags.title || "",
    slug: flags.slug || "",
    branch: flags.branch || "",
    issueUrl: flags["issue-url"] || "",
    pr: null,
    prUrl: null,
    updatedAt: null,
    steps: STEPS.map(([id, label]) => ({
      id,
      label,
      status: "pending",
      summary: "",
      artifacts: [],
      notes: [],
      gate: null,
    })),
  };
  save(base, model);
  console.log(htmlPath(base));
}

function cmdSet(base, positional, flags) {
  const [stepId, status] = positional;
  if (!STEPS.some(([id]) => id === stepId)) throw new Error(`Unknown step '${stepId}'`);
  if (!STATUSES.includes(status)) throw new Error(`Unknown status '${status}'`);
  const model = load(base);
  const step = model.steps.find((s) => s.id === stepId);
  step.status = status;
  if (flags.summary) step.summary = flags.summary;
  if (flags.gate) step.gate = flags.gate === "none" ? null : flags.gate;
  if (flags.note) step.notes.push(flags.note);
  for (const a of flags.artifact || []) {
    const idx = a.indexOf("=");
    if (idx > 0) step.artifacts.push({ label: a.slice(0, idx), href: a.slice(idx + 1) });
  }
  if (flags.pr) model.pr = flags.pr;
  if (flags["pr-url"]) model.prUrl = flags["pr-url"];
  save(base, model);
  console.log(htmlPath(base));
}

function cmdRender(base) {
  const model = load(base);
  save(base, model);
  console.log(htmlPath(base));
}

const [cmd, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);
const base = positional.shift();
if (!cmd || !base) {
  console.error("usage: ship-issue-dashboard.mjs <init|set|render> <base> [...]");
  process.exit(1);
}
try {
  if (cmd === "init") cmdInit(base, flags);
  else if (cmd === "set") cmdSet(base, positional, flags);
  else if (cmd === "render") cmdRender(base);
  else throw new Error(`Unknown command '${cmd}'`);
} catch (e) {
  console.error(`ship-issue-dashboard: ${e.message}`);
  process.exit(1);
}
