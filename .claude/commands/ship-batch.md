---
description: Ship ALL open GitHub issues in one run — isolated git worktrees per issue, dependency-ordered, serial merge with auto-rebase. Specs auto-approved; humans gate only the final merge.
argument-hint: "[--only 3,8,10] [--label cap:parts] [--dry-run]"
---

You are running the **batch issue-to-merge pipeline** (`/ship-batch`). It ships
many GitHub issues in a single run **without branches fighting each other**, and
merges them in **dependency order** so migrations and frontend changes don't
collide.

## The core idea (read this first)

The single-issue `/ship-issue` does `git checkout` in the **shared** working tree.
Run two at once and they trample each other. `/ship-batch` fixes that structurally:

- **One git worktree per issue** — each issue gets its own directory **and** branch
  (`feature/<n>-<slug>`) physically separate under
  `<repo-parent>/<repo-name>-worktrees/<n>-<slug>`. A `checkout` in one can never
  disturb another. This is the whole reason the batch is safe.
- **Dependency-ordered waves** — `#3` (data foundation) merges before everything
  that builds on it; `#10` waits for `#8`. Computed automatically from labels and
  "Depende da #N" / "depends on #N" text in issue bodies.
- **Serial merge queue with auto-rebase** — PRs merge one at a time; after each
  merge the remaining worktrees rebase onto the updated `main`, so conflicts
  surface early and small.

All git/gh mechanics are done by **`.github/scripts/ship-batch.mjs`** (deterministic).
You orchestrate the agents and the gates.

## Decisions baked into this pipeline (per project owner)

1. **Spec gate: AUTO-APPROVED.** Generate the spec, then proceed straight to code —
   do **not** stop for spec approval. Quality is enforced at the **code review** on
   the PR, not before coding.
2. **Merge: serial queue with auto-rebase, ONE human OK.** Build all PRs, then ask
   the human once to start the merge queue. Merge in dependency order, rebasing the
   rest after each. Stop only if a rebase conflict genuinely needs a human.
3. **Dependencies: foundation first.** Trust the plan's wave order.

## Arguments

Parse `$ARGUMENTS`:
- **`--only <list>`** — restrict to specific issue numbers, e.g. `--only 3,8,10`.
- **`--label <name>`** — restrict to issues carrying a label.
- **`--dry-run`** — build the plan and create worktrees, but make **no** commits,
  **no** PRs, and **no** merges. Print what each step would do.

## ⚠️ Hard constraints (do not violate)

- **Never run agents or commands against the main working tree for an issue's
  code.** Every issue's spec→code→tests→review work happens **inside that issue's
  worktree path**. Pass the absolute worktree path to every subagent and tell it to
  `cd` into it before any file edit or command. The subagent runs in an isolated
  context and cannot see this conversation — pass every path explicitly.
- **The local Supabase DB is a single shared stack.** `supabase db reset` / `supabase
  start` touch one Postgres. **Never run them in parallel across worktrees.** Agents
  may *write* migration SQL freely, but DB-apply validation is **serialized** and run
  by you at merge time (see Phase 3). If an agent needs to sanity-check SQL in
  parallel, it does so by static review only — not by resetting the shared DB.
- **Don't auto-merge.** The human gives one go-ahead before the merge queue.

## Phase 0 — Plan

1. Build the plan:
   `node .github/scripts/ship-batch.mjs plan [--only ...] [--label ...]`
   It writes `docs/ship-batch/plan.json` and prints the merge order + waves.
2. Show the user the **merge order**, the **waves**, and each issue's
   **deps/branch/worktree**. This is the map for the whole run.

## Phase 1 — Worktrees + parallel build (per wave)

Process waves **in order** (`plan.waves[0]`, then `[1]`, …). Within a wave, issues
are independent — build them concurrently.

For each wave:

1. **Create the worktrees** for every issue in the wave (off the latest `main`,
   which already contains all previously-merged waves):
   `node .github/scripts/ship-batch.mjs add <issue>` (skip the commit/PR side
   effects only under `--dry-run`; still create the worktree).
2. **Run the per-issue pipeline in parallel**, one set of subagents per issue, each
   pinned to that issue's worktree path. For each issue spawn the roles from
   `.claude/agents/` exactly as `/ship-issue` does (see its "How agents are spawned"
   section — `coder`/`tester` → `general-purpose`, `spec`/`reviewer` → `Explore`),
   but with these batch rules:
   - Tell each subagent: **"Work only inside `<abs-worktree-path>`. cd into it before
     any command; all file paths are relative to it."**
   - **Reuse the existing dashboard** per issue:
     `docs/ship-issue/<n>-<slug>` (init it, then drive it through the steps just like
     `/ship-issue`). The batch keeps each issue fully traceable.
   - Pipeline per issue: **spec → (auto-approve) → code → tests → code-review → PR**.
     - `spec`: write `docs/specs/<n>-<slug>.md` (inside the worktree), post to issue.
     - **Auto-approve**: mark the approve step `done --summary "Auto-approved (batch)" --gate none`. Do not stop.
     - `coder`: implement the minimal change for the acceptance criteria. Commit in
       the worktree. Coder may **statically** verify SQL/TS but must **not** run
       `supabase db reset`.
     - `tester`: generate tests; for DB work, write migration/contract tests but do
       **not** reset the shared DB. Commit. Open a **draft PR** (`gh pr create`)
       from the worktree's branch, linking the issue + spec.
     - `reviewer` mode `tests` then mode `diff`: post reviews on the PR. Apply the
       same ≤2-iteration loop as `/ship-issue` for the test review.
   - Mark each PR **ready** (`gh pr ready`) when its reviews pass.
3. When the wave's PRs are all green, continue to the **next wave's** worktree
   creation (its branches will fork off the still-un-merged `main`; they get rebased
   during Phase 3 after earlier waves merge). For tighter conflict control you may
   instead merge each wave (Phase 3) before building the next — prefer this when the
   waves heavily share files (migrations).

> Concurrency: build at most ~3–4 issues at once to keep output legible and avoid
> hammering `gh`. Queue the rest.

## Phase 2 — Summary + the one human gate 🚧

When all PRs (across all waves) are built and green:

- Print a table: issue # · PR URL · wave · deps · review verdict · dashboard path.
- **STOP and ask the human once:**

  > Todos os PRs estão prontos e verdes, na ordem de merge: `<order>`. Posso iniciar
  > a fila de merge serial (com rebase automático)? Responda `seguir` para mergear
  > tudo nessa ordem, ou diga quais PRs segurar.

Do not merge until the human says go. This is the **only** human gate in the batch.

## Phase 3 — Serial merge queue with auto-rebase

Once approved, merge in **`plan.order`**. For each issue in order:

1. **Rebase its worktree** onto the freshly-updated main:
   `node .github/scripts/ship-batch.mjs rebase <issue> --onto origin/main`.
   - Exit code `2` means **conflicts**. Resolve them: spawn a `general-purpose`
     subagent pinned to that worktree to resolve the conflict markers honoring both
     changes, `git rebase --continue`, and push (`git push --force-with-lease`).
     If it can't be resolved cleanly, **stop and escalate to the human** with the
     conflicting files. Never force a broken merge.
2. **Validate the integrated migrations** (serialized — this is the one place the
   shared DB is touched): from the **main** working tree after rebase/merge,
   `supabase db reset --config supabase/config.toml`. Must be green before merge.
   If it fails, stop and escalate.
3. **Merge the PR**: `gh pr merge <pr> --squash --delete-branch`.
4. **Fetch** updated main (`git fetch origin`) so the next issue rebases onto it.
5. **Clean up** the merged worktree:
   `node .github/scripts/ship-batch.mjs rm <issue> --delete-branch --force`.

After the last merge, run `node .github/scripts/ship-batch.mjs prune --force` to
clear any leftover worktrees, and `git worktree prune`.

## When you finish

Print a final summary:
- Issues shipped (merged) vs. held, with PR URLs.
- Any issue that stopped at a conflict/validation gate and why.
- The merge order actually executed.
- Links to each issue's dashboard `docs/ship-issue/<n>-<slug>.html`.

## Recovery / re-runs

- `node .github/scripts/ship-batch.mjs list` — see live batch worktrees.
- Re-running `add <issue>` is safe (no-op if the worktree exists).
- `prune --delete-branch --force` — nuke all batch worktrees/branches to start clean.
- The plan is deterministic: regenerate with `plan` anytime; it never edits git state.
