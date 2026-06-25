#!/usr/bin/env node
/**
 * run-pr-pipeline.ts — the per-PR agentic loop.
 *
 * Replaces the old monolithic `tech-review` + `merge-assign` stages (one
 * open-ended session looping over all PRs, which grew to ~100k-token context
 * and was killed mid-sweep). Instead:
 *
 *   1. Fetch every open PR in ONE batched query (pr-snapshot).
 *   2. Order OLDEST-FIRST and skip only PRs with nothing to do (pr-ordering).
 *   3. Loop one-by-one: a FRESH, focused `project-manager` agent session per
 *      PR, handed that PR's snapshot, with its own short timeout. Each PR's
 *      actions are persisted before the next starts, so a broad timeout only
 *      truncates the TAIL — and the oldest (most at-risk) PRs are handled first.
 *   4. After the PR loop, one short `project-manager` session does ONLY
 *      assignment of new work + stale-assignment cleanup.
 *
 * The agentic loop is the core; pr-snapshot is just an optimization that hands
 * each agent authoritative state so it doesn't burn turns re-deriving it.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { loadAgent, interpolate } from "./agent-loader.js";
import { loadFactoryConfig } from "./factory-config.js";
import { getGitHubContext, type GitHubContext } from "./github-context.js";
import { fetchPrSnapshots, type PrSnapshot } from "./pr-snapshot.js";
import { planLoop } from "./pr-ordering.js";
import { runCiRetriggerPrepass, DEFAULT_RETRIGGER_CAP } from "./ci-retrigger.js";
import {
  computeStateFingerprint,
  advanceLedger,
  formatStateMarker,
  buildStuckNotice,
  type PrStateLedger,
} from "./pr-state.js";
import {
  createCopilotClient,
  buildSessionConfig,
  buildTemplateVars,
} from "./run-agent.js";
import { attachLogger, info, warn, writeSummary } from "./logging.js";

/** Per-PR work budget (ms). The orchestrator owns the real timeout, not the SDK frontmatter. */
const PER_PR_TIMEOUT_MS =
  (Number(process.env["PER_PR_TIMEOUT_MIN"]) || 6) * 60 * 1000;
/** Budget for the single assignment session that runs after the PR loop. */
const ASSIGN_TIMEOUT_MS =
  (Number(process.env["ASSIGN_TIMEOUT_MIN"]) || 5) * 60 * 1000;
/** Overall wall-clock budget for the whole pass; stop starting new PR sessions
 * once the remaining time would not leave room for the assignment phase. Keep
 * comfortably under the workflow `timeout-minutes`. */
const PIPELINE_BUDGET_MS =
  (Number(process.env["PR_PIPELINE_BUDGET_MIN"]) || 28) * 60 * 1000;

export type PrLoopStatus = "ok" | "timeout" | "error";

export interface PrLoopResult {
  number: number;
  title: string;
  status: PrLoopStatus;
  detail?: string;
}

/**
 * Pure sequential loop: run `handleOne` over each PR in the given order,
 * continuing past any failure so one bad PR never blocks the rest. The order
 * is the caller's responsibility (oldest-first). Kept SDK-free so it is unit
 * testable.
 *
 * `shouldContinue` is checked BEFORE each PR; when it returns false the loop
 * stops starting new PRs (e.g. to reserve time for the assignment phase). The
 * remaining PRs are simply deferred to the next pass — safe because the order
 * is oldest-first, so only the newest (least at-risk) PRs are ever deferred.
 */
export async function runPrLoop(
  prs: PrSnapshot[],
  handleOne: (pr: PrSnapshot) => Promise<PrLoopResult>,
  shouldContinue: () => boolean = () => true
): Promise<PrLoopResult[]> {
  const results: PrLoopResult[] = [];
  for (const pr of prs) {
    if (!shouldContinue()) break;
    try {
      results.push(await handleOne(pr));
    } catch (err) {
      results.push({
        number: pr.number,
        title: pr.title,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/** Run prompt handing the agent ONE PR plus its authoritative snapshot. */
export function buildPrPrompt(pr: PrSnapshot, ledger?: PrStateLedger): string {
  const stuckNotice = ledger ? buildStuckNotice(ledger) : null;
  return [
    `Handle exactly ONE pull request now: #${pr.number} — "${pr.title}" (author: ${pr.author}).`,
    ``,
    ...(stuckNotice ? [stuckNotice, ``] : []),
    `Current state snapshot (authoritative as of moments ago):`,
    "```json",
    JSON.stringify(pr, null, 2),
    "```",
    ``,
    `Work the Project Manager per-PR decision tree for this single PR, take the needed action(s), then stop.`,
    `Re-fetch with \`npx tsx .github/tools/shared/src/pr-snapshot.ts --pr ${pr.number}\` only if you changed the PR or need a detail not in the snapshot.`,
  ].join("\n");
}

/**
 * Persist the advanced ledger on the PR as a hidden marker comment — update
 * in place when one exists, else create it. Failures are swallowed (the PR
 * may have just been merged/closed by the session; the ledger then dies with
 * it, which is correct).
 */
export function persistLedger(ctx: GitHubContext, pr: PrSnapshot, ledger: PrStateLedger): void {
  const body = formatStateMarker(ledger);
  const repo = `repos/${ctx.owner}/${ctx.repo}`;
  try {
    if (pr.stateMarkerCommentId) {
      execFileSync(
        "gh",
        ["api", "-X", "PATCH", `${repo}/issues/comments/${pr.stateMarkerCommentId}`, "-f", `body=${body}`],
        { encoding: "utf8" }
      );
    } else {
      execFileSync(
        "gh",
        ["api", "-X", "POST", `${repo}/issues/${pr.number}/comments`, "-f", `body=${body}`],
        { encoding: "utf8" }
      );
    }
  } catch (err) {
    warn("Stuck-ledger marker write failed (PR likely just closed)", {
      pr: pr.number,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Handle one PR via a fresh, focused SDK session with its own timeout + abort-on-timeout. */
async function handlePrWithSession(
  client: CopilotClient,
  model: string | undefined,
  systemPrompt: string,
  workspace: string,
  pr: PrSnapshot,
  ledger?: PrStateLedger
): Promise<PrLoopResult> {
  info("Project Manager PR session start", {
    pr: pr.number,
    title: pr.title,
    stuckCount: ledger?.count ?? 1,
  });
  let session: CopilotSession | undefined;
  try {
    session = await client.createSession(
      buildSessionConfig(model, systemPrompt, workspace)
    );
    attachLogger(session as unknown as { on: (l: (e: unknown) => void) => void });
    await session.sendAndWait({ prompt: buildPrPrompt(pr, ledger) }, PER_PR_TIMEOUT_MS);
    info("Project Manager PR session done", { pr: pr.number });
    return { number: pr.number, title: pr.title, status: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = msg.startsWith("Timeout");
    // SDK timeout only stops waiting — actively abort the in-flight session so
    // the next PR starts clean.
    if (session) await session.abort().catch(() => undefined);
    warn("Project Manager PR session did not complete", {
      pr: pr.number,
      status: timedOut ? "timeout" : "error",
      err: msg,
    });
    return {
      number: pr.number,
      title: pr.title,
      status: timedOut ? "timeout" : "error",
      detail: msg,
    };
  }
}

/** One short session that does ONLY new-work assignment + stale cleanup (PR queue already handled). */
async function runAssignment(
  client: CopilotClient,
  ctx: GitHubContext,
  agentsPath: string,
  vars: Record<string, string | number>
): Promise<PrLoopStatus> {
  const { frontmatter, body } = loadAgent(agentsPath, "project-manager");
  const systemPrompt = interpolate(body, vars);
  let session: CopilotSession | undefined;
  try {
    session = await client.createSession(
      buildSessionConfig(frontmatter.model, systemPrompt, ctx.workspace)
    );
    attachLogger(session as unknown as { on: (l: (e: unknown) => void) => void });
    await session.sendAndWait(
      {
        prompt:
          `The open-PR queue has ALREADY been handled this pass by the per-PR loop — do NOT review, merge, nudge, or re-process open PRs.\n` +
          `Do ONLY: (2) assign new ready-for-dev work to Copilot up to the concurrency limit, and (3) clean up stale \`assigned-to-copilot\` issues with no open PR. ` +
          `Then write a brief summary of what you assigned and cleaned up.`,
      },
      ASSIGN_TIMEOUT_MS
    );
    return "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (session) await session.abort().catch(() => undefined);
    warn("Assignment phase did not complete", { err: msg });
    return msg.startsWith("Timeout") ? "timeout" : "error";
  }
}

function emoji(status: PrLoopStatus): string {
  return status === "ok" ? "✅" : status === "timeout" ? "⏱️" : "⚠️";
}

/**
 * Deterministic count of ALL open Copilot PRs (the snapshot query caps at the
 * oldest 50, so it cannot be used as the concurrency count). Returns Infinity
 * on failure so the gate FAILS CLOSED — assignment is skipped rather than
 * over-assigning when the count is unknown.
 */
export function countOpenCopilotPrs(ctx: GitHubContext): number {
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        `${ctx.owner}/${ctx.repo}`,
        "--state",
        "open",
        "--limit",
        "500",
        "--json",
        "author",
        "--jq",
        '[.[]|select(.author.login|ascii_downcase|test("copilot"))]|length',
      ],
      { encoding: "utf8" }
    );
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : Infinity;
  } catch {
    return Infinity;
  }
}

async function main(): Promise<void> {
  const token = process.env["COPILOT_GITHUB_TOKEN"];
  if (!token) {
    writeSummary("## ⚠️ PR pipeline skipped\n\n`COPILOT_TOKEN` is not configured.");
    info("COPILOT_GITHUB_TOKEN not set — skipping PR pipeline");
    process.exit(0);
  }

  const ctx = getGitHubContext();
  const configPath =
    process.env["FACTORY_CONFIG_PATH"] ?? join(ctx.workspace, ".github", "factory.yml");
  const agentsPath =
    process.env["AGENTS_PATH"] ?? join(ctx.workspace, ".github", "agents");

  const config = loadFactoryConfig(configPath);
  const vars = buildTemplateVars(ctx, config);
  const { frontmatter, body } = loadAgent(agentsPath, "project-manager");
  const systemPrompt = interpolate(body, vars);

  const snapshots = fetchPrSnapshots(ctx);

  // Deterministic CI re-trigger pre-pass: wake the actor-gated (zero-check)
  // PRs as the trusted actor BEFORE the agent loop, so validation is running
  // for the whole queue — not just the ~15 PRs an agent session reaches.
  const retriggerCap = Number(process.env["CI_RETRIGGER_CAP"]) || DEFAULT_RETRIGGER_CAP;
  const retrigger = runCiRetriggerPrepass(ctx, snapshots, Date.now(), retriggerCap);
  info("CI re-trigger pre-pass", {
    candidates: retrigger.candidates,
    attempted: retrigger.attempted,
    succeeded: retrigger.succeeded,
    failed: retrigger.failed,
  });

  const { actionable, skipped } = planLoop(snapshots, Date.now());
  info("PR pipeline plan", {
    open: snapshots.length,
    actionable: actionable.length,
    skipped: skipped.length,
    order: actionable.map((s) => s.number),
  });

  // Deterministic concurrency gate: the cap lives in factory.yml and is
  // enforced HERE, in code — not in the agent prompt. (Observed 2026-06-10:
  // the prompt-only cap was ignored and 84 PRs were assigned in 14h against a
  // cap of 8.) Fails closed: an unknown count skips assignment.
  const openCopilotPrs = countOpenCopilotPrs(ctx);
  const maxOpen = config.factory.max_open_copilot_prs;
  const assignmentAllowed = openCopilotPrs < maxOpen;
  if (!assignmentAllowed) {
    info("Assignment skipped — open Copilot PRs at/over cap", {
      open: openCopilotPrs,
      cap: maxOpen,
    });
  }

  const client = createCopilotClient(token);
  // Reserve time for the assignment phase: stop starting new PR sessions once
  // the remaining budget would not leave room for assignment. A PR already in
  // flight keeps its own PER_PR_TIMEOUT; the job `timeout-minutes` is the final
  // backstop. Deferred (newest) PRs are picked up next pass — oldest-first
  // ordering means only the least at-risk PRs are ever deferred.
  const stopStartingAtMs =
    Date.now() + PIPELINE_BUDGET_MS - (assignmentAllowed ? ASSIGN_TIMEOUT_MS : 0);
  const shouldContinue = () => Date.now() < stopStartingAtMs;

  let results: PrLoopResult[] = [];
  let assignStatus: PrLoopStatus = "ok";
  try {
    results = await runPrLoop(
      actionable,
      async (pr) => {
        // Stuck ledger: advance BEFORE the session (so the prompt carries the
        // count), persist AFTER (so a state the session just changed resets
        // next pass — the stored fingerprint is the pre-session one).
        const ledger = advanceLedger(
          pr.priorLedger,
          computeStateFingerprint(pr),
          new Date().toISOString()
        );
        const result = await handlePrWithSession(
          client,
          frontmatter.model,
          systemPrompt,
          ctx.workspace,
          pr,
          ledger
        );
        persistLedger(ctx, pr, ledger);
        return result;
      },
      shouldContinue
    );
    if (assignmentAllowed) {
      assignStatus = await runAssignment(client, ctx, agentsPath, vars);
    }
  } finally {
    await client.stop();
  }

  const deferred = actionable.slice(results.length);

  // Consolidated summary.
  const assignNote = assignmentAllowed
    ? `${emoji(assignStatus)} ${assignStatus}`
    : `⏭️ skipped (open Copilot PRs ${openCopilotPrs} ≥ cap ${maxOpen})`;
  const lines: string[] = [
    `## PR pipeline pass — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Open PRs: **${snapshots.length}** · handled: **${results.length}** · skipped: **${skipped.length}** · deferred: **${deferred.length}** · assignment: ${assignNote}`,
    "",
    `CI re-trigger pre-pass: ${retrigger.succeeded.length}/${retrigger.attempted} woken (of ${retrigger.candidates} gated candidates)${retrigger.failed.length > 0 ? ` · ${retrigger.failed.length} failed` : ""}`,
    "",
    "| PR | Result | Notes |",
    "|----|--------|-------|",
  ];
  for (const r of results) {
    lines.push(`| #${r.number} | ${emoji(r.status)} ${r.status} | ${(r.detail ?? r.title).slice(0, 80)} |`);
  }
  for (const s of skipped) {
    lines.push(`| #${s.snapshot.number} | ⏭️ skipped | ${s.reason.slice(0, 80)} |`);
  }
  for (const d of deferred) {
    lines.push(`| #${d.number} | ⏳ deferred | ran out of pass budget — next pass (oldest-first) |`);
  }
  writeSummary(lines.join("\n"));
  info("PR pipeline complete", {
    handled: results.length,
    timeouts: results.filter((r) => r.status === "timeout").length,
    errors: results.filter((r) => r.status === "error").length,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
