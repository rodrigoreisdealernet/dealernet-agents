# ADR-0004: Signal-driven human-in-the-loop approval gates

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect

## Context
Both the rental workflows (ADR-0003) and the agentic Operations Factory (ADR-0020) take actions that are irreversible or money-moving: approving an order, executing a contract, posting an invoice adjustment, transferring an asset. These must not happen autonomously.

## Decision
Human approval is implemented as **Temporal signals**: the workflow blocks on `workflow.wait_condition(...)` until a human dispatches an approval/rejection signal (e.g. `approve`, `convert`, `approve_finding`, `reject_finding`). For the Operations Factory, `auto_apply` is **hard-locked false in code** regardless of stored config (defense in depth) — agents propose; humans dispose.

## Consequences
- Every irreversible action has a durable, auditable gate; the approver is recorded.
- A workflow can hold open indefinitely waiting on a signal — approval SLA must be monitored (the Ops Monitor watches for gates stuck past SLA).
- Requires a UI/API to dispatch signals (the rental UI today; the Findings & Approvals console for ops, ADR-0020).
- No bulk "approve all" in v1, deliberately.

## Alternatives considered
- **Auto-apply with after-the-fact audit** — rejected for money/asset actions.
- **Email/out-of-band approval** — rejected: latency, no durable state binding.

## Evidence
- `temporal/src/workflows/example/approval_workflow.py` (reference signal-gate implementation)
- `temporal/src/workflows/rental/rental_workflow.py` (quote/approve/convert/cancel signals + `wait_condition`)
- `docs/specs/operations-factory-agentic-workflows.md` §3 (locked: agents propose, humans dispose), §4.3
