"""Static mission catalog for the DIA agents (issue #125, design-spec §2 RF-1, U2).

The catalog is versioned in code (no data migration) and holds **only i18n keys
and structural data** — never UI text and never the agent's ``system_prompt`` /
``user_prompt_template``. The ops-api exposes it read-only so the agents panel can
render a mission card per agent (objective, data analyzed, what it predicts,
possible actions and the assist-only badge).

The four DIA agents covered by this unit, with their real action vocabulary:

* ``vehicle-aging-analyst`` — ``monitor, markdown, transfer, prioritize_sale,
  wholesale_auction`` (see ``agents/vehicle_aging_analyst.py``).
* ``service-estimate-rescue`` — ``contact_customer, offer_discount, reprice,
  escalate, monitor`` (see ``agents/service_estimate_rescue.py``).
* ``collections-prioritizer`` — actions are described via i18n labels (the agent
  emits a free-text ``recommended_action`` via the LLM, no fixed enum in code).
* ``parts-inventory-advisor`` — actions are described via i18n labels (same as
  above; no fixed enum in code).

All agents are **assist-only**: the card never executes or triggers any action.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AgentMission:
    """Structural mission metadata for a single DIA agent.

    Holds i18n **keys** (resolved by the frontend) plus structural data; it never
    carries UI text or any prompt.
    """

    agent_key: str
    objective_key: str
    data_key: str
    predicts_key: str
    actions: tuple[str, ...]
    assist_only: bool = True

    def to_payload(self) -> dict[str, Any]:
        return {
            "agent_key": self.agent_key,
            "objective_key": self.objective_key,
            "data_key": self.data_key,
            "predicts_key": self.predicts_key,
            "actions": list(self.actions),
            "assist_only": self.assist_only,
        }


def _mission(agent_key: str, *, actions: tuple[str, ...]) -> AgentMission:
    base = f"labels.agentMissions.{agent_key}"
    return AgentMission(
        agent_key=agent_key,
        objective_key=f"{base}.objective",
        data_key=f"{base}.data",
        predicts_key=f"{base}.predicts",
        actions=actions,
    )


# Exactly the four DIA agents — no more. Action codes resolve to ``labels.actions.*``.
AGENT_CATALOG: dict[str, AgentMission] = {
    "vehicle-aging-analyst": _mission(
        "vehicle-aging-analyst",
        actions=("monitor", "markdown", "transfer", "prioritize_sale", "wholesale_auction"),
    ),
    "collections-prioritizer": _mission(
        "collections-prioritizer",
        actions=("contact_customer", "payment_plan", "escalate", "send_to_collections", "monitor"),
    ),
    "parts-inventory-advisor": _mission(
        "parts-inventory-advisor",
        actions=("replenish", "transfer", "expedite_order", "substitute_part", "monitor"),
    ),
    "service-estimate-rescue": _mission(
        "service-estimate-rescue",
        actions=("contact_customer", "offer_discount", "reprice", "escalate", "monitor"),
    ),
}


def agent_catalog_payload() -> list[dict[str, Any]]:
    """Serialize the catalog for the read-only API (no prompt is ever included)."""

    return [mission.to_payload() for mission in AGENT_CATALOG.values()]


__all__ = ["AgentMission", "AGENT_CATALOG", "agent_catalog_payload"]
