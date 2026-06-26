"""Unit tests for LLM usage pricing + crash-safe persistence (issue #70 T-007).

Covers the Python side of the metering foundation:
- ``price_usage`` — Azure cost + per-tenant markup (AC-004) and the
  retry/repair "count cost, don't charge" rule (AC-005);
- ``build_usage_sink`` — pricing + attribution into one persisted event row;
- ``persist_llm_usage_event`` — idempotent upsert on ``idempotency_key`` (AC-006);
- usage with no provider tokens is never priced (AC-002 base).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.activities import ops_revrec
from temporal.src.activities.ops_llm_usage import (
    build_usage_sink,
    persist_llm_usage_event,
    price_usage,
)
from temporal.src.agents.openai_client import LlmCallUsage

# gpt-4.1-mini placeholder rate card (per-1k, USD) — mirrors the migration seed.
_RATE_CARD = {
    "id": "rate-card-gpt-4-1-mini",
    "provider": "azure_openai",
    "provider_model": "gpt-4.1-mini",
    "unit_of_measure": "per_1k",
    "price_input": 0.0004,
    "price_output": 0.0016,
    "price_cached_input": 0.0001,
}
_DEFAULT_PLAN = {"tenant_id": None, "plan_key": "default", "markup_pct": 0.30}


class _FakeOpsPersistenceClient:
    """In-memory double for the PostgREST service-role client used by the sink."""

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

    def insert(self, resource: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        row = dict(payload)
        row.setdefault("id", str(uuid4()))
        self.tables.setdefault(resource, []).append(row)
        return row

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


@pytest.fixture()
def fake_ops_client(monkeypatch: pytest.MonkeyPatch) -> _FakeOpsPersistenceClient:
    client = _FakeOpsPersistenceClient(
        rate_cards=[dict(_RATE_CARD)], tenant_plans=[dict(_DEFAULT_PLAN)]
    )
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    return client


def _ok_call(
    *,
    prompt: int,
    completion: int,
    cached: int = 0,
    chargeable: bool = True,
    chargeability_reason: str | None = None,
    schema_attempt: int = 0,
    model: str | None = "gpt-4.1-mini",
    response_id: str | None = "resp-1",
) -> LlmCallUsage:
    return LlmCallUsage(
        round_index=0,
        schema_attempt=schema_attempt,
        model=model,
        response_id=response_id,
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
        cached_input_tokens=cached,
        metering_status="ok",
        chargeable=chargeable,
        chargeability_reason=chargeability_reason,
        raw_usage={"prompt_tokens": prompt, "completion_tokens": completion},
    )


# ---------------------------------------------------------------------------
# price_usage — AC-004 (cost = Azure + markup)
# ---------------------------------------------------------------------------


def test_price_usage_applies_azure_cost_plus_markup() -> None:
    """AC-004: 1000 in / 500 out / 0 cached → provider 0.0012, billable 0.00156."""
    call = _ok_call(prompt=1000, completion=500)

    provider_cost, billable_cost = price_usage(
        call, rate_card_row=_RATE_CARD, markup_pct=0.30
    )

    # Exact values (the spec allows ±1¢; these pin to the exact cents).
    assert provider_cost == pytest.approx(0.0012)
    assert billable_cost == pytest.approx(0.00156)
    # Markup is exactly 30% of the provider cost.
    assert billable_cost == pytest.approx(provider_cost * 1.30)


def test_price_usage_discounts_cached_input_tokens() -> None:
    """Cached prompt tokens are billed at the cached rate, not the input rate."""
    # 1000 prompt of which 400 cached, 500 completion.
    call = _ok_call(prompt=1000, completion=500, cached=400)

    provider_cost, _ = price_usage(call, rate_card_row=_RATE_CARD, markup_pct=0.30)

    # (600*0.0004 + 400*0.0001 + 500*0.0016)/1000 = (0.24 + 0.04 + 0.8)/1000
    assert provider_cost == pytest.approx(0.00108)


def test_price_usage_returns_none_when_usage_missing() -> None:
    """AC-002 base: a 'missing' call is never priced — no inferred tokens."""
    missing = LlmCallUsage(round_index=0, schema_attempt=0, metering_status="missing")

    assert price_usage(missing, rate_card_row=_RATE_CARD, markup_pct=0.30) == (None, None)


def test_price_usage_returns_none_when_no_rate_card() -> None:
    """No matching rate card → cannot price (never guess)."""
    call = _ok_call(prompt=1000, completion=500)

    assert price_usage(call, rate_card_row=None, markup_pct=0.30) == (None, None)


# ---------------------------------------------------------------------------
# AC-005 — retry/repair counts cost but is not charged
# ---------------------------------------------------------------------------


def test_price_usage_schema_repair_counts_cost_without_markup() -> None:
    """AC-005: a non-chargeable repair call has provider cost but no markup."""
    repair = _ok_call(
        prompt=560,
        completion=45,
        chargeable=False,
        chargeability_reason="schema_repair",
        schema_attempt=1,
    )

    provider_cost, billable_cost = price_usage(
        repair, rate_card_row=_RATE_CARD, markup_pct=0.30
    )

    # (560*0.0004 + 45*0.0016)/1000 = 0.000296
    assert provider_cost == pytest.approx(0.000296)
    assert provider_cost > 0
    # Not charged → no markup, billable equals the provider cost.
    assert billable_cost == pytest.approx(provider_cost)


@pytest.mark.asyncio
async def test_usage_sink_persists_priced_event_with_attribution(
    fake_ops_client: _FakeOpsPersistenceClient,
) -> None:
    """AC-004 end-to-end: sink resolves rate-card + markup and persists the cost."""
    sink = build_usage_sink(
        tenant_id="tenant-x",
        run_id="run-x",
        workflow_id="wf-x",
        activity_id="act-x",
        activity_attempt=1,
        agent_key="credit-analyst",
        item_key="account-x",
    )

    await sink(_ok_call(prompt=1000, completion=500, response_id="resp-final"))

    rows = fake_ops_client.tables["ops_llm_usage_event"]
    assert len(rows) == 1
    row = rows[0]
    assert row["tenant_id"] == "tenant-x"
    assert row["run_id"] == "run-x"
    assert row["agent_key"] == "credit-analyst"
    assert row["item_key"] == "account-x"
    assert row["provider_cost_usd"] == pytest.approx(0.0012)
    assert row["billable_cost_usd"] == pytest.approx(0.00156)
    assert float(row["markup_pct"]) == pytest.approx(0.30)
    assert row["rate_card_id"] == _RATE_CARD["id"]
    assert row["priced_at"] is not None


@pytest.mark.asyncio
async def test_usage_sink_persists_repair_call_not_chargeable(
    fake_ops_client: _FakeOpsPersistenceClient,
) -> None:
    """AC-005: a schema-repair call persists chargeable=false + reason, cost>0."""
    sink = build_usage_sink(
        tenant_id="tenant-x",
        run_id="run-x",
        workflow_id="wf-x",
        activity_id="act-x",
        activity_attempt=1,
        agent_key="credit-analyst",
        item_key="account-x",
    )

    await sink(
        _ok_call(
            prompt=560,
            completion=45,
            chargeable=False,
            chargeability_reason="schema_repair",
            schema_attempt=1,
            response_id="resp-repair",
        )
    )

    row = fake_ops_client.tables["ops_llm_usage_event"][0]
    assert row["chargeable"] is False
    assert row["chargeability_reason"] == "schema_repair"
    assert row["provider_cost_usd"] == pytest.approx(0.000296)
    assert row["provider_cost_usd"] > 0


@pytest.mark.asyncio
async def test_usage_sink_marks_missing_usage_unpriced(
    fake_ops_client: _FakeOpsPersistenceClient,
) -> None:
    """AC-002: a completion without usage persists 'missing' with null costs."""
    sink = build_usage_sink(
        tenant_id="tenant-x",
        run_id="run-x",
        workflow_id="wf-x",
        activity_id="act-x",
        activity_attempt=1,
        agent_key="credit-analyst",
        item_key="account-x",
    )

    await sink(
        LlmCallUsage(
            round_index=0,
            schema_attempt=0,
            model="gpt-4.1-mini",
            response_id="resp-missing",
            metering_status="missing",
        )
    )

    row = fake_ops_client.tables["ops_llm_usage_event"][0]
    assert row["metering_status"] == "missing"
    assert row["prompt_tokens"] is None
    assert row["provider_cost_usd"] is None
    assert row["billable_cost_usd"] is None


# ---------------------------------------------------------------------------
# AC-006 — idempotent persistence (no double counting)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_persist_llm_usage_event_is_idempotent_on_retry(
    fake_ops_client: _FakeOpsPersistenceClient,
) -> None:
    """AC-006: re-persisting the same response_id/idempotency_key yields 1 row."""
    event = {
        "tenant_id": "tenant-x",
        "run_id": "run-x",
        "agent_key": "credit-analyst",
        "item_key": "account-x",
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "metering_status": "ok",
        "idempotency_key": "run-x:wf-x:act-x:1:account-x:0:resp-final",
    }

    first = await persist_llm_usage_event(dict(event))
    # An activity retry replays the same call but with a corrected/late field
    # (e.g. pricing resolved on the second attempt). Same idempotency_key → merge.
    second = await persist_llm_usage_event(
        {**event, "completion_tokens": 512, "provider_cost_usd": 0.0012}
    )

    table = fake_ops_client.tables["ops_llm_usage_event"]
    assert len(table) == 1
    # Upsert merges onto the existing row identity instead of inserting a new one,
    # and the merged row reflects the updated fields (not a no-op identity merge).
    assert first["id"] == second["id"]
    assert table[0]["id"] == first["id"]
    assert table[0]["completion_tokens"] == 512
    assert table[0]["provider_cost_usd"] == 0.0012


@pytest.mark.asyncio
async def test_usage_sink_double_fire_does_not_double_count(
    fake_ops_client: _FakeOpsPersistenceClient,
) -> None:
    """AC-006 through the sink: the same call twice still leaves a single row."""
    sink = build_usage_sink(
        tenant_id="tenant-x",
        run_id="run-x",
        workflow_id="wf-x",
        activity_id="act-x",
        activity_attempt=1,
        agent_key="credit-analyst",
        item_key="account-x",
    )
    call = _ok_call(prompt=1000, completion=500, response_id="resp-dup")

    await sink(call)
    await sink(call)

    assert len(fake_ops_client.tables["ops_llm_usage_event"]) == 1


# ---------------------------------------------------------------------------
# Best-effort invariant — metering must never break the agent (issue #70 non-goal)
# ---------------------------------------------------------------------------


class _RaisingUpsertClient(_FakeOpsPersistenceClient):
    """Persistence double whose write path fails (e.g. DB/network outage)."""

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        raise RuntimeError("simulated persistence outage on upsert")


class _RaisingSelectClient(_FakeOpsPersistenceClient):
    """Persistence double whose pricing lookups fail before any write."""

    def select(self, resource: str, **kwargs: Any) -> list[dict[str, Any]]:
        raise RuntimeError("simulated persistence outage on select")


@pytest.mark.asyncio
async def test_usage_sink_swallows_upsert_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A persistence write failure is swallowed — the sink never propagates it."""
    client = _RaisingUpsertClient(
        rate_cards=[dict(_RATE_CARD)], tenant_plans=[dict(_DEFAULT_PLAN)]
    )
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    sink = build_usage_sink(
        tenant_id="tenant-x",
        run_id="run-x",
        workflow_id="wf-x",
        activity_id="act-x",
        activity_attempt=1,
        agent_key="credit-analyst",
        item_key="account-x",
    )

    # Must return normally (None) despite the upsert raising underneath.
    result = await sink(_ok_call(prompt=1000, completion=500))

    assert result is None
    assert client.tables["ops_llm_usage_event"] == []


@pytest.mark.asyncio
async def test_usage_sink_swallows_pricing_lookup_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failure while resolving rate-card/markup is swallowed, not propagated."""
    client = _RaisingSelectClient()
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    sink = build_usage_sink(
        tenant_id="tenant-x",
        run_id="run-x",
        workflow_id="wf-x",
        activity_id="act-x",
        activity_attempt=1,
        agent_key="credit-analyst",
        item_key="account-x",
    )

    result = await sink(_ok_call(prompt=1000, completion=500))

    assert result is None
    assert client.tables["ops_llm_usage_event"] == []

