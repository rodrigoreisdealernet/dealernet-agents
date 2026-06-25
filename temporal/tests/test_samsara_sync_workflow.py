from __future__ import annotations

import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.activities import samsara as samsara_activities
from temporal.src.workflows.integrations.samsara import (
    SamsaraSyncWorkflow,
    SamsaraSyncWorkflowInput,
)


def _config_snapshot(
    enabled_scopes: list[str] | None = None,
    cursor: str | None = None,
) -> dict:
    return {
        "tenant_id": "tenant-a",
        "scope": "gps",
        "cursor": cursor,
        "enabled_scopes": enabled_scopes if enabled_scopes is not None else ["gps", "hours", "eld", "dashcam_events"],
        "settings": {
            "api_base_url": "https://api.samsara.com",
            "fleet_targeting": {"group_ids": ["group-1"]},
        },
        "mappings": {"gps_mapping_profile": {"asset_id_field": "vehicleId"}},
        "secret_refs": {"api_secret_ref": "secret://integrations/samsara/api_key"},
    }


@pytest.mark.asyncio
async def test_sync_workflow_processes_single_scope_single_page() -> None:
    calls: dict[str, list] = {"load": [], "fetch": [], "persist": [], "advance": []}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            calls["load"].append(args)
            return _config_snapshot()
        if fn_name == "samsara_fetch_scope_page":
            calls["fetch"].append(args)
            return {
                "tenant_id": args[0],
                "scope": args[1],
                "records": [{"vehicleId": "veh-1", "time": "t1"}],
                "next_cursor": None,
                "page_cursor": "provider-end-cursor-123",
                "fetched_at": "2026-06-01T00:00:00Z",
            }
        if fn_name == "samsara_persist_telemetry_batch":
            calls["persist"].append(args)
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "samsara_advance_sync_cursor":
            calls["advance"].append(args)
            return {"cursor": args[2]}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_samsara_workflow")),
    ):
        result = await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"])
        )

    assert result["scopes"]["gps"]["status"] == "ok"
    assert result["scopes"]["gps"]["upserted"] == 1
    assert result["scopes"]["gps"]["pages"] == 1
    assert len(calls["fetch"]) == 1
    assert len(calls["persist"]) == 1
    assert len(calls["advance"]) == 1
    # The advance call must use the provider-derived page_cursor, not fetched_at
    assert calls["advance"][0][2] == "provider-end-cursor-123"


@pytest.mark.asyncio
async def test_sync_workflow_paginates_until_no_next_cursor() -> None:
    page_counter = {"n": 0}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot()
        if fn_name == "samsara_fetch_scope_page":
            page_counter["n"] += 1
            has_more = page_counter["n"] < 3
            return {
                "scope": "gps",
                "records": [{"vehicleId": f"veh-{page_counter['n']}"}],
                "next_cursor": f"cursor-{page_counter['n']}" if has_more else None,
                "fetched_at": "2026-06-01T00:00:00Z",
            }
        if fn_name == "samsara_persist_telemetry_batch":
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "samsara_advance_sync_cursor":
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_samsara_workflow")),
    ):
        result = await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"])
        )

    assert result["scopes"]["gps"]["pages"] == 3
    assert result["scopes"]["gps"]["upserted"] == 3


@pytest.mark.asyncio
async def test_sync_workflow_skips_disabled_scope() -> None:
    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot(enabled_scopes=["gps"])  # eld not enabled
        raise AssertionError(f"Unexpected activity for disabled scope: {fn_name}")

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_samsara_workflow")),
    ):
        result = await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["eld"])
        )

    assert result["scopes"]["eld"]["status"] == "skipped"


@pytest.mark.asyncio
async def test_sync_workflow_raises_on_scope_failure() -> None:
    """Workflow must raise (fail) when any scope fails so Temporal marks it as failed.

    Regression: old code swallowed all scope exceptions into scope_summary["status"]="failed"
    and returned a successful result, hiding outages from schedule/ops monitoring.
    """
    gps_fetched = {"n": 0}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot()
        if fn_name == "samsara_fetch_scope_page":
            scope = args[1]
            if scope == "hours":
                raise RuntimeError("Samsara hours API unavailable")
            gps_fetched["n"] += 1
            return {
                "scope": scope,
                "records": [],
                "next_cursor": None,
                "fetched_at": "2026-06-01T00:00:00Z",
            }
        if fn_name in {"samsara_persist_telemetry_batch", "samsara_advance_sync_cursor"}:
            return {"upserted": 0, "duplicates": 0, "total": 0}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_samsara_workflow")),pytest.raises(Exception) as exc_info
    ):
        await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps", "hours"])
        )

    # Exception must mention the failed scope name
    assert "hours" in str(exc_info.value)
    # GPS scope was still processed (workflow continued before raising)
    assert gps_fetched["n"] == 1


@pytest.mark.asyncio
async def test_backfill_mode_ignores_stored_cursor() -> None:
    """In backfill mode the workflow must pass cursor=None to the first fetch."""
    captured_fetch_args: list[list] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot(cursor="stored-cursor-should-be-ignored")
        if fn_name == "samsara_fetch_scope_page":
            captured_fetch_args.append(args)
            return {"scope": "gps", "records": [], "next_cursor": None, "fetched_at": "t"}
        if fn_name in {"samsara_persist_telemetry_batch", "samsara_advance_sync_cursor"}:
            return {"upserted": 0, "duplicates": 0, "total": 0}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_samsara_workflow")),
    ):
        await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"], mode="backfill")
        )

    # cursor argument (index 2) must be None for backfill
    assert captured_fetch_args[0][2] is None


@pytest.mark.asyncio
async def test_sync_mode_passes_stored_cursor_to_fetch() -> None:
    """In sync mode the stored cursor must be forwarded to the first fetch call."""
    captured_fetch_args: list[list] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot(cursor="my-stored-cursor")
        if fn_name == "samsara_fetch_scope_page":
            captured_fetch_args.append(args)
            return {"scope": "gps", "records": [], "next_cursor": None, "fetched_at": "t"}
        if fn_name in {"samsara_persist_telemetry_batch", "samsara_advance_sync_cursor"}:
            return {"upserted": 0, "duplicates": 0, "total": 0}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_samsara_workflow")),
    ):
        await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"], mode="sync")
        )

    assert captured_fetch_args[0][2] == "my-stored-cursor"


@pytest.mark.asyncio
async def test_sync_workflow_syncs_all_enabled_scopes_when_none_specified() -> None:
    """Empty scopes list triggers sync for all SAMSARA_SCOPES."""
    loaded_scopes: list[str] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            loaded_scopes.append(args[1])
            return _config_snapshot(enabled_scopes=[args[1]])
        if fn_name == "samsara_fetch_scope_page":
            return {"scope": args[1], "records": [], "next_cursor": None, "fetched_at": "t"}
        if fn_name in {"samsara_persist_telemetry_batch", "samsara_advance_sync_cursor"}:
            return {"upserted": 0, "duplicates": 0, "total": 0}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_samsara_workflow")),
    ):
        result = await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=[])
        )

    assert set(result["scopes"].keys()) == {"gps", "hours", "eld", "dashcam_events"}


@pytest.mark.asyncio
async def test_workflow_scope_error_uses_exception_type_prefix() -> None:
    """ApplicationError raised on scope failure must mention the failed scope name.

    Regression: old code stored scope_summary["error"] = str(exc) which omitted the
    exception class name. The workflow now raises ApplicationError naming failed scopes;
    it must not expose sensitive content (secret-ref paths, env-var names) in its message.
    """

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot()
        if fn_name == "samsara_fetch_scope_page":
            raise samsara_activities.SamsaraAuthError("Samsara auth failed: HTTP 401")
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test")),pytest.raises(Exception) as exc_info
    ):
        await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"])
        )

    error_msg = str(exc_info.value)
    # Must name the failed scope so operators can act on it
    assert "gps" in error_msg
    # Must not expose secret-ref paths or env-var names in the workflow-level exception
    assert "secret://" not in error_msg
    assert "SAMSARA_API" not in error_msg


@pytest.mark.asyncio
async def test_workflow_scope_error_does_not_add_extra_sensitive_content() -> None:
    """Workflow ApplicationError must not add sensitive activity-internal content.

    Regression guard: verifies the workflow doesn't append raw exception context
    (e.g. config snapshots, secret_refs, internal state) to the raised exception.
    The raised message names the failed scope only; per-scope detail stays internal.
    """

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot()
        if fn_name == "samsara_fetch_scope_page":
            raise RuntimeError("Samsara connectivity error: HTTP 503")
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test")),pytest.raises(Exception) as exc_info
    ):
        await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"])
        )

    error_msg = str(exc_info.value)
    # Workflow-level message names the failed scope
    assert "gps" in error_msg
    # Must not re-expose the raw activity exception message in the workflow-level error
    # (per-scope error strings are stored internally but not propagated to Temporal history)
    assert "HTTP 503" not in error_msg
    assert "secret://" not in error_msg


@pytest.mark.asyncio
async def test_terminal_page_uses_provider_end_cursor_not_local_timestamp() -> None:
    """Terminal page must persist provider endCursor, not a worker-local timestamp.

    Regression: old code did `advance_cursor = next_cursor or fetched_at` so the
    last/only page stored a worker-local wall-clock time as the resume cursor.
    That is not a Samsara-issued token and causes the next incremental run to send
    an invalid `after` parameter, potentially skipping late-arriving records.
    """
    advance_args: list[list] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot()
        if fn_name == "samsara_fetch_scope_page":
            # Simulate a terminal page: hasNextPage=False but Samsara still returns endCursor
            return {
                "scope": "gps",
                "records": [{"vehicleId": "veh-1", "time": "2026-06-01T00:00:00Z"}],
                "next_cursor": None,
                "page_cursor": "samsara-provider-end-cursor-abc",
                "fetched_at": "2026-06-01T00:05:00Z",
            }
        if fn_name == "samsara_persist_telemetry_batch":
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "samsara_advance_sync_cursor":
            advance_args.append(list(args))
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        await wf.run(SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"]))

    assert len(advance_args) == 1, "cursor must be advanced exactly once for the single page"
    stored_cursor = advance_args[0][2]
    # Must be the provider-issued token, not any local timestamp
    assert stored_cursor == "samsara-provider-end-cursor-abc", (
        f"Expected provider endCursor but got: {stored_cursor!r}"
    )
    assert stored_cursor != "2026-06-01T00:05:00Z", "must not store fetched_at as resume cursor"


@pytest.mark.asyncio
async def test_terminal_page_with_no_provider_cursor_does_not_advance_state() -> None:
    """When the terminal page has no endCursor, the sync state must not be advanced.

    Regression: old code stored fetched_at (a worker-local timestamp) as the cursor
    value even when Samsara returned no endCursor, producing an invalid resume token.
    """
    advance_calls: list = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot()
        if fn_name == "samsara_fetch_scope_page":
            # Terminal page with no endCursor from the provider
            return {
                "scope": "gps",
                "records": [{"vehicleId": "veh-1", "time": "2026-06-01T00:00:00Z"}],
                "next_cursor": None,
                "page_cursor": None,
                "fetched_at": "2026-06-01T00:05:00Z",
            }
        if fn_name == "samsara_persist_telemetry_batch":
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "samsara_advance_sync_cursor":
            advance_calls.append(args)
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        await wf.run(SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"]))

    assert advance_calls == [], (
        "samsara_advance_sync_cursor must not be called when the provider returns no endCursor"
    )


@pytest.mark.asyncio
async def test_backfill_preserves_incremental_cursor() -> None:
    """Backfill must never call samsara_advance_sync_cursor.

    Regression: backfill starts from cursor=None and iterates historical data.
    Writing the provider/page cursor back into integration_sync_state during a
    backfill would overwrite the live incremental resume point, causing the next
    scheduled incremental sync to re-fetch from the backfill's terminal position
    rather than from where the live sync last left off.
    """
    advance_calls: list = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return _config_snapshot(cursor="live-incremental-cursor")
        if fn_name == "samsara_fetch_scope_page":
            return {
                "scope": "gps",
                "records": [{"vehicleId": "v1"}],
                "next_cursor": None,
                "page_cursor": "backfill-provider-cursor-xyz",
                "fetched_at": "2026-06-01T00:00:00Z",
            }
        if fn_name == "samsara_persist_telemetry_batch":
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "samsara_advance_sync_cursor":
            advance_calls.append(args)
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        await wf.run(
            SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"], mode="backfill")
        )

    assert advance_calls == [], (
        "samsara_advance_sync_cursor must not be called during backfill; "
        f"got {len(advance_calls)} call(s) with args {advance_calls}"
    )


@pytest.mark.asyncio
async def test_workflow_forwards_mappings_to_persist_activity() -> None:
    """Workflow must forward config_snapshot['mappings'] to samsara_persist_telemetry_batch.

    Regression guard: if the workflow does not pass mappings, the mapping profile
    is silently ignored and _apply_samsara_mapping receives an empty dict,
    causing the Wynne-side response_payload to ignore the configured field aliases.
    This test fails if the 5th argument to samsara_persist_telemetry_batch is
    missing or does not contain the profile from config_snapshot.
    """
    persist_args: list[list] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "samsara_load_sync_config":
            return {
                "tenant_id": "tenant-a",
                "scope": "gps",
                "cursor": None,
                "enabled_scopes": ["gps"],
                "settings": {"api_base_url": "https://api.samsara.com", "fleet_targeting": {}},
                "mappings": {"gps_mapping_profile": {"asset_id_field": "assetSerialNumber"}},
                "secret_refs": {},
            }
        if fn_name == "samsara_fetch_scope_page":
            return {
                "scope": "gps",
                "records": [{"vehicleId": "veh-1", "assetSerialNumber": "SN-1", "latitude": 37.7, "longitude": -122.4, "time": "t1"}],
                "next_cursor": None,
                "page_cursor": "cursor-abc",
                "fetched_at": "2026-06-01T00:00:00Z",
            }
        if fn_name == "samsara_persist_telemetry_batch":
            persist_args.append(list(args))
            return {"upserted": 1, "duplicates": 0, "total": 1}
        if fn_name == "samsara_advance_sync_cursor":
            return {"cursor": args[2]}
        raise AssertionError(fn_name)

    wf = SamsaraSyncWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        await wf.run(SamsaraSyncWorkflowInput(tenant_id="tenant-a", scopes=["gps"]))

    assert len(persist_args) == 1, "samsara_persist_telemetry_batch must be called once"
    # 5th arg (index 4) is the mappings dict
    assert len(persist_args[0]) >= 5, (
        f"samsara_persist_telemetry_batch must receive 5 args (including mappings), got {len(persist_args[0])}"
    )
    mappings_arg = persist_args[0][4]
    assert isinstance(mappings_arg, dict), "5th arg must be a dict"
    assert "gps_mapping_profile" in mappings_arg, (
        "mappings_arg must contain the gps_mapping_profile from config_snapshot. "
        "Workflow is not forwarding mappings to the persist activity."
    )
    assert mappings_arg["gps_mapping_profile"].get("asset_id_field") == "assetSerialNumber"
