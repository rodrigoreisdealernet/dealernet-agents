from __future__ import annotations

import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.workflows.integrations.coupa import (
    CoupaSyncWorkflow,
    CoupaSyncWorkflowInput,
)


def _config_snapshot(
    enabled_scopes: list[str] | None = None,
    cursor: str | None = None,
) -> dict:
    return {
        "tenant_id": "tenant-a",
        "scope": "requisitions",
        "cursor": cursor,
        "enabled_scopes": enabled_scopes if enabled_scopes is not None else [
            "requisitions", "purchase_orders", "suppliers", "invoices"
        ],
        "settings": {
            "api_base_url": "https://tenant.coupahost.com",
            "tenant_slug": "dia-rental",
        },
        "mappings": {
            "requisition_mapping_profile": {"requisition_id_field": "id"},
            "purchase_order_mapping_profile": {"purchase_order_id_field": "id"},
            "supplier_mapping_profile": {"supplier_id_field": "id"},
            "invoice_mapping_profile": {"invoice_id_field": "id"},
        },
        "secret_refs": {
            "client_id_secret_ref": "secret://integrations/coupa/client_id",
            "client_secret_secret_ref": "secret://integrations/coupa/client_secret",
        },
    }


@pytest.mark.asyncio
async def test_sync_workflow_processes_single_scope_single_page() -> None:
    calls: dict[str, list] = {"load": [], "fetch": [], "persist": [], "advance": []}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "coupa_load_sync_config":
            calls["load"].append(args)
            return _config_snapshot()
        if fn_name == "coupa_fetch_scope_page":
            calls["fetch"].append(args)
            return {
                "tenant_id": args[0],
                "scope": args[1],
                "records": [{"id": 1, "status": "pending_approval", "updated-at": "2026-06-01T00:00:00Z"}],
                "next_cursor": None,
                "page_cursor": "2026-06-01T00:00:00Z",
                "fetched_at": "2026-06-01T00:00:00Z",
            }
        if fn_name == "coupa_persist_procurement_batch":
            calls["persist"].append(args)
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "coupa_advance_sync_cursor":
            calls["advance"].append(args)
            return {"cursor": args[2]}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    wf = CoupaSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_coupa_workflow")),
    ):
        result = await wf.run(
            CoupaSyncWorkflowInput(tenant_id="tenant-a", scopes=["requisitions"])
        )

    assert result["scopes"]["requisitions"]["status"] == "ok"
    assert result["scopes"]["requisitions"]["upserted"] == 1
    assert result["scopes"]["requisitions"]["pages"] == 1
    assert len(calls["fetch"]) == 1
    assert len(calls["persist"]) == 1
    # cursor advances using page_cursor when next_cursor is None
    assert len(calls["advance"]) == 1
    assert calls["advance"][0][2] == "2026-06-01T00:00:00Z"


@pytest.mark.asyncio
async def test_sync_workflow_paginates_until_no_next_cursor() -> None:
    page_counter = {"n": 0}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "coupa_load_sync_config":
            return _config_snapshot()
        if fn_name == "coupa_fetch_scope_page":
            page_counter["n"] += 1
            has_more = page_counter["n"] < 3
            ts = f"2026-06-0{page_counter['n']}T00:00:00Z"
            return {
                "scope": "requisitions",
                "records": [{"id": page_counter["n"], "updated-at": ts}],
                "next_cursor": ts if has_more else None,
                "page_cursor": ts,
                "fetched_at": ts,
            }
        if fn_name == "coupa_persist_procurement_batch":
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "coupa_advance_sync_cursor":
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = CoupaSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_coupa_workflow")),
    ):
        result = await wf.run(
            CoupaSyncWorkflowInput(tenant_id="tenant-a", scopes=["requisitions"])
        )

    assert result["scopes"]["requisitions"]["pages"] == 3
    assert result["scopes"]["requisitions"]["upserted"] == 3


@pytest.mark.asyncio
async def test_sync_workflow_skips_disabled_scope() -> None:
    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        if fn_name == "coupa_load_sync_config":
            return _config_snapshot(enabled_scopes=["purchase_orders"])
        raise AssertionError(f"Unexpected activity: {fn_name}")

    wf = CoupaSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_coupa_workflow")),
    ):
        result = await wf.run(
            CoupaSyncWorkflowInput(tenant_id="tenant-a", scopes=["requisitions"])
        )

    assert result["scopes"]["requisitions"]["status"] == "skipped"


@pytest.mark.asyncio
async def test_sync_workflow_processes_all_enabled_scopes_when_none_specified() -> None:
    scopes_processed: list[str] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "coupa_load_sync_config":
            scopes_processed.append(args[1])
            return _config_snapshot()
        if fn_name == "coupa_fetch_scope_page":
            return {"scope": args[1], "records": [], "next_cursor": None, "page_cursor": None, "fetched_at": "t"}
        if fn_name == "coupa_persist_procurement_batch":
            return {"upserted": 0, "duplicates": 0, "total": 0}
        if fn_name == "coupa_advance_sync_cursor":
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = CoupaSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_coupa_workflow")),
    ):
        result = await wf.run(
            CoupaSyncWorkflowInput(tenant_id="tenant-a", scopes=[])
        )

    assert set(scopes_processed) == {"requisitions", "purchase_orders", "suppliers", "invoices"}
    assert all(v["status"] == "ok" for v in result["scopes"].values())


@pytest.mark.asyncio
async def test_sync_workflow_backfill_does_not_advance_cursor() -> None:
    advance_calls: list = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "coupa_load_sync_config":
            return _config_snapshot(cursor="2026-05-01T00:00:00Z")
        if fn_name == "coupa_fetch_scope_page":
            # backfill passes cursor=None
            assert args[2] is None, "backfill must ignore stored cursor"
            return {
                "scope": "requisitions",
                "records": [{"id": 1, "updated-at": "2026-06-01T00:00:00Z"}],
                "next_cursor": None,
                "page_cursor": "2026-06-01T00:00:00Z",
                "fetched_at": "2026-06-01T00:00:00Z",
            }
        if fn_name == "coupa_persist_procurement_batch":
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "coupa_advance_sync_cursor":
            advance_calls.append(args)
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = CoupaSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_coupa_workflow")),
    ):
        result = await wf.run(
            CoupaSyncWorkflowInput(tenant_id="tenant-a", scopes=["requisitions"], mode="backfill")
        )

    assert result["scopes"]["requisitions"]["status"] == "ok"
    # cursor must NOT be advanced during backfill
    assert advance_calls == []


@pytest.mark.asyncio
async def test_sync_workflow_records_scope_failure_and_raises() -> None:
    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        if fn_name == "coupa_load_sync_config":
            raise RuntimeError("Supabase unreachable")
        raise AssertionError(fn_name)

    wf = CoupaSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_coupa_workflow")),
    ):
        from temporalio.exceptions import ApplicationError
        with pytest.raises(ApplicationError, match="scope failure"):
            await wf.run(
                CoupaSyncWorkflowInput(tenant_id="tenant-a", scopes=["requisitions"])
            )


@pytest.mark.asyncio
async def test_sync_workflow_counts_duplicates() -> None:
    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        if fn_name == "coupa_load_sync_config":
            return _config_snapshot()
        if fn_name == "coupa_fetch_scope_page":
            return {
                "scope": "suppliers",
                "records": [{"id": 1}, {"id": 2}],
                "next_cursor": None,
                "page_cursor": None,
                "fetched_at": "2026-06-01T00:00:00Z",
            }
        if fn_name == "coupa_persist_procurement_batch":
            return {"upserted": 1, "duplicates": 1, "total": 2}
        if fn_name == "coupa_advance_sync_cursor":
            return {"cursor": ""}
        raise AssertionError(fn_name)

    wf = CoupaSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_coupa_workflow")),
    ):
        result = await wf.run(
            CoupaSyncWorkflowInput(tenant_id="tenant-a", scopes=["suppliers"])
        )

    assert result["scopes"]["suppliers"]["upserted"] == 1
    assert result["scopes"]["suppliers"]["duplicates"] == 1
