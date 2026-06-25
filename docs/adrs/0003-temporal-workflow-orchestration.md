# ADR-0003: Temporal for workflow orchestration

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect

## Context
Rental operations are long-running, multi-step, and human-interactive: an order is quoted, approved, converted to a contract, checked out, returned, inspected, and invoiced — over days, with retries, durable timers, and decision points. Embedding this in request handlers or DB triggers gives no durable state, history, or replay, and is hard to test.

## Decision
We use **Temporal** (Python SDK `temporalio` 1.5.0) to orchestrate rental-domain workflows. State machines are workflow code; side effects are activities with `start_to_close_timeout` + `RetryPolicy`; state transitions are driven by `@workflow.signal` handlers with `workflow.wait_condition(...)`; external state is exposed via `@workflow.query`.

## Consequences
- Durable execution, full history, and replay; deterministic, unit-testable workflow logic (activities mocked).
- Adds an operational dependency: a Temporal cluster (self-hosted in-cluster alongside the worker) plus the worker deployment.
- Activity timeout/retry tuning matters: too short loses work, too long delays recovery. Signals can block indefinitely without a timeout (see ADR-0004).
- Becomes the substrate for the agentic Operations Factory (ADR-0020).

## Alternatives considered
- **AWS Step Functions** — rejected: proprietary, poor local dev, cloud coupling.
- **Supabase/DB-trigger event flows** — rejected: no durable timers, history, or replay; hard to test.

## Evidence
- `temporal/src/worker.py`; `temporal/src/workflows/rental/` (rental_workflow, transfer, maintenance, inspection, invoice); `temporal/src/workflows/example/approval_workflow.py`
- `temporal/pyproject.toml` (`temporalio==1.5.0`)
- PR #60 (`4adba46`) restore operational-flow domain models; PR #73 (`c3f6838`) regression coverage; PR #63 (`fc0effa`) pytest-asyncio for real test execution
