from __future__ import annotations

import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.workflows.integrations.descartes import (
    DescartesSyncWorkflow,
    DescartesSyncWorkflowInput,
)
from temporalio.exceptions import ApplicationError


def _config_snapshot(
    enabled_scopes: list[str] | None = None,
    cursor: str | None = None,
) -> dict[str, object]:
    return {
        "tenant_id": "tenant-a",
        "scope": "route",
        "cursor": cursor,
        "enabled_scopes": enabled_scopes if enabled_scopes is not None else ["route", "shipment", "compliance"],
        "settings": {"endpoint_base_url": "https://api.descartes.example"},
        "mappings": {"route_mapping_profile": {"route_id_field": "routeNumber"}},
        "secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"},
    }


@pytest.mark.asyncio
async def test_sync_workflow_processes_scope_and_advances_cursor() -> None:
    calls: dict[str, list[list[object]]] = {"fetch": [], "advance": []}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "descartes_load_sync_config":
            return _config_snapshot()
        if fn_name == "descartes_fetch_scope_page":
            calls["fetch"].append(args)
            return {
                "scope": args[1],
                "records": [{"routeNumber": "route-1", "status": "dispatched"}],
                "next_cursor": None,
                "page_cursor": "provider-end-cursor",
                "fetched_at": "2026-06-12T00:00:00Z",
            }
        if fn_name == "descartes_persist_scope_batch":
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "descartes_advance_sync_cursor":
            calls["advance"].append(args)
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = DescartesSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_descartes_workflow")),
    ):
        result = await wf.run(DescartesSyncWorkflowInput(tenant_id="tenant-a", scopes=["route"], mode="sync"))

    assert result["scopes"]["route"]["status"] == "ok"
    assert len(calls["fetch"]) == 1
    assert len(calls["advance"]) == 1
    assert calls["advance"][0][2] == "provider-end-cursor"


@pytest.mark.asyncio
async def test_backfill_mode_does_not_advance_cursor() -> None:
    advance_calls = {"count": 0}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        if fn_name == "descartes_load_sync_config":
            return _config_snapshot(cursor="stored-cursor")
        if fn_name == "descartes_fetch_scope_page":
            return {"scope": "route", "records": [], "next_cursor": None, "fetched_at": "t"}
        if fn_name == "descartes_persist_scope_batch":
            return {"upserted": 0, "duplicates": 0, "total": 0}
        if fn_name == "descartes_advance_sync_cursor":
            advance_calls["count"] += 1
            return {"cursor": "x"}
        raise AssertionError(fn_name)

    wf = DescartesSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_descartes_workflow")),
    ):
        await wf.run(DescartesSyncWorkflowInput(tenant_id="tenant-a", scopes=["route"], mode="backfill"))

    assert advance_calls["count"] == 0


@pytest.mark.asyncio
async def test_sync_workflow_raises_when_any_scope_fails() -> None:
    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "descartes_load_sync_config":
            return _config_snapshot()
        if fn_name == "descartes_fetch_scope_page":
            if args[1] == "shipment":
                raise RuntimeError("Shipment API unavailable")
            return {"scope": args[1], "records": [], "next_cursor": None, "fetched_at": "t"}
        if fn_name in {"descartes_persist_scope_batch", "descartes_advance_sync_cursor"}:
            return {"upserted": 0, "duplicates": 0, "total": 0}
        raise AssertionError(fn_name)

    wf = DescartesSyncWorkflow()
    with patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity), patch.object(
        tw_mod, "logger", logging.getLogger("test_descartes_workflow")
    ), pytest.raises(ApplicationError) as exc_info:
        await wf.run(
            DescartesSyncWorkflowInput(
                tenant_id="tenant-a",
                scopes=["route", "shipment"],
                mode="sync",
            )
        )
    assert "shipment" in str(exc_info.value)


@pytest.mark.asyncio
async def test_sync_workflow_fetches_multiple_pages_with_root_level_next_cursor() -> None:
    """Verify workflow continues pagination when next_cursor is at response root level."""
    fetch_calls: list[str | None] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "descartes_load_sync_config":
            return _config_snapshot(cursor=None)
        if fn_name == "descartes_fetch_scope_page":
            cursor = args[2]
            fetch_calls.append(cursor)
            # Simulate multi-page response with root-level next_cursor (no pagination object)
            if cursor is None:
                # First page: return next_cursor indicating more pages
                return {
                    "scope": "route",
                    "records": [{"routeNumber": "route-1"}],
                    "next_cursor": "cursor-page-2",
                    "page_cursor": "cursor-page-2",
                    "fetched_at": "t1",
                }
            elif cursor == "cursor-page-2":
                # Second page: return next_cursor indicating more pages
                return {
                    "scope": "route",
                    "records": [{"routeNumber": "route-2"}],
                    "next_cursor": "cursor-page-3",
                    "page_cursor": "cursor-page-3",
                    "fetched_at": "t2",
                }
            else:
                # Third page: terminal (no next_cursor)
                return {
                    "scope": "route",
                    "records": [{"routeNumber": "route-3"}],
                    "next_cursor": None,
                    "page_cursor": "cursor-final",
                    "fetched_at": "t3",
                }
        if fn_name == "descartes_persist_scope_batch":
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "descartes_advance_sync_cursor":
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = DescartesSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_descartes_workflow")),
    ):
        result = await wf.run(DescartesSyncWorkflowInput(tenant_id="tenant-a", scopes=["route"], mode="sync"))

    assert result["scopes"]["route"]["status"] == "ok"
    assert result["scopes"]["route"]["pages"] == 3, "Should fetch all 3 pages"
    assert len(fetch_calls) == 3, "Should call fetch 3 times"
    assert fetch_calls == [None, "cursor-page-2", "cursor-page-3"]
