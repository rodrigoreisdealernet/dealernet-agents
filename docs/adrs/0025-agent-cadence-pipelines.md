# ADR-0025: Consolidate agents into staged cadence pipelines

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Factory Architect, Owner (Ian)

## Context

The factory currently runs **11 independent agent workflows**, each on its own
`schedule:` cron plus assorted event triggers:

| Agent | Cron | Events |
|-------|------|--------|
| product-owner, project-manager, qa-manager, security-reviewer, cluster-guardian, database-steward | `0 * * * *` (hourly) | various |
| factory-architect, platform-engineer | `*/30 * * * *` | issues / workflow_run |
| tech-reviewer | `*/15 * * * *` | workflow_run (added in #279) |
| operations-manager | `0 */6 * * *` | — |
| docs-improver | `0 6 * * *` (daily) | — |

This sprawl produced concrete, observed problems (2026-06-07):

1. **GitHub throttles short-interval crons.** The tech-reviewer's `*/15` schedule
   actually fired **~hourly** (11:07, 10:17, 09:20…). Approved/green PRs and
   cancelled-CI reruns therefore waited up to an hour for any agent to act.
2. **Non-deterministic ordering.** Which agent acts in what order is incidental —
   whichever timer happens to fire. Ticket flow through triage → design → assign →
   review → merge is not reproducible.
3. **Concurrency thrash.** Event-driven agents (security-reviewer on every PR/issue,
   factory-architect on every issue) trigger faster than they run; with
   `cancel-in-progress: false` GitHub cancels the superseded *queued* runs — bursts of
   "cancelled" runs that burned cycles without doing work.
4. **Hard to reason about.** Eleven moving parts on five cadences with overlapping
   event triggers is difficult to operate, debug, and predict.

The owner's directive: prefer a system that is **a little slower but much smoother** —
reproducible and calm over maximally-parallel and chaotic.

## Decision

Replace the 11 independently-scheduled agent workflows with **three staged cadence
pipelines**. Each pipeline is a single workflow that runs its agents as an **ordered
sequence of steps** (stages), so ticket flow is deterministic and reproducible.

### 1. Three cadence tiers

| Pipeline | Cadence | Stages (in order) | Purpose |
|----------|---------|-------------------|---------|
| **fast** | every ~5 min (see §2) | enrich/triage (Product Owner) → review (Tech Reviewer) → merge + rerun-cancelled-CI + assign-next (Project Manager) → board sync → *conditional* specialist stages | The value stream: move tickets/PRs through. |
| **hourly** | hourly | Factory Architect (design) → QA Manager → Operations Manager (env/cost/security/backup health) → Cluster Guardian (dia-* namespace health) | Design, quality, **and runtime/ops health** — these need to surface problems within the hour, not once a day. |
| **daily** | daily | Docs Improver → audits / reporting / cleanup | Housekeeping, audits, reporting. |

### 2. Reliable responsiveness via single-pass cadence + CI-completion fast-path

The fast pipeline runs **single-pass scheduled sweeps** (`*/15`) and complements those
with a **`workflow_run` CI-completion fast-path** for `PR Validation` and `Build Images`.
On `workflow_run`, the pipeline runs the PR pipeline stage only and exits; non-PR
`workflow_run` events are explicitly ignored. This removes long-running control-plane
loops while keeping merge/review responsiveness when CI completes.

### 3. Agents become short, single-pass steps

Each agent's entrypoint does **one pass and exits** (triage the queue once, review up to
N PRs once, do one merge/assign sweep). The **pipeline owns the loop**, not each agent.
This is required for stages to compose, and it removes per-agent 55-min internal loops.

### 4. Failure isolation between stages

Each stage is a step with a **per-stage `timeout`** and **`continue-on-error: true`**, so
a hung or failing agent (e.g. the known SDK 300s idle-timeout) does **not** block
downstream stages — review still runs even if triage hiccups; merge still runs even if
review found nothing. Each stage emits a status line to `$GITHUB_STEP_SUMMARY`.

### 5. Keep a small number of event hooks as complements

Pure polling is not enough for the latency-critical path. Retain:
- **review/merge on CI completion** — the `workflow_run: ["Build Images"] completed`
  trigger (already shipped in #279) so a PR is reviewed the moment its CI is green.
- **specialist review on label** — database-steward / platform-engineer / security
  reviewer triggered by their PR labels (or run as the *conditional* fast-pipeline
  stages above). These are naturally event-driven and should stay responsive.

A 5-minute poll floor + these event hooks is the sweet spot.

### 6. Concurrency

The fast pipeline concurrency key includes event + source branch/ref. We enable
`cancel-in-progress` only for `workflow_run` invocations so superseded CI-completion
events collapse quickly, while scheduled/manual sweeps still run to completion.

### 7. Required-check behavior

`PR Validation` uses `cancel-in-progress: false` so required checks are not left in
`cancelled` when rapid push sequences supersede earlier runs.

## Consequences

**Positive**
- Deterministic, reproducible ticket flow (same stages, same order, every tick).
- Short, bounded single-pass runs instead of long control-plane loops.
- CI-completion fast-path handles merge-eligible PRs and cancelled-check reruns quickly.
- Required checks avoid `cancelled` dead-ends on rapid updates.
- One run = one full pass = one log: far easier to operate and debug.

**Negative / trade-offs**
- **Slightly slower per scheduled tick** — stages run sequentially rather than in
  parallel. This is the explicitly-accepted trade ("slower but smoother").
- **Larger blast radius** — a bug in the pipeline harness affects all stages in that
  tier. Mitigated by per-stage `continue-on-error` + keeping agent *logic* modular (the
  pipeline only sequences existing agent entrypoints).
- **Migration risk** — touches the core orchestration. Mitigated by workflow contract
  tests and event-guard assertions.
- **More trigger paths** — schedule + workflow-run behavior requires explicit guards.
  Mitigated by workflow contract tests on trigger surface and PR-only fast-path logic.

## Evidence

- `.github/workflows/pipeline-fast.yml` (single-pass fast pipeline, `workflow_run`
  trigger for `PR Validation`/`Build Images`, PR-only fast-path guard, event-aware
  concurrency).
- `.github/workflows/pr-validation.yml` (`cancel-in-progress: false` for required checks).
- `temporal/tests/test_pipeline_fast_workflow_contract.py`
- `temporal/tests/test_pr_validation_workflow_contract.py`

## Alternatives considered

- **Keep per-agent workflows, only add event triggers** (the #279 approach everywhere).
  Improves responsiveness but does not fix non-determinism or thrash, and leaves 11
  workflows to operate. Partial; this ADR subsumes it.
- **A bare `*/5` consolidated cron.** Rejected — GitHub throttles short crons, so it
  would not deliver reliable 5-min cadence (§2).
- **Fully event-driven, no schedules.** Rejected — some work (sweeps, audits, cleanup of
  stale assignments) is inherently periodic and has no natural triggering event.

## Related

- Reliability epic #142. Supersedes/absorbs the ad-hoc fixes in #280. Builds on #279
  (event-driven tech-reviewer).
