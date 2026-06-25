# ADR-0101: Shared-file overlap detection in pr-enrichment as concurrent-PR drift guardrail

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Factory (Platform Engineer lane), Copilot, @ianreay
- **Supersedes / Superseded by:** none

## Context

`main` has been broken twice by concurrent Copilot PRs editing the same shared file
from divergent bases (issue #57 root cause; issue #58 tracking). Each PR's CI was
green against its own base; the later merge silently clobbered the earlier one's
symbols, leaving orphaned imports and a red test suite that no single PR's CI could
catch. With `max_open_copilot_prs: 8` and PRs frequently touching hot shared surfaces
(`temporal/src/**`, `supabase/migrations/`, `.github/workflows/pr-validation.yml`,
`frontend/e2e/**`), this is a structural risk, not a one-off.

The four candidate guardrails evaluated were:
1. **Require branches up-to-date before merge** (branch protection setting) — strongest
   technical barrier but requires a GitHub repository settings change that is human-only
   and cannot be applied via code. Rejected as the *sole* mitigation; retains value as
   a future complement.
2. **Post-merge CI on `main`** — already implemented (pr-validation runs on
   `push` to `main`). Catches breakage quickly but does not prevent the clobber;
   it turns silent breakage into noisy breakage after the fact.
3. **Reduce `max_open_copilot_prs`** when >1 open PR touches the same top-level shared
   dir — reduces probability but doesn't eliminate the risk; adds friction to all work.
4. **Overlap detection in pr-enrichment + merge blocking label** — detects the exact
   collision shape, labels both affected PRs, and prevents the PM from merging until
   a human or Platform Engineer sequences them. Implementable entirely in code.
   **Selected.**

Option 4 is chosen because it targets the exact failure mode (same-file concurrent
edits) without restricting the overall PR rate, is entirely code-side, and self-heals
(the label auto-clears when the sibling merges and the branch rebases).

## Decision

We extend `pr-enrichment.yml` with a shared-file overlap detection step. On every
`pull_request` event the step:

1. Fetches the changed-file list for every other open PR (up to 100; pagination not
   required at current factory scale).
2. Intersects that list with the current PR's changed files.
3. If any overlap is found: applies the `shared-file-overlap` label.
4. If no overlap is found (or a previous overlap has resolved): removes the
   `shared-file-overlap` label.

The Project Manager agent treats `shared-file-overlap` as a **blocking gate** — it
will not merge a PR carrying this label. The Platform Engineer agent is responsible
for sequencing overlapping PRs: removing the label from the PR that should merge first,
then instructing the PM to rebase the second PR so pr-enrichment re-evaluates it.

## Consequences

**Becomes easier:**
- Concurrent-PR same-file drift is detected automatically on every push event, not
  by manual observation.
- The PM cannot accidentally merge an overlapping PR; the overlap must be explicitly
  resolved first.
- After the first PR merges, the second PR's label self-clears when the PM calls
  `gh pr update-branch` (which triggers a `synchronize` event and re-runs enrichment).

**Becomes harder / new obligations:**
- pr-enrichment now makes up to N additional API calls (one `pulls.listFiles` per open
  PR) on every event. At `max_open_copilot_prs: 8` the overhead is ~8 extra calls;
  acceptable at current scale.
- The Platform Engineer must service `shared-file-overlap` PRs in its discovery loop
  (added to the `gh pr list` discovery command).
- The label must be bootstrapped with `scripts/bootstrap-labels.sh` on first deploy to
  a new repository instance.

**Edge cases accepted:**
- The overlap check only covers the first 100 files of each PR (GitHub `listFiles`
  default). PRs with >100 changed files may miss overlaps in the tail. At current
  factory change-set sizes this is not a material risk.
- The label only auto-clears on a `synchronize` event for the current PR. If the
  sibling merges but this PR receives no push, the label persists until the PM calls
  `gh pr update-branch`. This is acceptable: the PM already calls `update-branch`
  before merging, which triggers the re-evaluation.
- This guardrail does not prevent the breakage if both PRs are somehow merged without
  any `synchronize` event after the first merge. Branch protection "require branches
  up-to-date" (option 1) remains the stronger long-term complement for critical paths.

## Alternatives considered

- **Branch protection `require_branches_to_be_up_to_date`:** Strongest technical
  barrier; forces the second PR to rebase and re-run CI. Rejected as the sole
  mitigation because it requires a human to change repository settings, cannot be
  applied in code, and is blocked by the same Actions approval constraints that already
  slow the factory. It remains the recommended follow-up for control-plane files.
- **Reduce `max_open_copilot_prs`:** Reduces the *probability* of overlap but does not
  eliminate it — two PRs touching the same file is possible at any concurrency level.
  Adds blanket friction to work unrelated to the overlapping files.
- **Post-merge main CI only (option 2):** Already in place and retained. It converts
  silent breakage into noisy breakage, but does not prevent the clobber or slow the
  factory while an overlap exists.

## Evidence

- Issue #58: recurring shared-file drift root cause tracker with 20+ platform evidence
  updates confirming the ongoing collision pattern.
- Issue #57: the original `main` breakage (PR #29 + PR #30 both rewrote
  `temporal/src/models/rental.py`; the second merge left orphaned imports).
- Changed files:
  - `.github/workflows/pr-enrichment.yml` — overlap detection step + label logic
  - `.github/agents/project-manager.agent.md` — `shared-file-overlap` blocking gate
  - `.github/agents/platform-engineer.agent.md` — sequencing instructions + discovery command
  - `scripts/bootstrap-labels.sh` — new `shared-file-overlap` label
  - `MONITORING.md` — section 9 operator runbook for the guardrail
