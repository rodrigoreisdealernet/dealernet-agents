from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.activities import ops_credit
from temporal.src.agents.credit_analyst import run_credit_analyst as _run_credit_analyst


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
) -> dict[str, Any]:
    msg: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        msg["tool_calls"] = tool_calls
    return {"choices": [{"message": msg}]}


# ---------------------------------------------------------------------------
# ops_credit_assess
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ops_credit_assess_direct_no_tool_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    transport = _FakeTransport([_assistant_response(content=json.dumps(expected_response))])

    async def _run_with_fake_transport(
        account_payload: Mapping[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        return await _run_credit_analyst(account_payload, transport=transport, **kwargs)

    monkeypatch.setattr(ops_credit, "run_credit_analyst", _run_with_fake_transport)

    result = await ops_credit.ops_credit_assess(
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
    )

    assert result["risk_level"] == "low"
    assert result["proposed_action"] == "no_op"
    assert result["confidence"] == 0.85
    assert "payment_history_missing" in result["stale_inputs"]


@pytest.mark.asyncio
async def test_ops_credit_assess_with_rental_data_tool_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = "tenant-credit"
    account_id = str(uuid4())
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
                ]
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
                )
            ),
        ]
    )

    async def _run_with_fake_transport(
        account_payload: Mapping[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        return await _run_credit_analyst(account_payload, transport=transport, **kwargs)

    monkeypatch.setattr(ops_credit, "run_credit_analyst", _run_with_fake_transport)

    result = await ops_credit.ops_credit_assess(
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
    )

    assert result["proposed_action"] == "review_lien_preparation"
    assert result["oldest_overdue_days"] >= 60
    assert result["escalation_stage"] == "formal_escalation_review"
    assert result["risk_level"] == "high"


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
