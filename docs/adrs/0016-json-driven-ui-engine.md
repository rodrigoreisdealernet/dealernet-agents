# ADR-0016: JSON-driven UI engine

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect

## Context
A rental ERP needs many entity-management screens (lists, details, edit forms, dashboards, action flows) that are structurally similar across asset, order, contract, invoice, etc. Hand-coding a React component tree per entity means duplication and a deploy for every new screen.

## Decision
Frontend pages are **declarative JSON** page definitions interpreted at runtime by a React **UI engine** (component renderer + action dispatcher + data-source hooks). New screens are authored as JSON over the generic entity model (ADR-0001), not as bespoke components.

## Consequences
- Rapid iteration; one engine serves all domain entities; screens map naturally onto the generic entity/SCD2 model.
- The JSON schema must be documented and validated, or rendering errors are opaque.
- Debugging spans both the JSON and the engine; a genuinely new widget needs both a schema addition and a React component.

## Alternatives considered
- **Bespoke React components per entity** — rejected: duplication, deploy per screen.
- **No-code builder** — rejected: too inflexible for complex actions.

## Evidence
- `frontend/src/engine/` (UIEngine, types, component renderer, data-source hooks) + tests
- `frontend/src/pages/*.json` (entity-list, entity-detail, dashboard, rental-availability, …)
- PRs #61 (`f71e737`), #77, #87 (`93c9d3a`), #88 (`e137a64`)
