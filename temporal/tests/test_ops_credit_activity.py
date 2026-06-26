from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.activities import ops_credit, ops_revrec
from temporal.src.agents.credit_analyst import run_credit_analyst as _run_credit_analyst
from temporalio.testing import ActivityEnvironment


class _FakeTransport:
    def __init__(self, responses: list[Mapping[str, Any]]) -> None:
        self._responses = list(responses)
        self.calls: list[list[dict[str, Any]]] = []

    async def complete(
        self,
        *,
        messages: list[Mapping[str, Any]],
        tools: list[Mapping[str, Any]],
        response_schema: dict[str, Any],
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> Mapping[str, Any]:
        del tools, response_schema, temperature, max_output_tokens
        self.calls.append([dict(m) for m in messages])
        return self._responses.pop(0)


def _assistant_response(
    *,
    content: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    usage: dict[str, Any] | None = None,
    response_id: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    msg: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        msg["tool_calls"] = tool_calls
    completion: dict[str, Any] = {"choices": [{"message": msg, "finish_reason": "stop"}]}
    if usage is not None:
        completion["usage"] = usage
    if response_id is not None:
        completion["id"] = response_id
    if model is not None:
        completion["model"] = model
    return completion


def _usage(prompt: int, completion: int) -> dict[str, Any]:
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
    }


class _FakeMeteringClient:
    """In-memory persistence double for the LLM usage sink (T-005/T-007).

    Mirrors the PostgREST client surface the sink uses: ``select`` (rate-card and
    tenant-plan lookups) and ``upsert`` (idempotent ``ops_llm_usage_event`` writes).
    """

    def __init__(
        self,
        *,
        rate_cards: list[dict[str, Any]] | None = None,
        tenant_plans: list[dict[str, Any]] | None = None,
    ) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "ops_llm_usage_event": [],
            "ops_llm_rate_card": list(rate_cards or []),
            "ops_tenant_llm_plan": list(tenant_plans or []),
        }

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        del columns, order_by, descending
        rows = [dict(row) for row in self.tables.get(resource, [])]
        for key, value in (filters or {}).items():
            rows = [row for row in rows if row.get(key) == value]
        if limit is not None:
            rows = rows[:limit]
        return rows

    def upsert(
        self, resource: str, payload: Mapping[str, Any], *, on_conflict: str
    ) -> dict[str, Any]:
        conflict_keys = [part.strip() for part in on_conflict.split(",")]
        row = dict(payload)
        table = self.tables.setdefault(resource, [])
        for idx, existing in enumerate(table):
            if all(existing.get(key) == row.get(key) for key in conflict_keys):
                merged = {**existing, **row}
                merged["id"] = existing.get("id")
                table[idx] = merged
                return merged
        row.setdefault("id", str(uuid4()))
        table.append(row)
        return row


# ---------------------------------------------------------------------------
# ops_credit_assess
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ops_credit_assess_direct_no_tool_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = "tenant-credit"
    account_id = str(uuid4())
    run_id = "run-credit-001"
    expected_response = {
        "account_id": account_id,
        "risk_level": "low",
        "proposed_action": "no_op",
        "current_exposure": 500.0,
        "aging_trend": "stable",
        "payment_behavior_score": 0.9,
        "evidence": ["all invoices paid"],
        "confidence": 0.85,
        "rationale": "Low-risk account.",
    }
    transport = _FakeTransport(
        [
            _assistant_response(
                content=json.dumps(expected_response),
                usage=_usage(800, 200),
                response_id="resp-final",
            )
        ]
    )

    async def _run_with_fake_transport(
        account_payload: Mapping[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        return await _run_credit_analyst(account_payload, transport=transport, **kwargs)

    monkeypatch.setattr(ops_credit, "run_credit_analyst", _run_with_fake_transport)
    metering = _FakeMeteringClient()
    monkeypatch.setattr(ops_revrec, "_ops_client", metering)

    env = ActivityEnvironment()
    result = await env.run(
        ops_credit.ops_credit_assess,
        {
            "tenant_id": tenant_id,
            "account_id": account_id,
            "credit_limit": 5000.0,
            "current_exposure": 500.0,
            "rental_data": {
                "entities": [
                    {
                        "entity_id": account_id,
                        "entity_type": "billing_account",
                        "data": {"tenant_id": tenant_id},
                    }
                ],
                "relationships": [],
                "facts": [],
                "time_series": [],
                "invoices": [],
                "rate_cards": [],
            },
        },
        {
            "system_prompt": "Assess credit risk.",
            "user_prompt_template": "Assess {account_id}.",
            "tools": [],
            "bounds": {"max_tool_rounds": 3},
        },
        run_id,
    )

    assert result["risk_level"] == "low"
    assert result["proposed_action"] == "no_op"
    assert result["confidence"] == 0.85
    assert "payment_history_missing" in result["stale_inputs"]

    # AC-001: exactly one usage event for the single real provider call, attributed
    # to tenant/run/agent/item with the provider-reported tokens.
    events = metering.tables["ops_llm_usage_event"]
    assert len(events) == 1
    event = events[0]
    assert event["tenant_id"] == tenant_id
    assert event["run_id"] == run_id
    assert event["agent_key"] == "credit-analyst"
    assert event["item_key"] == account_id
    assert event["round_index"] == 0
    assert event["prompt_tokens"] == 800
    assert event["completion_tokens"] == 200
    assert event["total_tokens"] == 1000
    assert event["metering_status"] == "ok"


@pytest.mark.asyncio
async def test_ops_credit_assess_with_rental_data_tool_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = "tenant-credit"
    account_id = str(uuid4())
    run_id = "run-credit-002"
    transport = _FakeTransport(
        [
            _assistant_response(
                tool_calls=[
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "query_time_series",
                            "arguments": json.dumps(
                                {"fact_key": "payment_received", "entity_id": account_id}
                            ),
                        },
                    }
                ],
                usage=_usage(1200, 80),
                response_id="resp-round-0",
            ),
            _assistant_response(
                content=json.dumps(
                    {
                        "account_id": account_id,
                        "risk_level": "high",
                        "proposed_action": "review_notice_of_intent",
                        "current_exposure": 12000.0,
                        "aging_trend": "deteriorating",
                        "payment_behavior_score": 0.25,
                        "evidence": ["overdue >90 days"],
                        "confidence": 0.9,
                        "rationale": "Hold recommended.",
                    }
                ),
                usage=_usage(1500, 350),
                response_id="resp-round-1",
            ),
        ]
    )

    async def _run_with_fake_transport(
        account_payload: Mapping[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        return await _run_credit_analyst(account_payload, transport=transport, **kwargs)

    monkeypatch.setattr(ops_credit, "run_credit_analyst", _run_with_fake_transport)
    metering = _FakeMeteringClient()
    monkeypatch.setattr(ops_revrec, "_ops_client", metering)

    env = ActivityEnvironment()
    result = await env.run(
        ops_credit.ops_credit_assess,
        {
            "tenant_id": tenant_id,
            "account_id": account_id,
            "credit_limit": 10000.0,
            "current_exposure": 12000.0,
            "branch_context": "Houston North · Note: Payment delays noted on last two invoices.",
            "rental_data": {
                "entities": [
                    {
                        "entity_id": account_id,
                        "entity_type": "billing_account",
                        "data": {"tenant_id": tenant_id},
                    }
                ],
                "relationships": [],
                "facts": [],
                "time_series": [
                    {
                        "point_id": str(uuid4()),
                        "entity_id": account_id,
                        "fact_key": "payment_received",
                        "observed_at": (datetime.now(UTC) - timedelta(days=5)).isoformat(),
                        "data_payload": {"amount": 500},
                    }
                ],
                "invoices": [
                    {
                        "entity_id": str(uuid4()),
                        "status": "overdue",
                        "amount": 12000.0,
                        "invoice_date": "2026-03-15T00:00:00Z",
                        "branch_id": "branch-1",
                    }
                ],
                "rate_cards": [],
            },
        },
        {
            "system_prompt": "Assess credit risk.",
            "user_prompt_template": "Assess {account_id}.",
            "tools": ["rental_data"],
            "bounds": {"max_tool_rounds": 5},
        },
        run_id,
    )

    assert result["proposed_action"] == "review_lien_preparation"
    assert result["oldest_overdue_days"] >= 60
    assert result["escalation_stage"] == "formal_escalation_review"
    assert result["risk_level"] == "high"

    # AC-001/AC-003: one usage event per real provider call (tool round + final),
    # written by the sink as the run progresses — same run/tenant/item, sequential
    # round_index, tokens matching what each completion reported.
    events = sorted(
        metering.tables["ops_llm_usage_event"], key=lambda row: row["round_index"]
    )
    assert len(events) == 2
    assert {e["run_id"] for e in events} == {run_id}
    assert {e["tenant_id"] for e in events} == {tenant_id}
    assert {e["agent_key"] for e in events} == {"credit-analyst"}
    assert {e["item_key"] for e in events} == {account_id}
    assert [e["round_index"] for e in events] == [0, 1]
    assert [e["prompt_tokens"] for e in events] == [1200, 1500]
    assert [e["completion_tokens"] for e in events] == [80, 350]
    assert all(e["metering_status"] == "ok" for e in events)


@pytest.mark.asyncio
async def test_ops_credit_assess_survives_metering_persistence_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Best-effort invariant: a metering outage must NOT break the credit agent.

    The sink's persistence is fire-and-forget — if the usage write raises, the
    assessment must still return its normal business result (issue #70 non-goal:
    metering never alters agent behavior).
    """
    tenant_id = "tenant-credit"
    account_id = str(uuid4())
    expected_response = {
        "account_id": account_id,
        "risk_level": "low",
        "proposed_action": "no_op",
        "current_exposure": 500.0,
        "aging_trend": "stable",
        "payment_behavior_score": 0.9,
        "evidence": ["all invoices paid"],
        "confidence": 0.85,
        "rationale": "Low-risk account.",
    }
    transport = _FakeTransport(
        [
            _assistant_response(
                content=json.dumps(expected_response),
                usage=_usage(800, 200),
                response_id="resp-final",
            )
        ]
    )

    async def _run_with_fake_transport(
        account_payload: Mapping[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        return await _run_credit_analyst(account_payload, transport=transport, **kwargs)

    monkeypatch.setattr(ops_credit, "run_credit_analyst", _run_with_fake_transport)

    class _RaisingMeteringClient(_FakeMeteringClient):
        def upsert(
            self, resource: str, payload: Mapping[str, Any], *, on_conflict: str
        ) -> dict[str, Any]:
            raise RuntimeError("simulated metering persistence outage")

    metering = _RaisingMeteringClient()
    monkeypatch.setattr(ops_revrec, "_ops_client", metering)

    env = ActivityEnvironment()
    result = await env.run(
        ops_credit.ops_credit_assess,
        {
            "tenant_id": tenant_id,
            "account_id": account_id,
            "credit_limit": 5000.0,
            "current_exposure": 500.0,
            "rental_data": {
                "entities": [
                    {
                        "entity_id": account_id,
                        "entity_type": "billing_account",
                        "data": {"tenant_id": tenant_id},
                    }
                ],
                "relationships": [],
                "facts": [],
                "time_series": [],
                "invoices": [],
                "rate_cards": [],
            },
        },
        {
            "system_prompt": "Assess credit risk.",
            "user_prompt_template": "Assess {account_id}.",
            "tools": [],
            "bounds": {"max_tool_rounds": 3},
        },
        "run-credit-metering-down",
    )

    # The business assessment is unaffected by the metering write failure.
    assert result["risk_level"] == "low"
    assert result["proposed_action"] == "no_op"
    assert result["confidence"] == 0.85
    # Nothing was persisted (the write raised and was swallowed), and no exception
    # propagated out of the activity.
    assert metering.tables["ops_llm_usage_event"] == []


# ---------------------------------------------------------------------------
# ops_scope_credit_accounts
# ---------------------------------------------------------------------------


class _FakeOpsPersistenceClient:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "rental_current_entity_state": [],
            "rental_current_relationships": [],
            "time_series_points": [],
        }

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        del columns, order_by, descending
        rows = [dict(row) for row in self.tables.get(resource, [])]
        for key, value in (filters or {}).items():
            rows = [row for row in rows if row.get(key) == value]
        if limit is not None:
            rows = rows[:limit]
        return rows


def test_ops_scope_credit_accounts_returns_overdue_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = "tenant-scope"
    account_id_overdue = str(uuid4())
    account_id_ok = str(uuid4())
    invoice_id_overdue = str(uuid4())

    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        {
            "entity_id": account_id_overdue,
            "entity_type": "billing_account",
            "data": {
                "tenant_id": tenant_id,
                "credit_limit": 5000,
                "current_exposure": 6000,
            },
        },
        {
            "entity_id": account_id_ok,
            "entity_type": "billing_account",
            "data": {
                "tenant_id": tenant_id,
                "credit_limit": 10000,
                "current_exposure": 1000,
            },
        },
        {
            "entity_id": invoice_id_overdue,
            "entity_type": "invoice",
            "data": {
                "tenant_id": tenant_id,
                "billing_account_id": account_id_overdue,
                "status": "overdue",
                "amount": 2000,
            },
        },
    ]

    monkeypatch.setattr(
        ops_credit.ops_revrec, "_get_ops_persistence_client", lambda: client
    )

    result = ops_credit.ops_scope_credit_accounts(tenant_id, {})

    assert len(result) == 1
    assert result[0]["account_id"] == account_id_overdue
    assert result[0]["overdue_amount"] == 2000.0


def test_ops_scope_credit_accounts_filters_by_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = "tenant-a"
    other_tenant_id = "tenant-b"
    account_id = str(uuid4())
    other_account_id = str(uuid4())

    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        {
            "entity_id": account_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 5000, "current_exposure": 1000},
        },
        {
            "entity_id": str(uuid4()),
            "entity_type": "invoice",
            "data": {
                "tenant_id": tenant_id,
                "billing_account_id": account_id,
                "status": "overdue",
                "amount": 900,
            },
        },
        {
            "entity_id": other_account_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": other_tenant_id, "credit_limit": 5000, "current_exposure": 1000},
        },
    ]

    monkeypatch.setattr(
        ops_credit.ops_revrec, "_get_ops_persistence_client", lambda: client
    )

    result = ops_credit.ops_scope_credit_accounts(tenant_id, {})

    assert len(result) == 1
    assert result[0]["account_id"] == account_id


def test_ops_scope_credit_accounts_respects_max(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = "tenant-max"
    client = _FakeOpsPersistenceClient()
    rows: list[dict[str, Any]] = []
    for _ in range(10):
        account_id = str(uuid4())
        rows.append(
            {
                "entity_id": account_id,
                "entity_type": "billing_account",
                "data": {"tenant_id": tenant_id, "credit_limit": 5000, "current_exposure": 1000},
            }
        )
        rows.append(
            {
                "entity_id": str(uuid4()),
                "entity_type": "invoice",
                "data": {
                    "tenant_id": tenant_id,
                    "billing_account_id": account_id,
                    "status": "overdue",
                    "amount": 1000,
                },
            }
        )
    client.tables["rental_current_entity_state"] = rows

    monkeypatch.setattr(
        ops_credit.ops_revrec, "_get_ops_persistence_client", lambda: client
    )

    result = ops_credit.ops_scope_credit_accounts(tenant_id, {"max_accounts": 3})

    assert len(result) == 3


# ---------------------------------------------------------------------------
# ops_scope_credit_accounts — threshold filtering
# ---------------------------------------------------------------------------


def _make_account(
    tenant_id: str,
    *,
    credit_limit: float = 10000,
    current_exposure: float = 1000,
) -> dict:
    return {
        "entity_id": str(uuid4()),
        "entity_type": "billing_account",
        "data": {
            "tenant_id": tenant_id,
            "credit_limit": credit_limit,
            "current_exposure": current_exposure,
        },
    }


def test_ops_scope_credit_accounts_excludes_healthy_below_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Accounts that don't meet any criterion are excluded when thresholds are set."""
    tenant_id = "tenant-thresh"
    healthy_id = str(uuid4())
    overdue_id = str(uuid4())
    invoice_id = str(uuid4())

    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        # Healthy account: low exposure (20%), no overdue
        {
            "entity_id": healthy_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 10000, "current_exposure": 2000},
        },
        # Overdue account: overdue amount above threshold
        {
            "entity_id": overdue_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 5000, "current_exposure": 3000},
        },
        {
            "entity_id": invoice_id,
            "entity_type": "invoice",
            "data": {
                "tenant_id": tenant_id,
                "billing_account_id": overdue_id,
                "status": "overdue",
                "amount": 1500,
            },
        },
    ]
    monkeypatch.setattr(ops_credit.ops_revrec, "_get_ops_persistence_client", lambda: client)

    result = ops_credit.ops_scope_credit_accounts(
        tenant_id,
        {"thresholds": {"overdue_threshold": 500, "exposure_utilization_pct": 80}},
    )

    account_ids = [r["account_id"] for r in result]
    # Healthy account (20% utilization, no overdue) must NOT appear
    assert healthy_id not in account_ids
    # Overdue account must appear (overdue 1500 >= threshold 500)
    assert overdue_id in account_ids


def test_ops_scope_credit_accounts_includes_over_limit_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Account at or above the utilization threshold is included."""
    tenant_id = "tenant-util"
    over_limit_id = str(uuid4())
    under_limit_id = str(uuid4())

    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        {
            "entity_id": over_limit_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 10000, "current_exposure": 9000},
        },
        {
            "entity_id": under_limit_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 10000, "current_exposure": 2000},
        },
        {
            "entity_id": str(uuid4()),
            "entity_type": "invoice",
            "data": {
                "tenant_id": tenant_id,
                "billing_account_id": over_limit_id,
                "status": "overdue",
                "amount": 900,
            },
        },
    ]
    monkeypatch.setattr(ops_credit.ops_revrec, "_get_ops_persistence_client", lambda: client)

    result = ops_credit.ops_scope_credit_accounts(
        tenant_id,
        {"thresholds": {"exposure_utilization_pct": 80}},
    )

    account_ids = [r["account_id"] for r in result]
    # 90% utilization plus overdue AR >= 80% threshold → included
    assert over_limit_id in account_ids
    # 20% utilization < 80% threshold, no overdue → excluded
    assert under_limit_id not in account_ids


def test_ops_scope_credit_accounts_excludes_new_accounts_without_overdue_ar(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Collections scope stays focused on overdue AR, not new account setup."""
    tenant_id = "tenant-new"
    new_account_id = str(uuid4())
    established_id = str(uuid4())

    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        # New account: no credit limit set
        {
            "entity_id": new_account_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 0, "current_exposure": 500},
        },
        # Established account: low risk, would be excluded by thresholds
        {
            "entity_id": established_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 10000, "current_exposure": 100},
        },
    ]
    monkeypatch.setattr(ops_credit.ops_revrec, "_get_ops_persistence_client", lambda: client)

    result = ops_credit.ops_scope_credit_accounts(
        tenant_id,
        {"thresholds": {"overdue_threshold": 500, "exposure_utilization_pct": 80}},
    )

    account_ids = [r["account_id"] for r in result]
    assert new_account_id not in account_ids
    assert established_id not in account_ids


def test_ops_scope_credit_accounts_no_thresholds_returns_overdue_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without thresholds the queue still stays focused on overdue accounts."""
    tenant_id = "tenant-nothresh"
    overdue_id = str(uuid4())
    healthy_id = str(uuid4())
    invoice_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        {
            "entity_id": overdue_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 10000, "current_exposure": 500},
        },
        {
            "entity_id": healthy_id,
            "entity_type": "billing_account",
            "data": {"tenant_id": tenant_id, "credit_limit": 10000, "current_exposure": 500},
        },
        {
            "entity_id": invoice_id,
            "entity_type": "invoice",
            "data": {
                "tenant_id": tenant_id,
                "billing_account_id": overdue_id,
                "status": "overdue",
                "amount": 750,
            },
        },
    ]
    monkeypatch.setattr(ops_credit.ops_revrec, "_get_ops_persistence_client", lambda: client)

    result = ops_credit.ops_scope_credit_accounts(tenant_id, {})

    assert [row["account_id"] for row in result] == [overdue_id]


# ---------------------------------------------------------------------------
# _credit_finding_for_storage
# ---------------------------------------------------------------------------


def test_credit_finding_for_storage_maps_fields() -> None:
    account_id = str(uuid4())
    finding = {
        "account_id": account_id,
        "risk_level": "high",
        "proposed_action": "review_notice_of_intent",
        "current_exposure": 9500.0,
        "overdue_amount": 6200.0,
        "account_label": "BA-TX-0001",
        "customer_name": "Acme Construction",
        "branch_context": "Houston North",
        "oldest_overdue_days": 67,
        "escalation_stage": "approaching_formal_escalation",
        "material_signal_key": "signal-123",
        "stale_inputs": ["payment_history_stale"],
        "operating_model_tags": ["credit-billing-analyst:t1", "credit-billing-analyst:t8"],
        "evidence": ["overdue invoices"],
        "confidence": 0.88,
        "rationale": "High risk",
        "fingerprint": f"{account_id}:collections_priority",
        "tenant_id": "t-1",
    }
    stored = ops_credit._credit_finding_for_storage(finding)  # noqa: SLF001

    assert stored["contract_id"] == account_id
    assert stored["line_item_id"] is None
    assert stored["finding_type"] == "collections_priority"
    assert stored["proposed_action"] == "review_notice_of_intent"
    assert stored["severity"] == "high"
    assert stored["expected"]["account_label"] == "BA-TX-0001"
    assert stored["expected"]["branch_context"] == "Houston North"
    assert stored["billed"]["amount"] == 9500.0


def test_risk_level_to_severity_mapping() -> None:
    assert ops_credit._risk_level_to_severity("low") == "low"  # noqa: SLF001
    assert ops_credit._risk_level_to_severity("medium") == "medium"  # noqa: SLF001
    assert ops_credit._risk_level_to_severity("high") == "high"  # noqa: SLF001
    assert ops_credit._risk_level_to_severity("critical") == "high"  # noqa: SLF001
    assert ops_credit._risk_level_to_severity("unknown_value") == "medium"  # noqa: SLF001
