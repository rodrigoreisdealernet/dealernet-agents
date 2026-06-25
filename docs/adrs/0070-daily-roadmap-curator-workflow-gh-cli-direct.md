# ADR-0070: Daily roadmap-curator workflow uses gh CLI directly (no wrapper script)

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** Repository owner (PR #1667)
- **Supersedes / Superseded by:** Supersedes the tooling clause of ADR-0030 (linking via `scripts/project-sync.sh`); the three-level hierarchy decision in ADR-0030 is unchanged.

## Context

ADR-0030 recorded that sub-issue links for the Initiative → Epic → Story hierarchy were created
via `scripts/project-sync.sh parent <child> <parent>`. The wrapper script was a convenience shim
around the `addSubIssue` GraphQL mutation; it was not tested for the full breadth of board
operations (field edits, off-board issue addition, initiative/epic creation) and added an
indirection that made agent instructions harder to read and maintain.

Separately, the project board (org Project #15, ~450 open issues) had accumulated a large backlog
of orphan stories and epics that were not corrected by agent grooming runs alone. A dedicated
autonomous sweep was needed to converge the board toward the three-level hierarchy daily, with
enough time budget (up to 30 min) to handle the GraphQL sub-issue work at scale.

## Decision

1. **Remove `scripts/project-sync.sh`** and all references to it. All board operations — adding
   issues to the project, editing single-select fields, and linking sub-issues — are performed
   **directly via the `gh` CLI** (`gh project item-add`, `gh project item-edit`, and
   `gh api graphql` for the `addSubIssue` mutation). Canonical recipes live in
   [`docs/runbooks/project-board-ops.md`](../runbooks/project-board-ops.md).

2. **Add a standalone daily workflow** (`.github/workflows/roadmap-curation.yml`, cron `30 3 * * *`)
   that runs the `roadmap-curator` agent to sweep Project #15: attach orphan epics to initiatives,
   attach orphan stories to epics, create initiatives/epics when no fit exists (capped at ~6 new
   issues per run), and add off-board issues. The workflow runs separately from `pipeline-daily`
   to preserve its own time budget (40-minute job limit; 35-minute curate step covering the
   30-minute agent Phase 1 + 3-minute Phase 2 summary + 2 minutes of margin). A preflight step
   fails hard when `COPILOT_TOKEN` is absent (preventing a silent exit-0 skip), and a fail-gate
   step (`exit 1`) follows the summary step so broken sweeps surface in
   `gh run list --status failure`.

### Token/permission boundary

| Token | Secret | Scope |
|---|---|---|
| `COPILOT_TOKEN` | `secrets.COPILOT_TOKEN` | Copilot SDK agent session (read-only repo context, model calls) |
| `PROJECT_MANAGER_PAT` | `secrets.PROJECT_MANAGER_PAT` | `project` (read/write org Project V2) + `issues` (create/edit issues in the repo) |

The workflow-level `permissions` block is `contents: read` (checkout only). No `GITHUB_TOKEN`
write permissions are granted; all mutating calls go through `GH_TOKEN` set to the PAT above.
The PAT is scoped to project + issues only — no code push, secrets, or admin surface.

### Mutation scope (what the agent is permitted to do)

- **Read:** all open issues in `Volaris-AI/wynne-lvl-3`, all items in org Project #15.
- **Write — issues:** create `Initiative:` and `Epic:` issues in the repo (capped ~6/run).
- **Write — project:** add issues to Project #15 (`gh project item-add`), set single-select
  fields (`Status: Triage`, `Queue Owner`, `Phase`, `Risk`) on newly added items.
- **Write — hierarchy:** attach sub-issues via `addSubIssue` GraphQL mutation (idempotent; a
  repeated call for an existing link is a no-op).
- **Out of scope:** no code commits, no PR creation, no label changes, no issue closure, no
  project field deletion, no admin or environment secrets access.

## Consequences

- Board hierarchy converges autonomously each night; human/PO intervention is reserved for
  genuinely ambiguous orphans flagged in the run summary.
- No wrapper script to maintain or version; agents read the runbook recipes directly.
- Two secrets must exist in the repository: `COPILOT_TOKEN` (Copilot SDK) and
  `PROJECT_MANAGER_PAT` (`project` + `issues` scope). A preflight step in the workflow
  validates `COPILOT_TOKEN` before the curate step runs — a missing token causes an explicit
  `exit 1` rather than a silent exit-0 skip, so absent secrets always surface in
  `gh run list --status failure`.
- The curate step's `timeout-minutes: 35` covers the 30-minute agent Phase 1 and the
  3-minute Phase 2 summary with 2 minutes of margin; the job's `timeout-minutes: 40`
  covers setup, curate, summary, and fail-gate steps end-to-end.
- The workflow is idempotent: re-running after a partial failure is safe.

## Rollback

1. **Disable the workflow** via the GitHub UI ("Actions → Roadmap curation (daily) → Disable
   workflow") to stop future runs immediately — no code change required.
2. Any `Initiative:` or `Epic:` issues created by the agent can be closed individually; sub-issue
   links can be removed via the GitHub UI or `removeSubIssue` mutation.
3. To restore `scripts/project-sync.sh`: revert commit `f02aae8` on a new branch, reinstate the
   `project-sync` references in agent instructions, and open a PR.

## Alternatives considered

- **Keep `scripts/project-sync.sh` and extend it:** rejected — it only covered the `parent`
  subcommand; all other board operations (field edits, item-add, issue creation) would have needed
  new subcommands, increasing maintenance surface without benefit over the `gh` CLI.
- **Run the curator inside `pipeline-daily`:** rejected — the daily pipeline is already packed and
  the sub-issue GraphQL work for ~450 issues needs up to 30 minutes, which would make the whole
  pipeline time out.
- **GitHub Action + Octokit script instead of a Copilot agent:** rejected — the board sweep
  requires natural-language judgment (best-fit initiative/epic matching); a deterministic script
  would either force-fit or skip, both undesirable.

## Evidence

- Workflow: `.github/workflows/roadmap-curation.yml`
- Agent: `.github/agents/roadmap-curator.agent.md`
- `gh` recipes: `docs/runbooks/project-board-ops.md`
- PR: #1667 (adds workflow + agent, removes `scripts/project-sync.sh`)
- Original hierarchy ADR: `docs/adrs/0030-project-plan-initiative-epic-story-hierarchy.md`
