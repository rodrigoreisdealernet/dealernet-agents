# Runbook: Factory CI / PR validation reliability

Triage and remediation guide for the recurring shared CI / PR-validation failures tracked
under epic [#1537](https://github.com/Volaris-AI/dia/issues/1537).  Use this
runbook when a CI incident affects multiple open PRs or recurs on `main` rather than being
specific to a single PR author's change.

Related ADRs: [ADR-0071](../adrs/0071-trusted-pr-temporal-fail-fast-timeout-and-diagnostics.md) ·
[ADR-0073](../adrs/0073-temporal-worker-tests-timeout-bound-and-reset-retry.md) ·
[ADR-0075](../adrs/0075-supabase-reset-path-ci-job-timeout-guard.md) ·
[ADR-0066](../adrs/0066-temporal-reset-smoke-validation-path-scoping.md)

---

## Quick incident triage matrix

| Symptom | Workflow | Failing job/step | Owner | Fix path |
|---------|----------|-----------------|-------|----------|
| PR Validation shows `action_required`, zero jobs materialise | `pr-validation.yml` | *(none)* | Maintainer | [§1 Action-required approval-path regression](#1-action_required-with-zero-jobs-same-repo-copilot-prs) |
| Deploy Dev fails at *Apply Supabase migrations + demo seed* | `deploy-dev.yml` | `Bootstrap Supabase DB` | Platform | [§2 Bootstrap ConfigMap size](#2-bootstrap-configmap-exceeds-1-mib) |
| E2E fails at *Require fixture-seeding credentials* | `e2e-dev.yml` | `Playwright smoke vs dev` | Ops | [§3 Missing E2E service-key](#3-missing-e2e-fixture-seeding-credentials) |
| Hourly pipeline fails at *Fail with explicit degraded-monitoring status* | `pipeline-hourly.yml` | `private_lane_degraded` | Ops | [§4 Private-lane runner not registered](#4-private_lane_degraded--runner-not-registered) |
| Monitor-Deploy times out at *Run Deploy Sentinel agent* | `monitor-deploy.yml` | `sentinel` | Platform | [§5 Deploy sentinel timeout](#5-deploy-sentinel-timeout) |
| Nightly code-quality fails at *github/codeql-action/analyze@v3* | `code-quality.yml` | `codeql` | Platform | [§6 CodeQL analysis failures](#6-codeql-analysis-failures) |

---

## 1. `action_required` with zero jobs (same-repo Copilot PRs)

**Symptom.** A `PR Validation` run shows status `action_required` and conclusion
`action_required` with zero jobs materialising.  This blocks all open PRs that depend on
the required check converging.

**Cause.** GitHub Actions requires manual workflow approval before it will run the
`pull_request` event for certain PRs.  For same-repo Copilot PRs this is a repository
or organisation setting regression, not a problem with the workflow file itself.

**Evidence gathering.**
```bash
# List recent action_required runs for pr-validation
gh run list --workflow pr-validation.yml --json databaseId,status,conclusion,headBranch \
  --jq '.[] | select(.conclusion=="action_required")'

# Find blocked run IDs for a specific PR
gh run list --pr <number> --json databaseId,status,conclusion,name
```

**Resolution (maintainer action required).**
1. A repo admin must review GitHub repository **Settings → Actions → General**.
2. Under *"Fork pull request workflows from outside collaborators"*, verify the approval
   requirement is set to *"Require approval for first-time contributors who are new to
   GitHub"* (the default), not *"Require approval for all outside collaborators"* or
   *"Required for all workflows"*.
3. Once the setting is corrected, attempt one `gh run rerun` to verify the runs
   materialise normally.  `POST /repos/.../actions/runs/{id}/approve` returns 403 for
   same-repo PRs — approvals only work for fork PRs.

**Do not** use `gh run rerun` repeatedly as a workaround before the settings regression is
diagnosed: it will not fix the underlying cause and wastes CI minutes.

**Escalation.** If the setting appears correct and runs still land `action_required`,
escalate to a GitHub organisation admin — the root cause may be at the org level.

---

## 2. Bootstrap ConfigMap exceeds 1 MiB

**Symptom.** `Deploy Dev` fails in `Bootstrap Supabase DB (migrations + demo seed)` at the
`Apply Supabase migrations + demo seed (in-cluster job)` step with an error similar to:

```
ConfigMap "dia-db-bootstrap-<run-id>-1-migrations" is invalid:
[...]: Too long: may not be more than 1048576 bytes
```

**Cause.** The bootstrap job generates a Kubernetes ConfigMap that embeds the accumulated
migration SQL.  As the migration corpus grows the ConfigMap exceeds the 1 MiB Kubernetes
limit.

**Owner.** Platform / deploy lane.

**Triage.**
```bash
# Identify the failing run and job
gh run list --workflow deploy-dev.yml --limit 5 --json databaseId,status,conclusion,name

# Fetch the failed-job log tail
gh run view <run-id> --log-failed | grep -A 20 "ConfigMap"
```

**Child incidents.** Route to the active deploy bootstrap incident (`#1064` / `#1430`).
Do not open a new incident if either is still open — comment on the existing one with the
run ID as additional evidence.

**Immediate workaround.** The app-deploy step completes successfully; only the in-cluster
DB migration job is blocked.  If a hot fix is needed before the packaging limit is
resolved, a manual `supabase db push` against the dev cluster can unblock the environment
while the root cause is investigated in the child incident.

---

## 3. Missing E2E fixture-seeding credentials

**Symptom.** `E2E (dev environment)` fails in `Playwright smoke vs dev` at
`Require fixture-seeding credentials` before any browser smoke runs.  The log shows:

```
E2E_SUPABASE_SERVICE_KEY is empty
```

**Cause.** The `e2e-dev.yml` workflow explicitly hard-fails when
`E2E_SUPABASE_SERVICE_KEY` is missing (design intent — better to fail fast than silently
skip fixture seeding).  The secret has drifted or been rotated without updating the
GitHub environment secret.

**Owner.** Ops.

**Triage.**
```bash
# Confirm the secret is missing from the GitHub environment
gh secret list --env dev | grep E2E_SUPABASE_SERVICE_KEY
```

**Resolution.** Restore `E2E_SUPABASE_SERVICE_KEY` in the **dev** GitHub Environment:

```bash
# Rotate and set the secret (value from Supabase project dashboard → Settings → API)
gh secret set E2E_SUPABASE_SERVICE_KEY --env dev --body "<service-role-key>"
```

**Child incidents.** Route to `#1546` / `#1571` / `#1671` / `#1790` if open.

**Security note.** The service-role key bypasses row-level security.  Follow the
[secret-operations runbook](./secret-operations.md) for key rotation.

---

## 4. `private_lane_degraded` / runner not registered

**Symptom.** `Pipeline — Hourly` passes `private_lane_preflight` (which reports
`factory-cluster-guardian runner label is not registered`) and then fails in
`private_lane_degraded` with:

```
Degraded monitoring: private hourly runtime lane prerequisites missing
(factory-cluster-guardian runner label is not registered).
```

**Cause.** The self-hosted runner that carries the `factory-cluster-guardian` label
is either not registered or offline.  The private lane (cluster guardian and private
operations-manager) is intentionally skipped when the runner is unavailable, and the
degraded job fails explicitly so the monitoring gap is visible.

**Owner.** Ops.

**Triage.**
```bash
# Check which runners are registered and their status
gh api "/repos/Volaris-AI/dia/actions/runners?per_page=100" \
  --jq '.runners[] | {name, status, labels: [.labels[].name]}'

# Filter to factory-cluster-guardian runners
gh api "/repos/Volaris-AI/dia/actions/runners?per_page=100" \
  --jq '.runners[] | select(.labels[].name == "factory-cluster-guardian") | {name, status}'
```

**Resolution.** Bring the self-hosted runner online.  Refer to the cluster operations
runbook and child incident `#248` / `#299` for the runner registration procedure.

**Note.** `private_lane_degraded` failing is expected and correct when the runner is
offline — it is the monitoring signal, not the root cause.  Do not suppress this job or
mark it `continue-on-error: true`; the explicit failure is the alert.

---

## 5. Deploy sentinel timeout

**Symptom.** `Monitor - Deploy` fails in the `sentinel` job at `Run Deploy Sentinel agent`
with:

```
Timeout after 600000ms waiting for session.idle
```

**Cause.** The deploy-sentinel agent session does not reach `idle` within the
10-minute timeout window.  This can indicate a hung agent session from a previous run,
platform-side Copilot API latency, or an agent that is waiting on downstream action that
never resolves.

**Owner.** Platform.

**Triage.**
1. Check whether there is a currently in-progress `Monitor - Deploy` run (the
   concurrency group `monitor-deploy` is `cancel-in-progress: false`, so concurrent
   runs queue rather than cancel).
2. If a previous run is still active, wait for it to time out or cancel it manually
   before triggering a fresh run.
3. If the sentinel consistently times out, review the Copilot agent session log for the
   last successful session to identify what state it is waiting on.

```bash
# List recent monitor-deploy runs
gh run list --workflow monitor-deploy.yml --limit 5 --json databaseId,status,conclusion,name

# Cancel a stuck run
gh run cancel <run-id>
```

**Resolution.** After clearing any stuck session, re-run the monitor-deploy workflow
manually (`workflow_dispatch`) to verify the sentinel reaches idle successfully.

---

## 6. CodeQL analysis failures

**Symptom.** `Code quality (nightly)` fails in `CodeQL (javascript-typescript)` or
`CodeQL (python)` at `github/codeql-action/analyze@v3`.

**Cause.** CodeQL analysis failures can be caused by GitHub CodeQL service outages,
ephemeral runner failures, or (rarely) genuine analysis errors triggered by new code
patterns.  The `codeql` job carries `continue-on-error: true` so it does not gate
deploys — but failures are visible in the nightly run status.

**Owner.** Platform.

**Triage.**
1. Check [githubstatus.com](https://www.githubstatus.com) for any CodeQL / GitHub Advanced
   Security service incidents.
2. If no platform incident is active, review the failed job log for an analysis error
   message.  A `build database` or `analyze` failure that repeats across multiple nightly
   runs may indicate a code-level issue that needs investigation.

```bash
# Get the failed CodeQL job log
gh run view <run-id> --job <job-id> --log
```

**Resolution.** For transient platform failures, re-run the nightly job manually
(`workflow_dispatch` on `code-quality.yml`) to confirm.  If the failure is persistent and
not caused by a CodeQL service outage, escalate to the code-quality-reviewer agent's next
run or open a child incident with the analysis error details.

---

## Routing new incidents

Use this decision tree when a new shared CI failure is reported:

1. **Is it `action_required` with zero jobs on a Copilot same-repo PR?** → §1. Escalate to maintainer.
2. **Does it affect a single PR only, not `main` or other open PRs?** → Open a PR-specific child incident; do not roll it up here.
3. **Is it in one of the failure families above?** → Comment on the existing child incident with the new run ID rather than opening a duplicate.
4. **Is it a new failure class?** → Open a new child issue under epic #1537 using the Initiative → Epic → Story hierarchy; link it via the GitHub sub-issue API (see [project-board-ops.md](./project-board-ops.md)).

---

## Deduplication rules

- Each recurring failure family has a canonical open child incident (listed in the
  triage matrix above).  Add run-ID evidence to the existing child rather than opening
  a new one.
- Shared-file drift (concurrent `pr-validation.yml` edits across open PRs) is tracked
  under issue `#58`.  Sequence or rebase concurrent control-plane PRs before merging.
- `#1537` is the umbrella epic only.  Do not assign implementation work directly to
  this epic; all concrete fixes live in child issues.
