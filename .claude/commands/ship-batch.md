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

- **One environment only.** Worktrees created under WSL (`/mnt/c/...`) and accessed by
  Windows-native git (`C:\...`) get an unresolvable `.git` pointer and break. Run the
  whole batch from a SINGLE environment (Windows PowerShell here). The script's
  `assertConsistentEnv` guard aborts `plan`/`add` on a flavor mismatch — do not work
  around it; switch environments instead.
- **Never run agents or commands against the main working tree for an issue's
  code.** Every issue's spec→code→tests→review work happens **inside that issue's
  worktree path**. Pass the absolute worktree path to every subagent and tell it to
  `cd` into it before any file edit or command. The subagent runs in an isolated
  context and cannot see this conversation — pass every path explicitly.
- **The local Supabase DB is a single shared stack, and the `supabase` CLI is NOT on
  PATH here.** Validation is done against the live container with
  `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres` (NOT
  `supabase db reset`). **Never run DB-apply in parallel across worktrees.** Agents
  *write* migration SQL freely but validate only by static review; the real DB-apply +
  test run is **serialized** by you at merge time (Phase 3) and integration time
  (Phase 4). Contract tests share one DB — always run them **serially**:
  `node --test --test-concurrency=1 <files>` (a bare `node --test <dir>` mis-handles
  the directory and parallel runs cause false failures).
- **Unique migration timestamps.** Parallel agents otherwise pick the SAME
  `YYYYMMDDHHMMSS` (we hit four `20260625150000` files in one run). Assign each
  DB-touching issue a distinct timestamp up front (see Phase 1) and renumber on the
  rare collision (Phase 3).
- **Don't auto-merge.** The human gives one go-ahead before the merge queue.

## 🪤 Repo-specific gotchas (learned from real runs — read before coding)

- **`rental_entity_type_catalog` is a hard-coded `VALUES` VIEW, not a table.** Every
  entity-CRUD migration does `create or replace view rental_entity_type_catalog as
  select ... from (values ...)`. In a batch, each agent only lists base types + its
  own, so the **last-applied** migration silently DROPS the other batch types — their
  current-state views then return nothing (RPC "succeeds" but rows never appear). For
  any batch that adds ≥1 entity_type, you MUST end Phase 3/4 with ONE reconciliation
  migration (highest timestamp) listing the COMPLETE union of all types.
- **Issue bodies cite stale paths.** Several issues point at the removed `frontend/`
  JSON-engine layout; the real app is **`frontend-portal/`** (React component registry
  under `src/portal/renderers/`, screens in `screens/`, registry in `registry.ts`, nav
  in `portalApi.ts` MOCK_MENU, API helpers in `agentsApi.ts`). Tell agents to discover
  the actual structure, not trust the issue body's paths.
- **Shared-file conflicts are guaranteed** when ≥2 issues touch the frontend:
  `agentsApi.ts`, `registry.ts`, `portalApi.ts`, `seed.sql`, and `frontend-portal/
  package.json` (test-script list) collide on every rebase. Resolve as UNIONS, but
  **dedup helpers two issues created in common** (e.g. both adding `getSalesTrend`) —
  keep one declaration, no duplicate exports/registry keys.
- **Contract-test harness** uses `docker exec ... psql` with BEGIN/ROLLBACK and pure
  `node:test` (no node_modules). A test must have its migration applied to the live DB
  first; renumbering a migration means grepping & updating any test that reads it by
  filename.

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
   - **Assign each DB-touching issue a UNIQUE migration timestamp** and pass it in the
     agent's prompt (e.g. issue N → `202606DDHH<NN>00` where `<NN>` is the issue
     number). This prevents the duplicate-version collision that breaks
     `supabase`/psql apply when several agents independently pick the same stamp.
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
        `supabase db reset`/`psql`-apply (shared DB — see constraints). Tell it: use
        the assigned unique migration timestamp; the real frontend is
        **`frontend-portal/`** (ignore stale `frontend/` paths in the issue body);
        when adding an entity_type, list ALL existing types in
        `rental_entity_type_catalog` (never drop others — see gotchas); a new npm dep
        goes in `frontend-portal/package.json` (lockfile is reconciled at Phase 4).
     4. **`tester` subagent** — generate tests; for DB work write migration/contract
        tests (BEGIN/ROLLBACK via `docker exec ... psql`, like
        `supabase/tests/vehicle_crud.test.mjs`) but do **not** reset the shared DB.
        Commit. Open a **draft PR** (`gh pr create`) from the worktree branch, linking
        the issue + spec.
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
   - Exit code `2` means **conflicts**. **Delegate to a `general-purpose` subagent
     pinned to that worktree** to resolve markers as UNIONS (keep all sides; dedup
     common helpers/registry keys), `git -c core.editor=true rebase --continue` through
     all replayed commits, verify `git grep -nE "^(<<<<<<<|=======|>>>>>>>)"` is empty,
     then `git push --force-with-lease`. Delegating beats hand-editing — conflicts in
     the same shared files recur for every issue. If it can't resolve cleanly, **stop
     and escalate** with the conflicting files. Never force a broken merge.
2. **Renumber on a migration version collision.** If the issue's migration shares its
   `YYYYMMDDHHMMSS` prefix with one already on main, `git mv` it to a unique later
   stamp **and grep+update any test that reads it by filename**, then commit. (Have the
   resolver subagent do this in the same pass.)
3. **Validate against the live DB** (serialized — the one place the shared DB is
   touched; `supabase` CLI is absent, so use psql): apply the issue's new migration(s)
   in order — `Get-Content <migration> -Raw | docker exec -i
   supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1` (expect
   exit 0) — then run its contract tests `node --test --test-concurrency=1
   supabase/tests/<file>`. Must be green. If it fails, stop and escalate.
4. **Merge the PR**: `gh pr merge <pr> --squash --delete-branch`.
   - Right after a `--force-with-lease` push, GitHub may briefly report the PR
     un-mergeable while it recomputes. If merge fails, check
     `gh pr view <pr> --json mergeable,mergeStateStatus` — if `MERGEABLE`, just retry.
   - `gh pr merge` may print a non-fatal "failed to delete local branch ... used by
     worktree" — the merge itself still succeeded (verify `git log origin/main`); the
     worktree-removal in step 6 deletes that branch.
5. **Fetch** updated main (`git fetch origin`) so the next issue rebases onto it.
6. **Clean up the merged worktree — only AFTER the merge succeeded** (removing it
   earlier orphans an in-flight merge):
   `node .github/scripts/ship-batch.mjs rm <issue> --delete-branch --force`.

After the last merge, run `node .github/scripts/ship-batch.mjs prune --force` to
clear any leftover worktrees, and `git worktree prune`.

## Phase 4 — Run the app and prove it works (mandatory)

A batch is **not done** until the integrated app actually runs. After all merges,
update the main working tree (`git checkout main && git pull --ff-only`) and:

1. **Reconcile cross-issue integration FIRST** (the failures live here, not in any
   single PR):
   - **Entity-type catalog:** if the batch added any entity_type, create the
     reconciliation migration (highest timestamp) redefining
     `rental_entity_type_catalog` with the COMPLETE union of all types, and apply it via
     psql. Without this, the last batch migration's view wins and earlier types vanish.
   - **Check for duplicate migration versions:** no two files under
     `supabase/migrations/` may share the `YYYYMMDDHHMMSS` prefix. Renumber if any do.
2. **Validate the whole DB** against the live container (serial): apply any not-yet-
   applied new migrations via `docker exec ... psql -v ON_ERROR_STOP=1`, then run the
   FULL contract suite `node --test --test-concurrency=1 supabase/tests/*.test.mjs`.
   Expect 0 failures. A test that hard-codes "0 rows until #N" is a stale pre-integration
   assumption now that #N is merged — relax it to `count >= 0` (keep column contracts
   strict), don't treat populated views as a regression.
3. **Build the frontend** so the merged UI compiles: `cd frontend-portal`. If `npm ci`
   fails because an agent added a dep without updating the lockfile, run `npm install`
   to reconcile, then `npm run build` (tsc + vite) — must succeed — and `npm test`
   (structural). Commit the reconciliation migration + any test relaxations + the
   updated `package-lock.json` to main and push.
4. **Optionally bring the stack up** (`make up`) and **smoke-test** via the `/verify`
   skill — drive the running screens and query new tables/RPCs. State clearly whether
   you did a live browser smoke-test or only build + contract/structural tests.
5. **Report honestly.** Green only if you observed it. On any failure — migration error,
   build break, broken screen, runtime error in `make logs` — **stop, report the exact
   failure, do not claim success**, and fix it or open a follow-up.
6. **Tear down** only what YOU started (`make down`); if the stack was already running,
   leave it as you found it.

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
