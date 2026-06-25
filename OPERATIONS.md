# Operations Factory Handoff

> **Purpose:** This is the [`MONITORING.md`](./MONITORING.md) analogue for the Operations Factory. It captures where to run/approve/audit ops workflows, the approval SLA, starter failure recovery, and the Ops Monitor sketch.

---

## Source of truth

- Spec: [`docs/specs/operations-factory-agentic-workflows.md`](./docs/specs/operations-factory-agentic-workflows.md)
- Observability section: [§11 — Observability & health](./docs/specs/operations-factory-agentic-workflows.md#11-observability--health-the-monitoringmd-analogue)
- Governance principle: **agents propose; humans dispose** (no auto-apply in v1)

---

## Admin access model (Temporal UI + Grafana)

### Internal-only access (current default)

Admin tooling is currently **internal-only** — accessible only via `kubectl port-forward` from a trusted admin workstation or VPN, following the same pattern as Supabase Studio. External OIDC-gated routes will be enabled after the Keycloak identity epic (#680) lands.

#### Temporal Web UI (port-forward)

The Temporal Web UI pod is deployed in-cluster when `temporalUi.enabled: true` (enabled in dev; available in test/prod once confirmed stable).

```bash
# dev
kubectl -n dia-dev port-forward svc/rental-app-temporal-ui 8080:8080
# then open http://localhost:8080

# test
kubectl -n dia-test port-forward svc/rental-app-temporal-ui 8080:8080

# prod
kubectl -n dia-prod port-forward svc/rental-app-temporal-ui 8080:8080
```

The UI connects directly to the in-cluster Temporal frontend (`temporal-frontend.<env>.svc.cluster.local:7233`).

#### Grafana (port-forward, once kube-prometheus-stack is deployed)

```bash
kubectl -n dia-observability port-forward svc/observability-grafana 3000:80
# then open http://localhost:3000  (default admin/prom-operator or from the grafana admin secret)
```

Dashboard provisioning via `observability.grafana.dashboards.enabled: true` loads Dealernet dashboards into Grafana automatically when the Grafana sidecar is running.

#### Prometheus (port-forward, once kube-prometheus-stack is deployed)

```bash
kubectl -n dia-observability port-forward svc/observability-kube-prometheus-stack-prometheus 9090:9090
# then open http://localhost:9090
```

### Metrics endpoints

| Component | Port | Path | Description |
|---|---|---|---|
| `temporal-worker` | `9000` | `/metrics` | Temporal SDK Runtime telemetry (Prometheus format) |
| `ops-api` | `8000` | `/metrics` | FastAPI HTTP request metrics (Prometheus format) |

### External access (post-identity epic #680)

External admin tooling is gated by the unified Keycloak OIDC boundary:

- **Temporal UI:** Ingress → `oauth2-proxy` → Temporal UI upstream service (group-gated; requires Keycloak `dia-admin` group)
- **Grafana:** Ingress → Grafana upstream service (native OIDC; Grafana authenticates directly against Keycloak with group→role mapping)
- **Authorization source of truth:** Keycloak `groups` claim
- **Default posture:** unauthenticated users are redirected to Keycloak; users without a mapped group are denied in both Grafana and Temporal UI

| Environment | Temporal UI (external) | Grafana (external) | OIDC issuer |
|---|---|---|---|
| `test` | `https://temporal.dia-test.example.com` | `https://grafana.dia-test.example.com` | `https://keycloak.dia-test.example.com/realms/dia` |
| `prod` | `https://temporal.dia.example.com` | `https://grafana.dia.example.com` | `https://keycloak.dia.example.com/realms/dia` |

**Login/logout expectations (when OIDC is active):**

1. Open Temporal UI or Grafana URL.
2. You are redirected to Keycloak if no active SSO session exists.
3. For Temporal UI: only users whose Keycloak `groups` contains `dia-admin` are admitted; others receive 403.
4. For Grafana: only users in `dia-admin`, `dia-branch-manager`, or `dia-field-operator` groups are admitted; unmatched users are denied.
5. Logout from the tool and from Keycloak to clear SSO session/cookie state.

---

## Keycloak SSO group-to-role mapping

One SSO login at Keycloak grants role-appropriate access across Grafana and the app/ops-api.
The canonical Keycloak groups are:

| Keycloak group          | App role (`app_metadata.role`) | Grafana role |
|-------------------------|-------------------------------|--------------|
| `dia-admin`           | `admin`                       | `Admin`      |
| `dia-branch-manager`  | `branch_manager`              | `Editor`     |
| `dia-field-operator`  | `field_operator`              | `Editor`     |
| `dia-read-only`       | `read_only`                   | denied       |
| (no matching group)     | `read_only` (default)         | denied       |

**Role semantics:**

| Role | App/ops-api capabilities | Grafana capabilities |
|------|--------------------------|----------------------|
| `admin` | Full read/write on all tables; manage user profiles | Create/edit dashboards, manage data sources, manage users |
| `branch_manager` | Full read/write on operational + entity data | Edit dashboards and panels |
| `field_operator` | Read + insert on inspections, contracts, check-ins | Edit dashboards and panels |
| `read_only` | Read-only for authenticated sessions | No Grafana access (not in Grafana allow-list) |

**Precedence rule:** when a user belongs to multiple groups, the most-privileged role wins
(admin > branch_manager > field_operator > read_only).

### App and ops-api (Keycloak → Supabase federation)

App sign-in flows through Keycloak OIDC into GoTrue (Supabase Auth):

1. User authenticates at Keycloak (SSO or local credentials).
2. Keycloak issues an id_token containing `groups` and `tenant` claims (via protocol mappers).
3. GoTrue processes the OIDC callback; the `handle_new_user` trigger reads `raw_user_meta_data.groups`, maps them via `public.keycloak_groups_to_role()`, and backfills `raw_app_meta_data` with `role` and `tenant`.
4. GoTrue issues a Supabase JWT. The `app_metadata.role` and `app_metadata.tenant` fields in the JWT reflect the mapped Keycloak claims.
5. The `ops-api` and PostgREST (RLS) authenticate the Supabase JWT as before — no raw Keycloak token path is introduced.

**Sign-in failure conditions:**
- Keycloak token does not include a `groups` claim → role defaults to `read_only`.
- Keycloak token does not include a `tenant` claim → tenant defaults to `default`.
- A missing `tenant` or unmapped role causes the Supabase session to carry safe defaults; the
  app enforces role-gated access via RLS on every request.

**Required Keycloak configuration (provisioned by #689):**
- Realm: `dia`
- Client for app federation (confidential, standard flow)
- Client for Grafana native OIDC (confidential, standard flow + PKCE)
- Protocol mappers: `groups` claim (group membership list), `tenant` claim (user attribute), `email`, `name`

### Grafana native OIDC configuration

Grafana is configured via environment variables rendered in the `<release>-grafana-oidc` ConfigMap
(in the app Helm release namespace). The kube-prometheus-stack Grafana deployment must reference
this ConfigMap via `envFrom` and the `grafana-oidc-secrets-<env>` Secret for `GF_AUTH_GENERIC_OAUTH_CLIENT_ID`
and `GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET`.

Key non-secret settings (rendered from `adminAccess.grafana.nativeOidc.*` in values):

| Variable | Value |
|---|---|
| `GF_AUTH_GENERIC_OAUTH_ENABLED` | `"true"` |
| `GF_AUTH_GENERIC_OAUTH_NAME` | `"Keycloak"` |
| `GF_AUTH_GENERIC_OAUTH_SCOPES` | `"openid email profile groups"` |
| `GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH` | `contains(groups[*], 'dia-admin') && 'Admin' || ...` |
| `GF_AUTH_GENERIC_OAUTH_USE_PKCE` | `"true"` |

Required secrets in `grafana-oidc-secrets-<env>`:
- `GF_AUTH_GENERIC_OAUTH_CLIENT_ID` — Grafana OIDC client ID registered in Keycloak
- `GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET` — Grafana OIDC client secret

### Rollback

If native Grafana OIDC is not functioning:

1. Disable Grafana external access: set `adminAccess.grafana.enabled=false` and redeploy.
2. Access Grafana via port-forward while the issue is resolved.
3. Validate the Keycloak client configuration, redirect URI, and group protocol mapper.
4. Re-enable once a successful admin login and a verified Editor-role login (branch-manager or field-operator group) are confirmed.

### Key alerts and what they mean

Alert rules are provisioned as `PrometheusRule` resources when `observability.prometheusRule.enabled: true`. Alerts are labelled with a `fingerprint_prefix` and routed into the existing `auto:alert` incident model (one deduped incident per fingerprint).

| Alert | Severity | What it means |
|---|---|---|
| `TemporalWorkerDown` | critical | The worker pod is unreachable for 5 min — workflows will stall |
| `TemporalWorkflowFailureSpike` | warning | >5% of workflows are failing over 10 min — check Temporal UI |
| `TemporalTaskQueueBacklog` | warning | p95 schedule-to-start latency >30s — check worker capacity |
| `OpsApiDown` | critical | The ops-api pod is unreachable — approvals and signals are unavailable |
| `OpsApiHighErrorRate` | warning | >1% 5xx rate on ops-api — investigate Temporal connectivity |
| `OpsRevRecScheduleMiss` | warning | RevRec schedule has not processed in 25h — check Temporal schedules |


## What runs and where to look

The Operations Factory runs Temporal workflows (starting with Rev-Rec, then Fleet, then additional ops agents) on schedules. The human-in-the-loop surface is Findings & Approvals.

### Run surface (workflow health)

Use these as the primary run-level surfaces:

1. **Temporal UI** (`localhost:8080` in dev): workflow execution state, retries, failures, wait states, and signal history.
2. **Ops run records** (`ops_workflow_run` + `ops_agent_status_view` per spec): last run, next run, processed counts, error summaries.
3. **Ops KPIs** (`ops_finding_kpis`): pending approvals, approved counts, and 24h throughput trends.

### Key dashboards and alerts (Grafana)

Use Grafana as the shared dashboard surface for Temporal and approval-path health:

1. **Temporal worker/runtime dashboard:** worker heartbeat, poller activity, workflow failure/retry rates.
2. **Ops API / approval path dashboard:** `/api/ops/health`, request latency/error rates, signal dispatch outcomes.
3. **Approval backlog/SLA dashboard:** pending approvals by age/severity and SLA breach count.

Treat these as immediate investigation triggers:

- Workflow failure rate spikes or sustained retry exhaustion.
- Ops API health-check failures or elevated 5xx responses.
- Pending approvals older than 24h (or urgent >4h).

#### Provisioned dashboard reference

All dashboards are provisioned declaratively from `charts/monitoring/` and are read-only in the UI.
Edits made in the Grafana UI will be lost on the next Helm release — change the ConfigMap templates and redeploy.

| Dashboard | Grafana Folder | UID | Key panels |
|-----------|---------------|-----|------------|
| **Temporal Server** | Temporal | `temporal-server` | Service request rate/failures, open workflow executions, workflow completion rate/latency, persistence latency |
| **Temporal SDK / Worker** | Temporal | `temporal-sdk` | Worker task-slot availability, poll success/empty rate, workflow outcome rate, workflow task execution latency, activity outcome/latency by type |
| **Dealernet Ops** | Dealernet Ops | `dia-ops` | Workflow throughput (completed/failed/canceled/s), end-to-end latency (p50/p95/p99), task-queue backlog depth and age, activity failure rate and failures by type, schedule missed-catch-up windows and buffer overruns, ops-api request latency and error rates |
| **System — Pods & Nodes** | System | `system-pods-nodes` | Pod CPU usage and CPU vs limit %, pod memory working set and memory vs limit %, container restart count/rate, node CPU/memory utilisation, node pressure conditions (MemoryPressure / DiskPressure / PIDPressure) |

#### Internal (port-forward) access

Grafana is exposed as a `ClusterIP` service by default until the Keycloak OIDC identity boundary is active.
Reach it via port-forward from a trusted admin workstation:

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
# then open http://localhost:3000  (admin credentials: kubectl get secret grafana-admin-credentials -n monitoring)
```

#### Deploying the monitoring stack

```bash
# Install kube-prometheus-stack with Dealernet's sidecar configuration
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f charts/monitoring/values-kube-prometheus-stack.yaml

# Install dashboard / datasource provisioning
helm upgrade --install dia-monitoring charts/monitoring \
  --namespace monitoring \
  -f charts/monitoring/values-<env>.yaml
```

See [`charts/monitoring/README.md`](./charts/monitoring/README.md) for full install instructions.

### Approval surface (human gate)

Use these to review and dispose findings:

1. **Findings queue** (`pending_approval`, `approved`, `rejected`, `informational`) sorted by impact.
2. **Finding detail / approval card** with evidence, rationale, expected-vs-billed, and proposed action.
3. **Approve/Reject API + Temporal signals** (`approve_finding` / `reject_finding`) as defined in spec §15.

### Audit surface (compliance & replay)

Use these to verify end-to-end traceability:

1. **`time_series_points`** events for proposed → approved/rejected → applied chain.
2. **`ops_audit_trail_view`** for entity-level history.
3. **Temporal workflow history** for signal timing, retries, and final disposition.

---

## Approval SLA (starter policy)

Use this as the default until tenant-specific SLAs are configured:

- **Target response SLA:** `pending_approval` findings are reviewed within **24 hours**.
- **Urgent queue:** review within **4 hours** when either condition is true: (a) finding severity is `high` (from the spec's `high | medium | low` levels), **or** (b) estimated impact meets the tenant-configured urgent threshold (starter placeholder: **$1,000 or more**).
- **Escalation rule:** any finding older than SLA is treated as an operational incident and escalated.

Ops Monitor should evaluate against these thresholds and raise deduplicated incidents when breached.

---

## Starter runbook: recurring failure patterns + recovery

### 1) Workflow run failed

**Symptom:** recent `ops_workflow_run` row ends in failed/error state; Temporal execution failed.

**Recovery:**
1. Open the failed execution in Temporal UI; capture failing activity + error.
2. Classify the failure (tool/data issue, timeout/retry exhaustion, config issue).
3. If transient, re-run/retry the workflow execution.
4. If deterministic/config-driven, fix config or data, then rerun.
5. Record incident with fingerprint + recovery note in audit/event history.

### 2) Approvals stuck past SLA

**Symptom:** findings remain `pending_approval` beyond 24h (or urgent 4h threshold).

**Recovery:**
1. Sort queue by age + dollar impact.
2. Escalate to the designated human approver/on-call owner.
3. Verify approve/reject API and Temporal signal path are healthy.
4. Record final disposition and elapsed time for audit metrics.

### 3) Zero-finding runs when findings are expected

**Symptom:** workflows repeatedly produce zero findings during periods where seeded/known anomalies should surface.

**Recovery:**
1. Validate scope input and tenant/branch filters.
2. Verify agent config (`enabled`, thresholds, schedule, tools, bounds).
3. Check evidence tool-belt calls for empty or filtered-out data.
4. Compare against prior successful run output; rerun with same scope.
5. Raise incident if behavior persists across consecutive runs.

### 4) Incident duplication/noise

**Symptom:** repeated incidents for the same underlying condition.

**Recovery:**
1. Ensure dedupe fingerprint includes tenant, agent, workflow/run scope, and failure type.
2. Reopen/update the existing incident instead of creating a new one.
3. Keep one active incident per fingerprint until resolved.

---

## Rollback and internal-only fallback

If external auth routing is unstable (redirect loops, cookie/callback mismatch, or authz drift):

1. Disable external admin routes (`adminAccess.enabled=false`) and redeploy the chart values for that environment.
2. Keep operator access via internal-only break-glass paths (port-forward from a trusted admin workstation/VPN).
3. Validate Keycloak issuer, redirect URI, cookie secret, and group-claim mapping before re-enabling external routes.
4. Re-enable external ingress only after one successful admin login and one verified non-admin denial in the target environment.

---

## Ops Monitor sketch (ticket #8)

**Cadence:** run at the tenant-configured monitor interval (starter default: **15 minutes**, max **30 minutes** for lower-volume environments). Spec §11 defines the Ops Monitor as a 15–30 minute loop.

**Checks each cycle:**
1. Query recent ops workflow runs for failures/timeouts.
2. Query findings for `pending_approval` older than SLA.
3. Query runs with unexpected zero findings.
4. Aggregate by fingerprint and dedupe against open incidents.
5. Create or update incident records with clear next action + owner.
6. Emit a short health summary (counts + oldest pending approval + active incidents).

**Initial fingerprint shape (example):**

`ops-monitor:<tenant_id>:<agent_key>:<failure_kind>:<scope_key>`

Where:
- `failure_kind` must be one of `run_failure | approval_sla_breach | zero_finding_anomaly`
- `scope_key` is stable for the condition (e.g., workflow id/date window) and should be stored as a SHA-256 hash of canonical scope components to prevent delimiter collisions (such as embedded `:`). Example canonical input before hashing: `<tenant_id>|<agent_key>|<window_start>|<window_end>|<workflow_id>`.

This keeps alerting high-signal while preserving an auditable history of operational regressions.

---

## Prometheus alerting and the incident bridge

Prometheus alerting rules are defined as a repo-managed `PrometheusRule` resource in
`charts/app/templates/prometheus-rule.yaml` and are enabled per environment via
`alerting.enabled=true` in the environment values file (test and prod profiles ship with
this enabled).

### Alert inventory

| Alert name | Severity | `for:` window | Condition | Component |
|---|---|---|---|---|
| `TemporalWorkerDown` | critical | 2 min | No `temporal-worker` pod is `Ready` | temporal-worker |
| `TemporalTaskQueueBacklogHigh` | warning | 5 min | p95 schedule-to-start latency > 30 s | temporal-worker |
| `TemporalWorkflowFailureRateHigh` | warning | 5 min | Workflow failure fraction > 5 % over 10 min | temporal-worker |
| `TemporalScheduleMissed` | warning | 5 min | `temporal_schedule_missed_catchup_window_count` > 0 | temporal-worker |
| `OpsApiErrorRateHigh` | critical | 5 min | ops-api 5xx fraction > 1 % | ops-api |
| `OpsApiLatencyHigh` | warning | 5 min | ops-api p99 latency > 2 s | ops-api |

Thresholds and `for:` windows are configured in `charts/app/values.yaml` under
`alerting.prometheusRule.*` and can be overridden per environment.

---

### Alertmanager → incident bridge

When a rule fires, Alertmanager sends an HTTP POST to the incident bridge webhook URL
(configured in `alerting.alertmanagerConfig.incidentBridge.webhookUrl`). The bridge:

1. Parses the Alertmanager JSON payload.
2. Computes a stable **fingerprint** for each alert:
   `alert-<sha256(env|alertname|scope)>` where `scope` is the most discriminating label
   (`task_queue` → `schedule_id` → `component` → `global`).
3. Searches GitHub Issues for an open issue whose body contains `fingerprint:<id>`.
4. **Creates** a new issue (labelled `auto:alert`, `queue:ops`) if none is found.
5. **Updates** the existing issue body and adds a "still firing" comment if one is open.
6. On resolution, adds a "✅ Alert resolved" comment so operators know recovery happened.

The bridge is implemented in `.github/tools/shared/src/alert-incident-bridge.ts`
and runs as a GitHub Actions job (`alert-incident-bridge.yml`) triggered by
`repository_dispatch` with `event-type: alertmanager-alert`.

#### Bridge deployment

The standard webhook adapter pattern for sending Alertmanager payloads to GitHub
Actions is:

1. Deploy a small webhook relay that:
   - Receives the Alertmanager HTTP POST.
   - Extracts the JSON body.
   - Calls `POST https://api.github.com/repos/{owner}/{repo}/dispatches` with
     `event_type: alertmanager-alert` and `client_payload: { "payload": <json> }`.
   - Authenticates with a fine-grained PAT that has `actions: write` on this repo.
2. Set `alerting.alertmanagerConfig.incidentBridge.webhookUrl` to the relay URL.
3. Configure the relay's `ALERT_BRIDGE_TOKEN` to match the bearer token in
   `alerting.alertmanagerConfig.incidentBridge.bearerTokenSecretName/Key`.

For testing without a live relay, trigger the workflow manually:
```
gh workflow run alert-incident-bridge.yml \
  --field payload='{"version":"4",...}'
```

---

### Alert runbooks

#### TemporalWorkerDown

**Symptom:** No Temporal worker pod is `Ready`. All task queues are stalled.

**Recovery:**
1. Check pod status: `kubectl get pods -n <namespace> -l app.kubernetes.io/component=temporal-worker`
2. Inspect events: `kubectl describe pods -n <namespace> -l app.kubernetes.io/component=temporal-worker`
3. Check image pull: verify the ACR credentials secret is present and not expired.
4. Restart: `kubectl rollout restart deployment/<release>-app-temporal-worker -n <namespace>`
5. Confirm pollers are back via Temporal UI → Task Queues.

#### TemporalTaskQueueBacklogHigh

**Symptom:** p95 schedule-to-start latency exceeds 30 s; tasks are queuing faster than workers can consume them.

**Recovery:**
1. Check Temporal UI → Task Queue pollers. Are expected workers registered?
2. If workers are present but slow, check for activity timeouts or resource pressure.
3. Scale workers: `kubectl scale deployment/<release>-app-temporal-worker --replicas=<n> -n <namespace>`
4. Confirm latency returns below threshold on the Grafana Temporal worker dashboard.

#### TemporalWorkflowFailureRateHigh

**Symptom:** More than 5 % of workflows are failing over the last 10-minute window.

**Recovery:**
1. Open Temporal UI → Workflows → failed status. Filter to the affected namespace.
2. Identify the failing workflow type and capture the first error from the history.
3. If a transient tool/data issue, rerun the failed executions.
4. If deterministic (config, schema, upstream API), fix root cause before rerunning.
5. Record the failure type and fix in the incident issue.

#### TemporalScheduleMissed

**Symptom:** A Temporal schedule missed its catch-up window; the workflow was not triggered.

**Recovery:**
1. Check the Temporal UI → Schedules view for the affected schedule.
2. Verify the Temporal server and worker are both healthy.
3. If the schedule was paused (accidentally or during maintenance), un-pause it.
4. If the window was narrow and the run is genuinely missed, trigger the workflow manually
   via the Temporal UI or `tctl schedule trigger`.
5. Confirm the next scheduled run completes normally.

#### OpsApiErrorRateHigh

**Symptom:** Ops API is returning more than 1 % 5xx responses; approval signals and finding
surfacing are degraded.

**Recovery:**
1. Check `kubectl logs -n <namespace> -l app.kubernetes.io/component=ops-api --tail=200`
2. Verify Temporal server connectivity (the ops-api forwards signals via Temporal).
3. Verify Supabase connectivity: check `SUPABASE_SERVICE_ROLE_KEY` secret and Supabase health.
4. Restart the ops-api if it is in a bad state:
   `kubectl rollout restart deployment/<release>-app-ops-api -n <namespace>`
5. Monitor the error rate on Grafana until it returns below 1 %.

#### OpsApiLatencyHigh

**Symptom:** p99 request latency on the ops-api exceeds 2 s; the approval UI is slow.

**Recovery:**
1. Check Temporal UI for long-running activities that ops-api calls are waiting on.
2. Verify database query times in Supabase (slow queries surface in Supabase logs).
3. Check pod resource usage: `kubectl top pods -n <namespace> -l app.kubernetes.io/component=ops-api`
4. If CPU/memory constrained, adjust `opsApi.resources` limits in the values file and redeploy.
5. Consider enabling read replicas or caching if the latency is query-driven.
