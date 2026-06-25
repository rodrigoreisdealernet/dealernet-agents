# Mobile Field Platform Specification

**Status:** Draft  
**Author:** Factory Architect  
**Date:** 2026-06-11  
**Related ADRs:** [ADR-0003](../adrs/0003-temporal-workflow-orchestration.md), [ADR-0016](../adrs/0016-json-driven-ui-engine.md), [ADR-0017](../adrs/0017-frontend-data-layer-supabase-anon.md), [ADR-0019](../adrs/0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0024](../adrs/0024-authenticated-write-path-security-definer-rls.md), [ADR-0041](../adrs/0041-mobile-field-runtime-capacitor-shell.md)  
**Related issues:** #452, #589, #590, #591, #592, #593, #594

---

## 1. Summary

This spec defines the shared runtime for Wynne's field-mobile platform: Quick Order, Quick Return,
Logistics Picking, Confirm Load, and adjacent field workflows that require scanning, capture,
offline work, and durable replay.

The approved direction is to package the existing React + TanStack + JSON-driven frontend in a
Capacitor shell. Browser and native clients share one route tree and one application codebase, with
device-only capabilities exposed through explicit adapters instead of a separate mobile stack.

---

## 2. Goals

- Reuse the existing frontend architecture instead of creating a second UI/runtime stack.
- Support installable iOS and Android field apps with camera scanning, photo capture, signature
  capture, and vendor-specific RFID bridges.
- Keep `/field/mobile` as a browser-accessible fallback and development surface.
- Support offline-capable field work through durable command capture and replay.
- Preserve authenticated, tenant-scoped write boundaries; no browser or device client may require
  `service_role`.

## 3. Non-goals

- Do not implement every downstream workflow in this spec.
- Do not define provider-specific RFID SDKs exhaustively; those belong behind the adapter boundary.
- Do not support arbitrary disconnected table writes from the device.
- Do not approve public app-store distribution before the required security hardening is complete.

---

## 4. Runtime architecture

### 4.1 Runtime shape

```text
native shell (Capacitor iOS / Android)
        |
        v
shared React + TanStack + JSON-driven UI app
        |
        +--> capability adapters (scan / RFID / camera / signature / storage / connectivity)
        |
        +--> local durable command queue
        |
        +--> guarded RPC / ops_api ingress
        |
        +--> Supabase read surfaces + Temporal-backed orchestration
```

### 4.2 Shared route boundary

- `/field/mobile` remains the canonical route for the field-mobile surface.
- The browser route is the fallback and day-to-day development target.
- Native packaging must not fork route logic, state models, or workflow orchestration rules.

### 4.3 Capability adapters

Native-only features must be consumed through explicit interfaces so workflow stories do not bind to
Capacitor plugins directly.

Required adapter surfaces:

- scan adapter: barcode and QR capture, camera-permission handling
- RFID adapter: bridge to supported handheld or sled hardware, with graceful unsupported-state
  reporting
- media adapter: photo/video capture and upload staging
- signature adapter: signature canvas/input + attachment serialization
- secure session adapter: OS-backed token persistence
- runtime config adapter: environment/bootstrap resolution before Supabase client creation
- connectivity adapter: online/offline reachability and replay eligibility
- offline queue adapter: durable command storage, retry metadata, and replay orchestration

Each adapter requires:

1. a browser-safe fallback implementation for local development and tests
2. a native implementation behind the same contract
3. explicit failure modes surfaced to the workflow UI

---

## 5. Offline and sync model

### 5.1 Core principle

Offline support is a durable command replay problem, not a direct client-side database mutation
model.

The device may stage user intent locally, but authoritative writes occur only through approved
backend ingress:

- authenticated Supabase RPCs aligned with ADR-0024
- `ops_api` endpoints that hand durable work to Temporal when the workflow requires orchestration

### 5.2 Replay rules

Every offline-capable write must carry:

- a stable client-generated idempotency key
- actor identity and tenant context
- workflow/action type
- payload version
- created-at timestamp and last-attempt metadata

Replay requirements:

1. commands must be stored durably on-device before the UI confirms offline capture
2. replay order must be explicit for dependent commands
3. duplicate replays must be safe through idempotent server handling
4. irreversible failures must surface actionable operator states; they cannot fail silently
5. local queue processing must resume after app restart or connectivity restoration

### 5.3 Workflow boundary

Mobile flows must not depend on a live browser session or a transient `workflow.wait_condition(...)`
window surviving device disconnects. Human steps that span offline gaps must resolve through
durable workflow state plus reconnect/replay, not through an open browser tab assumption.

---

## 6. Data and security constraints

### 6.1 Auth and session storage

- Mobile sessions must use OS-backed secure storage, not plain web local storage.
- Supabase initialization on native clients must wait for runtime config and session bootstrap.
- Anonymous write access remains forbidden.

### 6.2 Tenant and data isolation

Current ADR-0019 defers some app-layer tenant scoping hardening. That posture is insufficient for a
broad mobile distribution surface. Before public app-store release:

1. tenant-isolation review must confirm field-mobile reads and writes are appropriately scoped
2. attachment access paths must be verified for tenant confinement
3. offline queue contents must be protected at rest on-device

### 6.3 Attachments

Photos, signatures, and related media may be staged locally while offline, but final persistence
must use signed upload/download paths or guarded backend endpoints consistent with existing storage
controls. Raw storage credentials must not be shipped in the app.

---

## 7. Downstream story contract

Story #589 owns the shared platform slice:

- Capacitor shell bootstrap
- runtime config boot path
- secure session storage
- capability adapter interfaces and initial implementations
- durable offline queue and replay primitives

Downstream workflow stories (#590-#594 and related epics) must build on that contract:

- they may add workflow-specific commands and UI
- they may not introduce a separate mobile framework
- they may not bypass the shared queue/adapters for writes or capture flows

---

## 8. Delivery sequence

1. Approve the runtime decision in ADR-0041 and this spec.
2. Implement the shared shell/adapters/queue slice in #589.
3. Build workflow-specific field apps on top of the approved runtime contract.
4. Complete security review before any public-distribution path.

---

## 9. Test strategy

Implementation against this spec must prove:

- browser and native implementations conform to the same adapter contracts
- runtime config resolves before authenticated client initialization
- secure session persistence survives restart without leaking secrets to plain storage
- offline commands persist across restart, replay idempotently, and surface terminal failures
- workflow UI remains operable through browser fallback for local/dev and automated tests
- attachment/signature flows preserve tenant-scoped authorization boundaries

---

## 10. Risks and review asks

- Capacitor reduces codebase sprawl, but native plugin quality and RFID hardware support still need
  deliberate validation.
- Offline replay that lacks explicit idempotency keys will create duplicate operational writes.
- Public mobile distribution increases the exposure of tenant-scoped data and requires security
  review before release.
- Runtime bootstrap ordering is fragile: native config must resolve before Supabase/auth clients are
  constructed.
