from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from temporalio import activity

logger = logging.getLogger(__name__)

@dataclass
class EntityResult:
    entity_id: str
    version_id: str
    success: bool = True
    error: str | None = None


@activity.defn
def create_entity(entity_type: str, attributes: dict[str, Any], created_by: str | None = None) -> EntityResult:
    logger.info("[STUB] create_entity", extra={"entity_type": entity_type, "created_by": created_by})
    return EntityResult(entity_id="mock-entity-id", version_id="mock-version-id")


@activity.defn
def update_entity_scd2(entity_id: str, attributes: dict[str, Any], updated_by: str | None = None) -> EntityResult:
    logger.info("[STUB] update_entity_scd2", extra={"entity_id": entity_id, "updated_by": updated_by})
    return EntityResult(entity_id=entity_id, version_id="mock-version-id")


@activity.defn
def get_entity(entity_id: str) -> dict[str, Any]:
    logger.info("[STUB] get_entity", extra={"entity_id": entity_id})
    return {"entity_id": entity_id, "name": "Mock Entity"}


@activity.defn
def append_event(entity_id: str, entity_type: str, event_type: str, event_data: dict[str, Any], actor_id: str | None = None, correlation_id: str | None = None) -> bool:
    logger.info(
        "[STUB] append_event",
        extra={"entity_id": entity_id, "event_type": event_type, "actor_id": actor_id, "correlation_id": correlation_id},
    )
    return True


@activity.defn
def create_relationship(from_entity_id: str, to_entity_id: str, relationship_type: str, attributes: dict[str, Any] | None = None) -> dict[str, Any]:
    logger.info(
        "[STUB] create_relationship",
        extra={"from": from_entity_id, "to": to_entity_id, "relationship_type": relationship_type},
    )
    return {"relationship_id": "mock-relationship-id", "success": True}
