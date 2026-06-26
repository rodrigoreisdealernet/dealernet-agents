"""Tests for the static DIA agent mission catalog (issue #125, design-spec §2 RF-1, U2).

Each test maps back to an acceptance criterion (AC) from
``docs/specs/125-feat-ops-ficha-de-missao.md``. The catalog is versioned in code
and exposed read-only by the ops-api; it must carry only i18n keys plus
structural data (action list, ``assist_only``, "predicts" key) and never the
agent's ``system_prompt`` / ``user_prompt_template``.
"""

from __future__ import annotations

from dataclasses import fields

import pytest
from fastapi.testclient import TestClient

from temporal.src.ops_api.agent_catalog import (
    AGENT_CATALOG,
    AgentMission,
    agent_catalog_payload,
)
from temporal.src.ops_api.app import create_app

# The four DIA agents covered by this unit (and no others). Real action
# vocabulary for the two enum-bound agents is asserted against the agents'
# ``_RECOMMENDED_ACTIONS`` tuples in ``temporal/src/agents/``.
_EXPECTED_AGENT_KEYS = frozenset(
    {
        "vehicle-aging-analyst",
        "collections-prioritizer",
        "parts-inventory-advisor",
        "service-estimate-rescue",
    }
)

# Real, code-backed action vocabulary (AC: "Vocabulário de ações bate com o
# código real"). Sourced from agents/vehicle_aging_analyst.py and
# agents/service_estimate_rescue.py ``_RECOMMENDED_ACTIONS``.
_VEHICLE_AGING_ACTIONS = ("monitor", "markdown", "transfer", "prioritize_sale", "wholesale_auction")
_SERVICE_RESCUE_ACTIONS = ("contact_customer", "offer_discount", "reprice", "escalate", "monitor")

# Field names that would leak the raw prompt — must never appear in any payload.
_FORBIDDEN_PROMPT_FIELDS = ("system_prompt", "user_prompt_template", "prompt")


class _FakeSupabaseClient:
    """Minimal stand-in: the catalog endpoint performs no auth and no DB access."""

    async def authenticate_user(self, *, user_jwt: str):  # pragma: no cover - not called
        raise AssertionError("catalog endpoint must not authenticate")


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app(supabase_client=_FakeSupabaseClient()))


# ---------------------------------------------------------------------------
# AC: "Catálogo cobre exatamente os 4 agentes" — exactly the 4 DIA keys, no more.
# ---------------------------------------------------------------------------
def test_catalog_covers_exactly_the_four_dia_agents() -> None:
    assert set(AGENT_CATALOG.keys()) == _EXPECTED_AGENT_KEYS
    assert len(AGENT_CATALOG) == 4
    # The dict key must match the mission's own agent_key (no aliasing drift).
    for key, mission in AGENT_CATALOG.items():
        assert mission.agent_key == key


# ---------------------------------------------------------------------------
# AC: "Catálogo cobre ... cada um marcado como assist_only=true" + structural
#     completeness (every entry carries a "predicts" key and i18n key paths).
# ---------------------------------------------------------------------------
def test_every_entry_is_assist_only_with_a_predicts_key() -> None:
    for key, mission in AGENT_CATALOG.items():
        assert mission.assist_only is True, f"{key} must be assist_only"
        # predicts_key present, non-empty and pointing at the i18n namespace.
        assert mission.predicts_key, f"{key} must declare a predicts_key"
        assert mission.predicts_key == f"labels.agentMissions.{key}.predicts"
        # objective/data keys are likewise i18n key paths (never UI text).
        assert mission.objective_key == f"labels.agentMissions.{key}.objective"
        assert mission.data_key == f"labels.agentMissions.{key}.data"
        # At least one possible action per agent.
        assert len(mission.actions) >= 1, f"{key} must list at least one action"


# ---------------------------------------------------------------------------
# AC: "Vocabulário de ações bate com o código real" for the two enum-bound agents.
# ---------------------------------------------------------------------------
def test_action_vocabulary_matches_real_agent_code() -> None:
    assert AGENT_CATALOG["vehicle-aging-analyst"].actions == _VEHICLE_AGING_ACTIONS
    assert AGENT_CATALOG["service-estimate-rescue"].actions == _SERVICE_RESCUE_ACTIONS


def test_enum_bound_action_vocabulary_tracks_agent_source_constants() -> None:
    # Guard against drift: assert directly against the agents' source tuples so
    # that renaming an action in the agent forces a catalog update.
    from temporal.src.agents.service_estimate_rescue import (
        _RECOMMENDED_ACTIONS as SERVICE_ACTIONS,
    )
    from temporal.src.agents.vehicle_aging_analyst import (
        _RECOMMENDED_ACTIONS as VEHICLE_ACTIONS,
    )

    assert AGENT_CATALOG["vehicle-aging-analyst"].actions == tuple(VEHICLE_ACTIONS)
    assert AGENT_CATALOG["service-estimate-rescue"].actions == tuple(SERVICE_ACTIONS)


# ---------------------------------------------------------------------------
# AC: "Prompt nunca exposto" — the serialized payload must not leak any prompt.
# ---------------------------------------------------------------------------
def test_payload_never_leaks_prompt_fields() -> None:
    payload = agent_catalog_payload()
    assert isinstance(payload, list) and len(payload) == 4

    allowed_keys = {
        "agent_key",
        "objective_key",
        "data_key",
        "predicts_key",
        "actions",
        "assist_only",
    }
    for entry in payload:
        assert set(entry.keys()) == allowed_keys, "payload keys drifted"
        for forbidden in _FORBIDDEN_PROMPT_FIELDS:
            assert forbidden not in entry, f"payload leaked {forbidden}"
        # No value should accidentally smuggle prompt-like content either.
        rendered = repr(entry).lower()
        assert "system_prompt" not in rendered
        assert "user_prompt_template" not in rendered


def test_agent_mission_dataclass_has_no_prompt_field() -> None:
    field_names = {f.name for f in fields(AgentMission)}
    for forbidden in _FORBIDDEN_PROMPT_FIELDS:
        assert forbidden not in field_names


# ---------------------------------------------------------------------------
# AC (integration): the read-only API exposes the catalog and never the prompt.
# ---------------------------------------------------------------------------
def test_catalog_endpoint_returns_four_agents_without_prompt(client: TestClient) -> None:
    res = client.get("/api/ops/agents/catalog")
    assert res.status_code == 200

    body = res.json()
    agents = body["agents"]
    assert {a["agent_key"] for a in agents} == _EXPECTED_AGENT_KEYS
    assert len(agents) == 4

    for entry in agents:
        assert entry["assist_only"] is True
        assert entry["predicts_key"].startswith("labels.agentMissions.")
        for forbidden in _FORBIDDEN_PROMPT_FIELDS:
            assert forbidden not in entry

    # Whole-response guard: no prompt content anywhere in the serialized body.
    raw = res.text.lower()
    assert "system_prompt" not in raw
    assert "user_prompt_template" not in raw

    # Action vocabulary survives the round-trip through the HTTP layer.
    by_key = {a["agent_key"]: a for a in agents}
    assert by_key["vehicle-aging-analyst"]["actions"] == list(_VEHICLE_AGING_ACTIONS)
    assert by_key["service-estimate-rescue"]["actions"] == list(_SERVICE_RESCUE_ACTIONS)
