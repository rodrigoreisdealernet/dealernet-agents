# Factory Monitoring Handoff

> **Purpose:** Written for the human owner or an AI agent watching the
> `Volaris-AI/wynne-lvl-3` autonomous software factory. It explains what the
> factory is, how to read its health in 60 seconds, the recurring **and
> structural** failure patterns, and exactly how to unblock each one.
>
> **Companion docs:** [`docs/architecture/ci-cd-pipelines.md`](docs/architecture/ci-cd-pipelines.md)
> is the authoritative map of workflows, gates, and the promotion path. This file
> is the *operational* runbook — what to do when something is stuck.

---

## What this factory is

An **autonomous software factory** that builds an equipment-rental ERP. No human
writes product code day-to-day. A pipeline of role-based AI agents (`.github/agents/*.agent.md`),
driven by GitHub Actions, plus **GitHub Copilot** as the implementation worker:

1. **Product Owner** triages issues → `queue:*` labels
2. **Factory Architect** designs `queue:architecture` work → specs/ADRs + child stories
3. **Project Manager** assigns `ready-for-dev` issues to Copilot
4. **Copilot** opens a PR and pushes commits
5. **Project Manager** (per-PR loop) handles PR mechanics / merge; **Tech Reviewer**
   returns the terminal `queue:review` verdict; specialist lanes (DB / Security /
   Platform) clear their own labels

There are **two clocks** that meet at `main`:

- **Agent clock** — scheduled cadence pipelines (`pipeline-fast/hourly/daily`) that
  *produce* merges.
- **Delivery clock** — event-driven CI/CD (`pr-validation → build-images →
  deploy-dev → e2e-dev`, then manual `deploy-test`/`deploy-prod`) that *consumes* them.

The human owner (Ian) is executive oversight. The monitoring agent (you) is the
executive assistant: keep the pipeline flowing, fix recurring breakage, escalate
only the two genuinely human-gated things (Actions approval setting; prod deploy).

---

## 60-second health check

```bash
# 1. Is the engine actually completing passes? (look for back-to-back `cancelled`)
gh run list --workflow=pipeline-fast.yml --limit 15 \
  --json createdAt,event,status,conclusion \
  --jq '.[] | "\(.createdAt[:16]) \(.event) \(.status)/\(.conclusion)"'

# 2. Open PRs — state, mergeability, labels, age
gh pr list --state open --json number,title,isDraft,mergeable,reviewDecision,labels,createdAt,updatedAt \
  --jq '.[] | "#\(.number) draft=\(.isDraft) merge=\(.mergeable) rev=\(.reviewDecision) age=\(.createdAt[:16]) [\(.labels|map(.name)|join(","))] \(.title[:45])"'

# 3. Ready work waiting on assignment
gh issue list --state open --label "queue:development" --label "ready-for-dev" \
  --json number,title,assignees --jq '.[] | "#\(.number) [\(.assignees|map(.login)|join(","))] \(.title[:55])"'
```

**Act on anything stuck > 30 min.** The fastest tells of trouble:
- a string of `cancelled` `pipeline-fast` runs (engine is starving itself — see §A);
- a PR carrying `queue:architecture`/`needs-design` (deadlock void — see §B);
- a PR `mergeable=MERGEABLE` + CI green + APPROVED that hasn't merged.

---

## Pipeline flow (happy path)

```
Issue → Product Owner labels queue:architecture|queue:development
  → (architecture) Factory Architect designs → ready-for-dev
  → Project Manager assigns Copilot (GraphQL; max_open_copilot_prs=8)
  → Copilot opens draft PR, pushes commits
  → pr-validation + pr-enrichment run (checks + risk/lane labels)
  → Project Manager (per-PR loop): ready the draft / clear CI mechanics / route
       substantive review to Tech Reviewer via queue:review
  → Tech Reviewer / specialist lanes: terminal review verdict
  → Project Manager: APPROVED + green + MERGEABLE + no open lane → squash-merge, delete branch
  → "Fixes #N" closes the issue
  → build-images → deploy-dev → e2e-dev smoke
```

`project-manager` now runs **once per open PR, oldest-first** inside
`run-pr-pipeline.ts`; a short assignment session follows after the per-PR loop. The
Tech Reviewer is the active `queue:review` escalation reviewer and returns the
terminal verdict the Project Manager consumes to merge.

## Runtime monitoring coverage (public vs private lanes)

`pipeline-hourly.yml` is split into explicit lanes:

- **Public lane (`ubuntu-latest`)**: Factory Architect → QA Manager → `operations-manager` with `OPS_CHECK_SCOPE=public`.
- **Private lane (self-hosted/private-access runner)**: `operations-manager` with `OPS_CHECK_SCOPE=private` → `cluster-guardian` (read-only `wynne-*`).

### What is **not** monitored when private lane is degraded

If private prerequisites are missing, the hourly workflow now fails with an explicit
**degraded monitoring** result. In that state, the following checks are **not**
executing:
- private AKS/runtime health checks,
- cert-expiry and secret-expiry checks,
- backup-evidence validation,
- in-cluster `cluster-guardian` namespace health inspection.

Treat any degraded private-lane run as an incident/unblock item, not a healthy pass.

---

## ⚠️ Structural problems to watch (root-cause, not flakes)

Design-level issues found in the 2026-06-08 audit.

### A. `pipeline-fast` self-cancellation — ✅ RESOLVED 2026-06-08 (#704 → #705)

**What it was:** `pipeline-fast` had a `workflow_run` trigger (`PR Validation` /
`Build Images`) with `cancel-in-progress: true`. Every CI completion fired it, and
under a merge/CI flurry the completions arrived faster than a per-PR pass could
finish — so each new run **cancelled the in-flight review loop** before it reached
the newer PRs. **20 of 30 runs were cancelled (69%); only 1 of 30 was the cron.**

**Fix (merged in #705):** `pipeline-fast` is now **timer-only** — `*/15` cron +
`workflow_dispatch`, a **single concurrency group**, `cancel-in-progress: false`
(scheduled runs queue instead of cancelling each other), and a **60-minute
self-terminate**. The full sweep (triage → PR loop → specialist lanes) runs on every
pass. Contract enforced by `temporal/tests/test_pipeline_fast_workflow_contract.py`.

**Consequence to watch:** with the event safety-net gone, queue management rides on
the `*/15` cron (GitHub throttles it under load) + manual dispatch. To process PRs
promptly between cron ticks — or right now — just dispatch a pass:
```bash
gh workflow run pipeline-fast.yml
```
**Regression signal:** if you see `cancelled` `pipeline-fast` runs or any
`workflow_run`-triggered run again, the trigger was reintroduced — that's a
regression, not normal. Shorten the cron (`*/10`) instead of re-adding events.

### B. PRs labeled `queue:architecture` / `needs-design` deadlock forever

**Symptom:** A non-draft, `MERGEABLE` PR sits for hours/days with `queue:architecture`
+ `needs-design` and **no reviews** (live example: #654/#658/#659, open 2h+ and never
moving — they also burn 3 of 8 Copilot slots).

**Cause (historical / regression to watch for):** the old per-PR persona deferred
`needs-design`/`queue:architecture` PRs to the **Factory Architect**, but that lane
services *issues only*, not PRs, so the PR dead-lettered forever. The upstream trigger
was design-stage issues being assigned to Copilot while still carrying `needs-design`.
The current Project Manager + Tech Reviewer contracts explicitly forbid this, so if it
reappears treat it as prompt/runtime drift.

**Manual unblock (now):** the PR exists, so the design phase is moot — review it like
any other PR. Strip the void labels and route it to normal review. **Use the REST
labels API, not `gh pr edit`** — `gh pr edit` currently fails with a Projects-classic
GraphQL deprecation error:
```bash
REPO=Volaris-AI/wynne-lvl-3
gh api -X DELETE "repos/$REPO/issues/<pr-number>/labels/queue:architecture"
gh api -X DELETE "repos/$REPO/issues/<pr-number>/labels/needs-design"
gh api -X POST   "repos/$REPO/issues/<pr-number>/labels" -f 'labels[]=queue:review'
# also clean the originating issue so it stops looking un-designed:
gh api -X DELETE "repos/$REPO/issues/<linked-issue>/labels/needs-design"
gh api -X DELETE "repos/$REPO/issues/<linked-issue>/labels/queue:architecture"
```
(Done for the live cases #654/#658/#659 + issues #587/#588/#593 on 2026-06-08.)

**Fix (landed):** Project Manager now owns the per-PR loop, Tech Reviewer is the
active `queue:review` escalation reviewer, and PM never assigns Copilot an issue
carrying `needs-design` / `design-in-progress`. Database Steward and Platform Engineer
carry the same PR-lane void-guards.

---

## Recurring failure patterns (operational)

### 0. Copilot PR CI stuck at `action_required`

**Symptom:** Every Copilot-authored PR shows checks with `conclusion=action_required`;
workflows never execute, PRs sit for hours.

**Cause:** The triggering actor is `Copilot` (no write access). On a private repo the
fork-PR `/approve` path returns 403, and `gh run rerun` **re-queues under Copilot and
bounces back to `action_required`** (busy-loop). The gate is **actor-based**.

**Remedy (automated in the Project Manager per-PR loop) — re-trigger as a trusted actor:**
```bash
gh pr update-branch <number>            # preferred: also rebases onto current main
# if "already up to date":
gh pr checkout <number> && git commit --allow-empty -m "ci: re-trigger validation (trusted actor)" && git push
```
If it **still** gates after a trusted re-trigger, treat it as a **settings regression**
(repo Actions approval) — **human only**: Settings → Actions → General → don't require
approval for Copilot/bot PRs. Agents raise a single deduped `auto:alert` incident
(fingerprint `ci-action-required-gate`). A one-time `gh run rerun` can be used only to verify
the gate is actor-based; do **not** burn time on repeated reruns.

### 1. Cancelled CI runs on a PR branch

**Symptom:** A PR check shows `cancelled`/empty; review can't proceed.

**Cause:** Copilot pushes commits rapidly; `cancel-in-progress: true` in
`pr-validation.yml` cancels the older run.

**Fix:**
```bash
BRANCH=$(gh pr view <number> --json headRefName --jq '.headRefName')
gh run list --branch "$BRANCH" --status cancelled --limit 3 --json databaseId --jq '.[].databaseId' \
  | xargs -r -I{} gh run rerun {}
```

### 2. Merge conflicts between concurrent PRs

**Symptom:** `mergeable=CONFLICTING` after another PR merged.

**Fix (preferred):** Copilot has git tools — nudge **once** to resolve in place:
```bash
gh pr comment <number> --body "@copilot Please rebase on main and resolve all conflicts before pushing. Do not expand scope."
```
**Re-kick (close + reassign from a fresh base checkout) only** on branch contamination
(dirty-tree / cross-scope file bleed), or if Copilot pushed and it is *still*
`CONFLICTING`. Do **not** use the rebase flow above on a contaminated branch — close it
and reassign from a clean slate.

### 3. Python build artifacts committed

**Symptom:** review flags `__pycache__`/`.pyc` in the PR.

**Fix:**
```bash
git fetch origin <branch> && git checkout -b fix-artifacts origin/<branch>
git ls-files | grep -E "(__pycache__|\.pyc|\.pyo|\.egg-info)" | xargs -r git rm --cached -q
git commit -m "chore: remove Python build artifacts"
git push origin fix-artifacts:<branch> --force-with-lease
git checkout main && git branch -D fix-artifacts
```

### 4. `changes-requested` PR not progressing

**Decision rule (what the PM + Tech Reviewer path does):**
- **Review newer than last commit** → unaddressed → one `@copilot` nudge, then wait.
- **New commits since the review** → Copilot responded → ensure `queue:review` is set
  so Tech Reviewer **re-reviews now** to a terminal verdict.

If a PR sits in `changes-requested` with no new commit, Copilot hasn't woken. Confirm
the nudge `@copilot`-mentions it (a plain review comment may not wake the agent):
```bash
gh pr view <number> --json reviews --jq '.reviews[-1] | "[\(.state)] \(.body[:300])"'
```

### 5. PM not assigning new work

**Cause A:** at `max_open_copilot_prs: 8` (count open Copilot PRs first — note that
deadlocked PRs from §B count against this).
**Cause B:** `gh issue edit --add-assignee` doesn't work for the bot — must use the
GraphQL `addAssigneesToAssignable` mutation with `agentAssignment` (see
`project-manager.agent.md`).

### 6. Deploy looks stale / dev app blank

Usually a **failing deploy**, not the app. `deploy-dev` triggers a `deploy-sentinel`
incident on failure (`monitor-deploy.yml`). Check:
```bash
gh run list --workflow=deploy-dev.yml --limit 5 --json createdAt,status,conclusion
```

### 7. PAT-authored PR never gets approved (self-approval deadlock)

**Symptom:** a PR authored by the factory's own PAT identity (e.g. `ianreay` — agent
work pushed on the owner's behalf) sits green + mergeable for many hours while the
Tech Reviewer posts repeated "approve-ready / merge-ready" *comments* but never a
formal `APPROVED` review (live example: #1192, 23 h, five identical verdicts).

**Cause:** the Tech Reviewer runs under the same PAT — GitHub forbids approving your
own PR, so `reviewDecision` can never reach `APPROVED` and the PM's merge gate never
opens.

**Remedy (automated 2026-06-12):** the Tech Reviewer's terminal verdict on
self-authored PRs is the **`tech-approved` label** (+ one verdict comment); the PM and
the orchestrator's merge-ready ordering treat that label exactly like a formal
approval. If you see the comment-loop symptom again, the fallback regressed — apply
`tech-approved` manually (REST labels API) or merge directly:
`gh pr merge <number> --squash --delete-branch`.

### 8. ADR number collisions between concurrent PRs

**Symptom:** a stuck/slow PR goes `CONFLICTING` on `docs/adrs/README.md`, or two
ADR files ship with the same number prefix (two `0040-*` files exist on `main`; three
open PRs all claimed `0045` on 2026-06-12).

**Cause:** concurrent Copilot PRs each pick "next free number" from `main` at branch
time; whichever merges second conflicts (best case) or ships a duplicate (worst case).

**Fix when resolving:** renumber the *unmerged* PR's ADR above both `main` AND every
number claimed by open PRs
(`gh pr list --state open --json files --jq '.[].files[].path | select(test("docs/adrs/"))'`),
update the heading inside the file + the README row, then merge as normal.
`copilot-instructions.md` now tells Copilot to check open PRs when numbering.

### 9. Shared-file overlap between concurrent open PRs (`shared-file-overlap` label)

> **Guardrail for issue #58.** Implemented in pr-enrichment as of ADR-0101.

**Symptom:** A PR carries the `shared-file-overlap` label and the Project Manager
refuses to merge it. Or you notice two open PRs editing the same file path (control-plane
file, migration, worker source, etc.).

**Cause:** Two branches started from divergent bases and independently edited the same
file. When the later one merges, it overwrites the earlier merge's changes, potentially
breaking `main` even though each PR's own CI was green.

**How the guardrail works:**
- On every `pull_request` event (opened / synchronize / reopened), `pr-enrichment`
  fetches the file list of every other open PR and checks for exact path overlap with
  the current PR's changed files.
- If overlap is found: the `shared-file-overlap` label is applied and the PR enrichment
  step summary lists the overlapping PRs and shared files.
- If overlap is gone (sibling merged + branch rebased): the label is automatically
  removed on the next `synchronize` event.
- The Project Manager treats `shared-file-overlap` as a **blocking gate** — it will
  not merge a PR carrying this label.

**Operator response path:**

```bash
# 1. Find the overlapping PRs
gh pr list --state open --label "shared-file-overlap" --json number,title,files

# 2. Decide merge order — pick the foundational change first (interface before
#    consumer, migration before worker, etc.)

# 3. Unlock the first PR to merge
gh api -X DELETE repos/Volaris-AI/wynne-lvl-3/issues/<first-number>/labels/shared-file-overlap

# 4. Let it merge, then rebase the second PR to auto-clear its label
gh pr update-branch <second-number>
# pr-enrichment re-runs on the synchronize event; if the sibling has merged, the
# label is removed and the PM can proceed with the second PR.
```

**If the two PRs are logically independent** (same file, non-conflicting edits that
will merge cleanly): remove `shared-file-overlap` from both, comment the rationale
("changes are independent: A adds X, B adds Y, no semantic conflict"), and let them
merge in creation order.

**If the overlap is a genuine logical conflict** (each change would break the other's
intent): collapse both PRs into one, close the second, and resolve the conflict in the
surviving branch.

**The guardrail does NOT catch:** post-merge breakage if the second PR was never
rebased after the first merged (the `synchronize` event only fires on a push to the
branch). The Project Manager's `gh pr update-branch` call before merging usually
triggers re-evaluation, but if the PM skips that step the second PR may land without
a fresh overlap check. Human or Platform Engineer review of `shared-file-overlap` PRs
before sequencing is the backstop for this edge case.

---

## Key IDs and constants

| Item | Value |
|------|-------|
| Copilot bot ID | `BOT_kgDOC9w8XQ` |
| Repository node ID | `R_kgDOSx5OCA` |
| Max concurrent Copilot PRs | `8` (`.github/factory.yml`) |
| Engine | `pipeline-fast.yml` — `*/15` cron + `workflow_dispatch` (timer-only; `workflow_run` trigger removed 2026-06-08 #705). `pr-loop.yml` — `*/30` cron + `workflow_run` on Build Images completion (event-driven since 2026-06-12; safe because its group queues instead of cancelling). **Real cron cadence under load is ~60-100 min, not the nominal interval** — GitHub throttles short crons; the event triggers, not the crons, keep merge latency low. |
| Hourly agents | `pipeline-hourly.yml` — `:30` (public lane: Architect → QA → Ops/public; private lane: preflight → Ops/private → Cluster Guardian) |
| Daily agents | `pipeline-daily.yml` — `06:00` (Docs Improver → User Docs Manager → **release-notes pipeline**: Release Notes Curator → Release Marketer → publish nightly release-notes PR (`docs/release-notes/README.md`) → Trend Analyst → **discovery pipeline**: Market Scout → Product Strategist → Discovery Critic → publish nightly discovery PR (`docs/discovery/README.md`)) |
| Weekly agents | `pipeline-weekly.yml` — **TEMP daily `07:00`** (bootstrap; revert cron to `0 7 * * 0`). Agentic Reflector → charter PR; Domain Cartographer → reconcile (feedback loop) → operating-model PR → epics-sync (one epic/role into `queue:product`, the ticket bridge). Maps "what it takes to run an X" in `docs/discovery/domain/`; all propose, humans dispose. |
| Monitors | `monitor-actions.yml` (`*/15`), `monitor-deploy.yml` (on deploy/E2E failure) |
| Token | `PROJECT_MANAGER_PAT` (trusted actor / `gh`), `COPILOT_TOKEN` (Copilot SDK) |

> **Note:** most per-agent `agent-*.yml` workflows were retired; agents run as stages
> inside the three `pipeline-*.yml` files plus `pr-loop.yml`. Two exceptions are live:
> `agent-tech-reviewer.yml` (event-driven on Build Images completion — this is what
> makes approvals land minutes after CI goes green) and `agent-cluster-guardian.yml`.

---

## What stays human-gated

The factory ships product code autonomously, including control-plane PRs once the
owning review lane reaches a terminal decision. The remaining human-only gates are
the repo Actions approval setting (when bot PR CI is stuck at `action_required`) and
**promotion past dev** — both **UAT** (`deploy-test`, `test` environment) and **prod**
(`deploy-prod`, `prod` environment) require a protected-environment reviewer, and you
promote a **known-good `sha`** (from the `releases-ledger` branch), not the head of main.
See the [promotion runbook](docs/runbooks/promotion.md) and
[ADR-0062](docs/adrs/0062-gated-promotion-known-good-digest-per-env-data-isolation.md).
(The `test` environment needs its required reviewers configured once — see the runbook.)

### `needs-platform-review` — Platform Engineer specialist lane

`needs-platform-review` is a **blocking specialist lane** applied by `pr-enrichment` for
scope anomalies as a reviewer heads-up (e.g. infra / CODEOWNERS path changes). It is
**not a human gate**: `pipeline-fast` conditionally runs the **Platform Engineer agent**
whenever this label is present; the agent reviews, removes `needs-platform-review`, and
adds `platform-reviewed` when the concern is resolved. Project Manager will not merge a PR
carrying `needs-platform-review` until the lane is cleared by the agent (or, in an
unblock scenario, by a human removing the label manually).

The actual human-only gates are the **CODEOWNERS boundary** (`/.github/`, `/docs/adrs/`,
`/deploy/k8s/`) and **prod deploy approval** (protected environment — see above).

### Applied migration edit guardrail (`supabase/migrations/**`)

`pr-enrichment` now classifies migration files by GitHub file status, not just path:

- **`added` migration files** are treated as normal additive DB work (route to `needs-database-review` unless already cleared).
- **non-`added` migration files** (`modified`, `renamed`, etc.) are treated as an
  **applied-migration-edit violation**:
  - add `needs-database-review`
  - remove stale `database-reviewed` so the Database Steward lane re-opens
  - emit an explicit "applied-migration edit detected" finding in the enrichment summary

Operator response path:
1. Database Steward is the terminal reviewer for this lane.
2. Do not merge while `needs-database-review` is present.
3. Remediate with additive follow-up migrations only (never by editing shipped migrations in place).

Historical issue #74 audit result: the original drift was that maintenance/inspection
catalog entries were introduced by editing an already-applied migration, which would
not backfill already-migrated environments.

That maintenance/inspection drift from
`20260605154500_rental_master_data_foundation.sql` is already reconciled on the
already-migrated path by additive catalog-reconciliation migrations
`20260610000001_fix_entity_catalog_and_schedule_join.sql` and
`20260610010001_reconcile_catalogs_and_portal_schedule.sql` (including
`maintenance_record`/`inspection` entity and relationship catalog entries), so no
new repair migration is required.

---

## Useful commands

```bash
# Full open-PR status (one line each)
gh pr list --state open --json number,title,isDraft,mergeable,reviewDecision,labels,updatedAt \
  --jq '.[] | "#\(.number) draft=\(.isDraft) merge=\(.mergeable) rev=\(.reviewDecision) up=\(.updatedAt[:16]) [\(.labels|map(.name)|join(","))] \(.title[:50])"'

# Force a clean engine pass (won't be cancelled by the workflow_run group)
gh workflow run pipeline-fast.yml

# Re-trigger a Copilot PR's CI as the trusted actor (clears action_required)
gh pr update-branch <number>

# Merge an approved PR
gh pr merge <number> --squash --delete-branch
```
