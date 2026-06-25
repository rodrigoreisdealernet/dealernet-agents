# Logistics telemetry + ELD compliance contract (internal)

Story: **Logistics telemetry and compliance integration surface** (part of #446).

## Purpose

Define a single app-facing contract for dispatcher and driver experiences so UI code
renders logistics position/compliance state without vendor-specific conditionals.

This contract follows the connector ingress/runtime split used by shared connector
patterns: connector adapters normalize vendor payloads at ingress, and app/runtime
layers consume only normalized fields.

## Normalized contract

`frontend/src/lib/logistics-telemetry-contract.ts` defines:

- `NormalizedTelemetryComplianceSnapshot`
  - `assetId`, `driverId`
  - `routePosition` (`latitude`, `longitude`, `recordedAt`, optional heading/speed)
  - `gpsStatus` (`online | stale | offline | unknown`)
  - `eldDutyStatus` (`driving | on_duty_not_driving | off_duty | sleeper_berth | unknown`)
  - `complianceState` (`compliant | approaching_limit | violation | device_malfunction | unknown`)
  - `exceptions[]` normalized compliance exception events
  - `observedAt`, `connectorKey`
- `TelemetryComplianceContractState`
  - latest snapshot + sync status (`synced | retrying | failed`)
  - retry count, last failure details, dedupe-key history

## Dispatcher/mobile contract usage

- `toDispatcherComplianceView(...)` maps normalized contract state to dispatcher-ready
  position/compliance summaries and severity.
- `toDriverComplianceView(...)` maps normalized contract state to driver-ready GPS,
  duty, and compliance summaries, including blocking state.

Both mappers use only normalized fields and produce identical output for equivalent
normalized snapshots regardless of `connectorKey`.

## Retry, dedupe, sync-failure handling

- `applyTelemetryComplianceUpdate(...)` dedupes by `dedupeKey`.
- Retryable sync failures move contract state to `retrying` and increment retry count.
- Exhausted/non-retryable sync failures move contract state to `failed`.
- Successful snapshot updates reset retry state and clear last failure.

These paths are covered by:

- `frontend/src/test/logistics-telemetry-contract.test.ts`

## First connector dependency for end-to-end proof

First connector dependency for proving this contract end-to-end: **the first
telematics/ELD vendor connector delivered under telematics integration stories
#476, #477, #478, #479, #480, or #481, feeding logistics integration epic #484**.

The contract is intentionally vendor-neutral so this first connector can be swapped
without app-level logic changes.
