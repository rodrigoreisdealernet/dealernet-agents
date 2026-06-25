---
description: Ship ALL open GitHub issues in one run — one clean-context orchestrator agent per issue (which spawns its own spec/coder/tester/reviewer subagents, all on the session's model/effort), isolated git worktrees, dependency-ordered, serial merge with auto-rebase, then run the app to prove it works. Specs auto-approved; humans gate only the final merge.
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
2. **Run one orchestrator agent per issue — in parallel.** Spawn **exactly one**
   subagent per issue. That agent **owns the issue end-to-end and is itself a
   per-issue orchestrator**: it runs the `/ship-issue` pipeline by spawning its
   **own role subagents** (`spec`, `coder`, `tester`, `reviewer`). So the structure
   is two tiers:

   ```
   /ship-batch (this session)
     └─ issue-agent #5  (clean context)   ┐
          ├─ spec subagent                │
          ├─ coder subagent               │  one such tree per issue,
          ├─ tester subagent              │  trees run in parallel
          └─ reviewer subagent (×2 modes) ┘
     └─ issue-agent #6 …  └─ issue-agent #8 …
   ```

   - **Issue-agent type:** `general-purpose` (it must read, edit, write, run bash,
     use `gh`, **and spawn subagents**).
   - **Model / effort: inherit the main session at EVERY level — never override.**
     When this session calls the Agent tool for an issue-agent, **omit the `model`
     and effort arguments**. **Instruct the issue-agent to do the same** when it
     spawns its own role subagents — omit `model`/effort so the whole tree runs on
     the session's model and reasoning effort. Never pin a cheaper tier anywhere.
   - **Clean context:** each issue-agent is a brand-new Agent call (no SendMessage
     reuse across issues). Pass everything explicitly — it cannot see this
     conversation: issue number, issue body, absolute worktree path, spec path,
     dashboard base path, and these batch rules.
   - **Worktree pin (propagated):** tell the issue-agent **"Work only inside
     `<abs-worktree-path>`; cd into it before any command, and tell every role
     subagent you spawn the same — all file paths are relative to it."**
   - **What the issue-agent orchestrates** (mirroring `/ship-issue`, reading the role
     files in `.claude/agents/` and spawning a subagent for each):
     1. **`spec` subagent** — write `docs/specs/<n>-<slug>.md` (in the worktree), post to issue.
     2. **Auto-approve** — dashboard `approve done --summary "Auto-approved (batch)" --gate none`. Never stop here.
     3. **`coder` subagent** — minimal change for the acceptance criteria; commit in
        the worktree. May **statically** verify SQL/TS but must **not** run
        `supabase db reset` (shared DB — see constraints).
     4. **`tester` subagent** — generate tests; for DB work write migration/contract
        tests but do **not** reset the shared DB. Commit. Open a **draft PR**
        (`gh pr create`) from the worktree branch, linking the issue + spec.
     5. **`reviewer` subagent** — mode `tests` then mode `diff`, posting both on the
        PR; apply the same ≤2-iteration fix loop as `/ship-issue`.
   - **Live dashboard:** the issue-agent drives `docs/ship-issue/<n>-<slug>` (init,
     then each step transition + progress notes) so every issue stays traceable.
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

## Phase 4 — Run the app and prove it works (mandatory)

A batch is **not done** until the integrated app actually runs. After all merges,
from the **main** working tree on updated `main`:

1. **Bring the stack up.** Use the project's own way to run (prefer an existing
   `/run` skill if present; otherwise the Makefile/Supabase path from `AGENTS.md`):
   - `supabase db reset --config supabase/config.toml` — migrations + seed apply clean
     (this already ran per-merge; run once more on the fully-merged main to be sure).
   - `make up` (or `USE_DEV=1 make up`) — Supabase stub + Temporal + frontend.
   - Frontend portal: build it so the merged UI compiles —
     `cd frontend-portal && npm ci && npm run build` (and `npm run dev` if a live
     check is needed).
2. **Smoke-test what was shipped.** For each merged issue, exercise its acceptance
   criteria against the running app — query the new tables/RPCs via `psql`/Studio,
   and load the new screens. Use the **`/verify`** skill if available to drive the
   running app and observe real behavior rather than trusting tests alone.
3. **Report honestly.** If the stack comes up clean and the smoke-tests pass, say so
   plainly. If anything fails — migration error, build break, broken screen, runtime
   error in logs (`make logs`) — **stop, report the exact failure, and do not claim
   success.** Offer to open a follow-up issue or fix it.
4. **Tear down** what you started (`make down`) unless the user wants it left running.

## When you finish

Print a final summary:
- Issues shipped (merged) vs. held, with PR URLs.
- Any issue that stopped at a conflict/validation gate and why.
- The merge order actually executed.
- **Phase 4 result: did the integrated app come up and pass smoke-tests?** State it
  explicitly — green, or the exact failure. Never imply success you didn't observe.
- Links to each issue's dashboard `docs/ship-issue/<n>-<slug>.html`.

## Recovery / re-runs

- `node .github/scripts/ship-batch.mjs list` — see live batch worktrees.
- Re-running `add <issue>` is safe (no-op if the worktree exists).
- `prune --delete-branch --force` — nuke all batch worktrees/branches to start clean.
- The plan is deterministic: regenerate with `plan` anytime; it never edits git state.
