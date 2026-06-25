#!/usr/bin/env node
// ship-batch.mjs — deterministic mechanics for shipping many GitHub issues at once,
// each in its own isolated git worktree, merged serially in dependency order.
//
// Why this exists: /ship-issue does `git checkout` in the *shared* working tree, so
// running two at once makes them fight over the same tree. This script gives each
// issue its own worktree (separate dir + branch), computes a safe merge order from
// declared dependencies, and drives a serial merge queue that rebases the rest.
//
// Dependency-free (Node built-ins only), mirroring ship-issue-dashboard.mjs.
//
// Usage:
//   plan   [--state open] [--label L] [--only 3,8,10] [--out <file>]
//          Fetch open issues via `gh`, detect dependencies, emit an ordered plan JSON.
//   add    <issue> [--base <ref>] [--plan <file>]
//          Create the isolated worktree + branch feature/<n>-<slug> for one issue.
//   list   List batch worktrees this script manages.
//   rm     <issue> [--delete-branch] [--force]   Remove one issue's worktree.
//   prune  [--delete-branch] [--force]           Remove ALL batch worktrees.
//   rebase <issue> [--onto <ref>]                Rebase one worktree onto <ref> (default origin/main).
//   slug   <issue>                               Print the derived slug (utility).
//
// Notes:
//  - Worktrees live OUTSIDE the repo at  <repo-parent>/<repo-name>-worktrees/<n>-<slug>
//    so they are never scanned, committed, or tangled with the main tree.
//  - This script does NOT call agents and does NOT merge automatically; the
//    /ship-batch command orchestrates those steps. It only does the git/gh mechanics
//    so they are deterministic and identical every run.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";

// ---------- small shell helpers ----------
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (e) {
    return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status };
  }
}
function git(args, opts = {}) {
  return run("git", args, opts);
}

// ---------- arg parsing (same shape as ship-issue-dashboard.mjs) ----------
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
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------- repo geometry ----------
function repoRoot() {
  return git(["rev-parse", "--show-toplevel"]);
}
function worktreesDir() {
  const root = repoRoot();
  return join(dirname(root), `${basename(root)}-worktrees`);
}
function worktreePath(issue, slug) {
  return join(worktreesDir(), `${issue}-${slug}`);
}
function branchName(issue, slug) {
  return `feature/${issue}-${slug}`;
}

// ---------- slug ----------
function slugify(title) {
  return String(title)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
}

// ---------- dependency detection ----------
// Matches: "Depende da #8", "Depende de #8", "depends on #8", "blocked by #8",
//          "requires #8", "bloqueada por #8", "needs #8".
const DEP_RE =
  /(?:depende\s+(?:da|de|do)|depends?\s+on|blocked\s+by|bloquead[ao]\s+por|requires?|needs?)\s+#(\d+)/gi;

function detectDeps(body, knownNumbers) {
  const deps = new Set();
  let m;
  DEP_RE.lastIndex = 0;
  while ((m = DEP_RE.exec(body || "")) !== null) {
    const n = Number(m[1]);
    if (knownNumbers.has(n)) deps.add(n);
  }
  return [...deps];
}

// Foundation issues (schema/data foundation) should merge before everything that
// builds on them, even when no issue explicitly declares the dependency.
function isFoundation(issue) {
  const labels = (issue.labels || []).map((l) => l.name);
  if (labels.includes("cap:data")) return true;
  const t = (issue.title || "").toLowerCase();
  return labels.includes("area:db") && /(funda|foundation|schema|seed)/.test(t);
}

// ---------- topological order into waves ----------
function buildPlan(issues) {
  const known = new Set(issues.map((i) => i.number));
  const nodes = new Map();
  for (const i of issues) {
    nodes.set(i.number, {
      number: i.number,
      title: i.title,
      slug: slugify(i.title),
      labels: (i.labels || []).map((l) => l.name),
      foundation: isFoundation(i),
      deps: detectDeps(i.body, known),
    });
  }
  // Implicit edge: every non-foundation issue depends on every foundation issue.
  const foundations = [...nodes.values()].filter((n) => n.foundation).map((n) => n.number);
  for (const n of nodes.values()) {
    if (!n.foundation) {
      for (const f of foundations) if (f !== n.number && !n.deps.includes(f)) n.deps.push(f);
    }
  }
  // Kahn's algorithm → waves (each wave is internally parallel-safe).
  const waves = [];
  const remaining = new Map([...nodes].map(([k, v]) => [k, new Set(v.deps)]));
  let guard = 0;
  while (remaining.size > 0) {
    if (guard++ > 1000) throw new Error("dependency cycle or runaway; check issue bodies");
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => !remaining.has(d)))
      .map(([n]) => n)
      .sort((a, b) => a - b);
    if (ready.length === 0) {
      throw new Error(`dependency cycle among issues: ${[...remaining.keys()].join(", ")}`);
    }
    waves.push(ready);
    for (const n of ready) remaining.delete(n);
  }
  const order = waves.flat(); // serial merge order
  return {
    generatedFrom: "ship-batch.mjs plan",
    issues: order.map((n) => {
      const node = nodes.get(n);
      return {
        number: node.number,
        title: node.title,
        slug: node.slug,
        branch: branchName(node.number, node.slug),
        worktree: worktreePath(node.number, node.slug),
        foundation: node.foundation,
        deps: node.deps.sort((a, b) => a - b),
        labels: node.labels,
      };
    }),
    waves,
    order,
  };
}

// ---------- commands ----------
function cmdPlan(flags) {
  const state = flags.state || "open";
  const args = ["issue", "list", "--state", state, "--limit", "100", "--json", "number,title,body,labels"];
  if (flags.label) args.push("--label", flags.label);
  const raw = run("gh", args);
  let issues = JSON.parse(raw);
  if (flags.only) {
    const want = new Set(String(flags.only).split(",").map((s) => Number(s.trim())));
    issues = issues.filter((i) => want.has(i.number));
  }
  if (issues.length === 0) {
    console.error("No issues matched.");
    process.exit(1);
  }
  const plan = buildPlan(issues);
  const out = flags.out || join(repoRoot(), "docs", "ship-batch", "plan.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(plan, null, 2));
  // Human-readable summary to stdout.
  console.log(`Plan written to ${out}`);
  console.log(`\nMerge order (serial): ${plan.order.join(" → ")}`);
  console.log(`\nWaves (each wave is parallel-safe):`);
  plan.waves.forEach((w, i) => console.log(`  wave ${i}: ${w.join(", ")}`));
  console.log(`\nPer-issue:`);
  for (const it of plan.issues) {
    const dep = it.deps.length ? ` (deps: ${it.deps.join(", ")})` : "";
    const f = it.foundation ? " [foundation]" : "";
    console.log(`  #${it.number} ${it.slug}${f}${dep}\n      branch:   ${it.branch}\n      worktree: ${it.worktree}`);
  }
  return plan;
}

function loadPlan(flags) {
  const p = flags.plan || join(repoRoot(), "docs", "ship-batch", "plan.json");
  if (!existsSync(p)) throw new Error(`plan not found at ${p}; run "plan" first or pass --plan`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function findInPlan(plan, issue) {
  const it = plan.issues.find((x) => x.number === Number(issue));
  if (!it) throw new Error(`issue #${issue} not in plan`);
  return it;
}

function cmdAdd(positional, flags) {
  const issue = positional[0];
  if (!issue) throw new Error("usage: add <issue> [--base <ref>]");
  const plan = loadPlan(flags);
  const it = findInPlan(plan, issue);
  const base = flags.base || "origin/main";
  // Make sure we have the latest base ref locally.
  tryRun("git", ["fetch", "origin", "--quiet"]);
  mkdirSync(worktreesDir(), { recursive: true });
  if (existsSync(it.worktree)) {
    console.log(`Worktree already exists: ${it.worktree}`);
    return;
  }
  // Create worktree with a fresh branch off base.
  const res = tryRun("git", ["worktree", "add", "-b", it.branch, it.worktree, base]);
  if (!res.ok) {
    // Branch may already exist (re-run). Fall back to attaching it.
    const res2 = tryRun("git", ["worktree", "add", it.worktree, it.branch]);
    if (!res2.ok) throw new Error(`worktree add failed:\n${res.out}\n${res2.out}`);
  }
  console.log(`Worktree ready for #${it.number}:`);
  console.log(`  path:   ${it.worktree}`);
  console.log(`  branch: ${it.branch}  (off ${base})`);
  console.log(`\nRun the pipeline INSIDE that path, e.g.:`);
  console.log(`  cd "${it.worktree}"`);
}

function cmdList() {
  const out = git(["worktree", "list", "--porcelain"]);
  const dir = worktreesDir();
  const blocks = out.split("\n\n");
  const mine = blocks.filter((b) => b.includes(dir.replace(/\\/g, "/")) || b.includes(dir));
  if (mine.length === 0) {
    console.log("No batch worktrees.");
    return;
  }
  for (const b of mine) {
    const path = (b.match(/worktree (.+)/) || [])[1];
    const branch = (b.match(/branch (.+)/) || [])[1] || "(detached)";
    console.log(`${path}\n    ${branch}`);
  }
}

function cmdRm(positional, flags) {
  const issue = positional[0];
  if (!issue) throw new Error("usage: rm <issue> [--delete-branch] [--force]");
  const plan = loadPlan(flags);
  const it = findInPlan(plan, issue);
  const args = ["worktree", "remove", it.worktree];
  if (flags.force) args.push("--force");
  const res = tryRun("git", args);
  if (!res.ok) throw new Error(`worktree remove failed:\n${res.out}`);
  console.log(`Removed worktree ${it.worktree}`);
  if (flags["delete-branch"]) {
    const d = tryRun("git", ["branch", "-D", it.branch]);
    console.log(d.ok ? `Deleted branch ${it.branch}` : `Could not delete branch ${it.branch}: ${d.out}`);
  }
}

function cmdPrune(flags) {
  const plan = loadPlan(flags);
  for (const it of plan.issues) {
    if (existsSync(it.worktree)) {
      const args = ["worktree", "remove", it.worktree];
      if (flags.force) args.push("--force");
      const res = tryRun("git", args);
      console.log(res.ok ? `Removed ${it.worktree}` : `Skip ${it.worktree}: ${res.out}`);
    }
    if (flags["delete-branch"]) {
      tryRun("git", ["branch", "-D", it.branch]);
    }
  }
  tryRun("git", ["worktree", "prune"]);
  console.log("Done.");
}

function cmdRebase(positional, flags) {
  const issue = positional[0];
  if (!issue) throw new Error("usage: rebase <issue> [--onto <ref>]");
  const plan = loadPlan(flags);
  const it = findInPlan(plan, issue);
  const onto = flags.onto || "origin/main";
  tryRun("git", ["fetch", "origin", "--quiet"]);
  const res = tryRun("git", ["rebase", onto], { cwd: it.worktree });
  if (res.ok) {
    console.log(`#${it.number} rebased cleanly onto ${onto}`);
  } else {
    console.log(`#${it.number} rebase onto ${onto} hit conflicts — resolve in ${it.worktree}:`);
    console.log(res.out);
    process.exitCode = 2; // signal the orchestrator that human/agent conflict resolution is needed
  }
}

function cmdSlug(positional) {
  const issue = positional[0];
  if (!issue) throw new Error("usage: slug <issue>");
  const raw = run("gh", ["issue", "view", issue, "--json", "title"]);
  console.log(slugify(JSON.parse(raw).title));
}

// ---------- main ----------
const [, , sub, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
try {
  switch (sub) {
    case "plan": cmdPlan(flags); break;
    case "add": cmdAdd(positional, flags); break;
    case "list": cmdList(); break;
    case "rm": cmdRm(positional, flags); break;
    case "prune": cmdPrune(flags); break;
    case "rebase": cmdRebase(positional, flags); break;
    case "slug": cmdSlug(positional); break;
    default:
      console.error(
        "Usage: ship-batch.mjs <plan|add|list|rm|prune|rebase|slug> [...]\n" +
        "  plan   [--state open] [--label L] [--only 3,8,10] [--out <file>]\n" +
        "  add    <issue> [--base <ref>] [--plan <file>]\n" +
        "  list\n" +
        "  rm     <issue> [--delete-branch] [--force]\n" +
        "  prune  [--delete-branch] [--force]\n" +
        "  rebase <issue> [--onto <ref>]\n" +
        "  slug   <issue>"
      );
      process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
