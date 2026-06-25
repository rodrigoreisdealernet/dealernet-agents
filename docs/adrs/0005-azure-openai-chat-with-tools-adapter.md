# ADR-0005: Azure OpenAI `chat_with_tools` agentic adapter

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect

## Context
The Operations Factory (ADR-0020) needs agents that reason over internal rental data and return deterministic, auditable, structured results from inside Temporal activities. A sibling project (`ma-app`) already solved this pattern against Azure OpenAI; rebuilding it would duplicate effort and diverge.

## Decision
We ported `ma-app`'s **Azure OpenAI `chat_with_tools()`** adapter into the Temporal worker. It runs a bounded tool-use loop (`max_tool_rounds`, `max_attempts`), enforces a strict JSON-schema response, tracks executed tool calls for audit, and frames all tool/data output as **untrusted evidence** (embedded instructions ignored). The call site is provider-agnostic, but v1 ships on Azure OpenAI for consistency with `ma-app` and the factory agents.

## Consequences
- Reuse of a proven loop; structured-output guarantees and audit-friendly call tracking.
- Provider coupling to Azure OpenAI for the worker (note: GitHub-Actions factory agents also run on Azure OpenAI / gpt-5.4).
- Every tool is a deterministic Python function invoked via a `tool_executor` callback; the LLM never executes anything directly.
- Per-activity bounds + Temporal `RetryPolicy` contain runaway loops and transient failures.

## Alternatives considered
- **Build a new agent loop from scratch** — rejected: duplicates `ma-app`.
- **A different LLM provider** — deferred; the seam is provider-agnostic so this can change without rearchitecting.

## Evidence
- PR #134 (`b963105`) "Port Azure OpenAI chat-with-tools adapter into the temporal worker"
- `temporal/src/agents/openai_client.py` (+ tests)
- Reference: `ma-app/temporal/src/agents/openai_client.py`
- `docs/specs/operations-factory-agentic-workflows.md` §4.2
