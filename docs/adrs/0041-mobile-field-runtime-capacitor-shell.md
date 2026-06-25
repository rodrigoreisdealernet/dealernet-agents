# ADR-0041: Capacitor shell for the field-mobile runtime

- **Status:** Accepted
- **Date:** 2026-06-11
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** —

## Context

The backlog now includes a shared field-mobile platform epic (#452) and a platform story (#589)
covering offline-capable iOS/Android workflows, barcode/QR scanning, RFID support, attachments,
signatures, and fast field execution.

The repository already has a browser-accessible field workflow surface at `/field/mobile`, plus the
core frontend architecture we want to preserve:

- React + Vite frontend with TanStack Router/Query
- JSON-driven UI engine (ADR-0016)
- authenticated browser/mobile write boundary through guarded RPCs (ADR-0024)
- Temporal for durable orchestration when workflows span long-running operational steps (ADR-0003)

The decision needed here is whether field mobile should stay browser-only, fork to a separate native
stack, or package the existing app in a native shell.

## Decision

We use a Capacitor shell around the existing React + TanStack + JSON-driven frontend for the
field-mobile runtime.

The browser route `/field/mobile` remains the fallback and primary development surface, while native
iOS/Android packaging exposes device-only capabilities through shared adapters for scanning, RFID,
capture, secure storage, connectivity, and offline command replay.

## Consequences

- We keep one primary UI codebase instead of splitting feature delivery across web and a second
  native framework.
- Device capabilities now require explicit adapter contracts and browser-safe fallbacks.
- Offline work must be implemented as durable idempotent command capture/replay through guarded
  backend ingress rather than disconnected direct table writes.
- Native startup must resolve runtime config before Supabase/auth initialization.
- Mobile session persistence must move to OS-backed secure storage.
- Public app-store distribution remains gated on stronger tenant/data-isolation hardening than the
  current ADR-0019 posture.

## Alternatives considered

- **Browser-only PWA:** rejected because it does not give a strong enough path for native scanning,
  RFID hardware bridges, secure storage, and packaged field deployment.
- **Separate React Native or Flutter app:** rejected because it duplicates route/workflow logic and
  creates an avoidable second UI stack for a product that already has a suitable React frontend.
- **Direct native apps per task workflow:** rejected because it would fragment the platform and make
  Quick Order, Return, Picking, and Confirm Load evolve under incompatible runtime assumptions.

## Evidence

- Issue #452
- Issue #589
- `frontend/src/routes/field/mobile.tsx`
- `frontend/src/test/mobile-field-workflow.test.tsx`
- `docs/specs/mobile-field-platform.md`
