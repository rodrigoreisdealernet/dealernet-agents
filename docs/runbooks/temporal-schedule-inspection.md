# Inspecting Temporal Schedules for Ops-Factory Agents

This runbook describes how to trace, inspect, and verify the Temporal Schedules that drive the
Operations Factory agents for each tenant.

---

## Schedule naming conventions

Every schedule has a deterministic ID composed from the source-of-truth identifiers in the agent
config so you can always map a schedule back to its config row.

### Ops agent schedules (sourced from `ops_agent_config_current`)

| Agent key | Schedule ID pattern | Example |
|---|---|---|
| `revrec-analyst` | `ops:{tenant_id}:revrec-analyst` | `ops:acme:revrec-analyst` |
| `pm-evaluator` | `ops:{tenant_id}:pm-evaluator` | `ops:acme:pm-evaluator` |
| `fleet-auditor` | `ops:{tenant_id}:fleet-auditor` | `ops:acme:fleet-auditor` |
| `credit-analyst` | `ops:{tenant_id}:credit-analyst` | `ops:acme:credit-analyst` |
| `shop-morning-queue` | `ops:{tenant_id}:shop-morning-queue` | `ops:acme:shop-morning-queue` |
| `branch-morning-brief` | `ops:{tenant_id}:branch-morning-brief` | `ops:acme:branch-morning-brief` |
| `account-health-queue` | `ops:{tenant_id}:account-health-queue` | `ops:acme:account-health-queue` |
| `integration-exception-queue` | `ops:{tenant_id}:integration-exception-queue` | `ops:acme:integration-exception-queue` |

### Integration connector schedules (sourced from `integration_config`)

| Connector key | Schedule ID pattern | Example |
|---|---|---|
| `samsara` | `integration:{tenant_id}:samsara` | `integration:acme:samsara` |
| `coupa` | `integration:{tenant_id}:coupa` | `integration:acme:coupa` |
| `descartes` | `integration:{tenant_id}:descartes` | `integration:acme:descartes` |

---

## Default cron expressions

Schedules are **on by default** (§3.7 of the operations-factory spec). The table below shows the
out-of-the-box cron when no `schedule.cron` override is set in the agent config.

| Agent key | Default cron | Effective schedule |
|---|---|---|
| `revrec-analyst` | `0 2 * * *` | Nightly 02:00 |
| `pm-evaluator` | `0 */6 * * *` | Every 6 hours |
| `fleet-auditor` | `0 3 * * 1` | Weekly, Monday 03:00 |
| `credit-analyst` | `0 3 * * *` | Nightly 03:00 |
| `shop-morning-queue` | `0 7 * * *` | Daily 07:00 |
| `branch-morning-brief` | `0 7 * * *` | Daily 07:00 |
| `account-health-queue` | `0 4 * * *` | Nightly 04:00 |
| `integration-exception-queue` | `0 5 * * *` | Nightly 05:00 |
| `samsara` | `0 */6 * * *` | Every 6 hours |
| `coupa` | `0 */6 * * *` | Every 6 hours |
| `descartes` | `0 */6 * * *` | Every 6 hours |

---

## Inspecting schedules in the Temporal UI

1. Open the Temporal Web UI at the configured address (local default: `http://localhost:8080`).
2. Select the correct **namespace** (default: `default`, or as set in `TEMPORAL_NAMESPACE`).
3. Navigate to **Schedules** in the left sidebar.
4. Use the search box to filter by schedule ID prefix — for example, enter `ops:acme` to see all
   ops-factory schedules for tenant `acme`.
5. Click a schedule to view:
   - **Spec** — the cron expression and timezone.
   - **Next runs** — upcoming trigger times.
   - **Recent actions** — last N workflow runs triggered by this schedule.
   - **State** — whether the schedule is paused or active.

### Inspecting via the Temporal CLI (`tctl` / `temporal`)

```bash
# List all schedules
temporal schedule list --namespace default

# Describe a specific schedule
temporal schedule describe --schedule-id "ops:acme:revrec-analyst" --namespace default

# Trigger an immediate run without waiting for the next cron tick
temporal schedule trigger --schedule-id "ops:acme:revrec-analyst" --namespace default

# Pause a schedule (disables future automatic triggers without deleting it)
temporal schedule pause --schedule-id "ops:acme:fleet-auditor" --namespace default --reason "investigating anomaly"

# Resume a paused schedule
temporal schedule unpause --schedule-id "ops:acme:fleet-auditor" --namespace default --reason "investigation complete"
```

---

## Reconciliation and config changes

Schedules are reconciled against the `ops_agent_config_current` (or `integration_config`) table at
**every worker startup**. To apply a config change:

1. Update the `schedule.cron` or `schedule.enabled` field in the relevant config table row.
2. Restart the Temporal worker (or wait for the next automatic rolling restart in production).
3. The reconciler will:
   - **Create** the schedule if it does not exist and `enabled=true`.
   - **Update** the cron on an existing schedule if the cron has changed.
   - **Delete** the schedule if `enabled=false`.

Reconciliation is **idempotent** — running it multiple times against the same config produces the
same result without creating duplicate schedules.

---

## Manual (ad-hoc) workflow runs

Schedules do not gate manual runs. Any ops workflow can be started directly via the Temporal UI
or CLI without touching the schedule:

```bash
# Start a revrec workflow manually for tenant acme
temporal workflow start \
  --workflow-type RevenueRecognitionWorkflow \
  --task-queue ops-factory \
  --workflow-id "ops-revrec-acme-adhoc-$(date +%s)" \
  --input '{"tenant_id": "acme"}' \
  --namespace default
```

Use `temporal schedule trigger` (shown above) to fire the scheduled workflow immediately while
keeping the schedule's next-run clock intact.

---

## Tracing a schedule back to its config

| You have | Lookup path |
|---|---|
| Schedule ID `ops:acme:fleet-auditor` | Query `ops_agent_config_current` where `tenant_id='acme' AND agent_key='fleet-auditor'` |
| Schedule ID `integration:acme:samsara` | Query `integration_config` where `tenant_id='acme' AND connector_key='samsara'` |
| Workflow run started by a schedule | Open the run in the Temporal UI → **Parent** section shows the schedule ID |
