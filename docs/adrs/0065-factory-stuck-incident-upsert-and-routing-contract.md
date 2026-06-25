# ADR-0065: factory-stuck incident upsert and routing contract

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** @copilot, @ianreay
- **Supersedes / Superseded by:** none

## Context

Factory incident filing had no shared policy. Each agent (PM, deploy-sentinel, actions-monitor) embedded its own `gh issue list`/`gh issue create` shell snippets with:

- No deduplication: the same PR-Validation or Temporal-worker-tests failure could open multiple `queue:development` issues per PR, fragmenting the incident backlog.
- Wrong label set: PR-local incidents were filed with only `factory-stuck`, dropping them from the `auto:alert`-based alert/trend routing the trend-analyst and ops-monitor agents depend on.
- No classification policy: whether a CI failure was scoped to one PR or affected all PRs simultaneously was decided ad-hoc inside each agent prompt, producing inconsistent routing.

The PR lane under `.github/agents/` and `.github/tools/shared/` is control-plane: changes to incident classification and routing affect every agent that raises stuck-PR or CI-blocker issues.

## Decision

We introduce a single canonical incident create-or-update path via `incident-upsert-cli.ts`:

1. **Classification** (`classifyIncident` in `incident-upsert.ts`): every incident is classified as either `pr-local` or `shared-cause` before filing. Classification is explicit and testable — not buried in prompt text.
   - `shared-cause`: the blocker can affect multiple PRs simultaneously (identified by `failureClass` in `{ "pr-validation", "temporal-worker-tests", "deploy", "e2e" }`, by known `checkName` values `"PR Validation"` / `"Temporal worker tests"`, or by `fromWorkflowSentinel: true`). Default is `pr-local`.

2. **Routing contract** (exported constants `SHARED_CAUSE_LABELS` / `PR_LOCAL_LABELS`):
   - `shared-cause` → labels `["auto:alert", "queue:platform"]` — never `queue:development`.
   - `pr-local` → labels `["factory-stuck", "auto:alert", "priority:high"]`.

3. **Deduplication**: fingerprint HTML comments (`<!-- fingerprint:<id> -->`) embedded in the issue body are the canonical dedup primitive. Fingerprint shape:
   - `shared-cause`: `shared-cause<12-char-sha256>` keyed on failure-class + scope — no PR number, no run ID.
   - `pr-local`: `factory-stuck-pr-<number>`.
   Dedup survives label/triage drift. The upsert targets the oldest open issue matching the fingerprint to prevent backlog forking.

4. **Runtime CLI** (`incident-upsert-cli.ts`): agents invoke `npx tsx .github/tools/shared/src/incident-upsert-cli.ts` instead of embedding shell snippets. Accepts `--kind pr-local|shared-cause`, `--pr-number`, `--failure-class`, `--scope`, `--title`, `--body`. Reads `GH_TOKEN`/`GITHUB_TOKEN` and `GITHUB_REPOSITORY` from the environment. Outputs `action=created|updated issue=#<N> url=<url> fp=<fingerprint>`.

5. **PM agent wiring**: the PM agent's **Rung-3 terminal escalation** and the **branch-4 `action_required` gate** invoke the CLI directly, replacing the prior manual approach.

## Consequences

- **Easier:** a single call site means label/routing bugs are fixed once and take effect across all callers.
- **Easier:** fingerprint-based dedup prevents backlog flooding when multiple agents or PR sessions observe the same CI failure simultaneously.
- **Easier:** explicit classification makes routing auditable and unit-testable (55 regression tests).
- **Trade-off:** agents that currently embed their own `gh issue` snippets must migrate to the CLI to gain dedup; until migrated they can still create duplicate incidents.
- **Obligation:** every future agent or sentinel that files a stuck-PR or CI-blocker incident must use `incident-upsert-cli.ts` (or import `upsertIncident` directly) — not ad-hoc `gh issue create`.

## Alternatives considered

- **Leave per-agent snippets in place** — rejected; already producing duplicate incidents and wrong label sets in the trend-analyst corpus.
- **A shared shell script wrapper** — rejected; TypeScript gives us testable classification logic, type-safe label constants, and fingerprint generation without additional shell quoting hazards.
- **Single flat `queue:platform` for all incidents** — rejected; PR-local incidents need `factory-stuck` and `priority:high` so the PM escalation ladder and trend-analyst clustering continue to work against the existing label set.

## Evidence

- Helper module: `.github/tools/shared/src/incident-upsert.ts`
- CLI caller: `.github/tools/shared/src/incident-upsert-cli.ts`
- PM agent Rung-3 + branch-4 wiring: `.github/agents/project-manager.agent.md` lines 108–116, 209–222
- Unit tests (55 cases): `.github/tools/shared/src/__tests__/incident-upsert.test.ts`
- PR-state stuck notice: `.github/tools/shared/src/pr-state.ts` (`buildStuckNotice`)
