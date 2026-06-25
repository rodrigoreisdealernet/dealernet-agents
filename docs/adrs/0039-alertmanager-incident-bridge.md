# ADR-0039: Alertmanager routes high-value platform alerts into GitHub incident issues

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Tech Reviewer
- **Supersedes / Superseded by:** -

> **Status atual (2026-06-25):** `alert-incident-bridge.yml` is currently parked in `.github/workflows.disabled/`, so Alertmanager events do not create/update GitHub incidents automatically today. This ADR remains the target design for any future reactivation.


## Context

Issue #686 adds platform alerting for high-value Temporal worker, task queue, schedule, and ops API
failure modes. The repository already uses GitHub issues labeled `auto:alert` and `queue:ops` as the
durable incident surface for automated operational signals, but Alertmanager-to-incident wiring was not
yet defined.

This PR introduces Helm-managed Prometheus rules, an Alertmanager webhook configuration, and a GitHub
Actions-backed bridge under `.github/tools/shared/` and `.github/workflows/`. Because it adds a new
control-plane path and runtime integration boundary, the routing pattern needs an explicit architectural
record.

## Decision

We route high-value Prometheus / Alertmanager alerts into the existing GitHub incident model instead of
introducing a separate incident store or pager-only workflow.

Alertmanager sends webhook payloads to a relay that dispatches `alertmanager-alert` events into this
repository. The bridge workflow translates firing and resolved alerts into deduplicated GitHub issues
using a stable fingerprint keyed by environment, alert name, and alert scope.

## Consequences

- Platform alerting now shares the same durable incident queue and deduplication model as other
  automated operational signals.
- Environments must explicitly opt in by setting the incident-bridge webhook URL; the chart stays inert
  where no relay is deployed.
- The bridge workflow must keep least-privilege repository permissions because it operates through
  GitHub issue writes rather than an external incident system.
- Operations documentation and runbooks become part of the delivery contract for newly added alerts.

## Alternatives considered

- **Use Alertmanager notifications without GitHub incident creation:** rejected because it would split
  ops signal handling across separate queues and lose the existing deduped issue workflow.
- **Create a new database-backed incident service:** rejected because the repository already has a
  durable incident surface in GitHub issues, and a new service would add unnecessary control-plane
  complexity.
- **Send alerts directly to chat or paging only:** rejected because acknowledgement history and durable
  tracking would live outside the factory's current operational workflow.

## Evidence

- Issue #686
- PR #836
- `charts/app/templates/prometheus-rule.yaml`
- `charts/app/templates/alertmanager-config.yaml`
- `.github/workflows/alert-incident-bridge.yml`
- `.github/tools/shared/src/alert-incident-bridge.ts`
- `OPERATIONS.md`
