from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from temporal.src import worker
from temporalio import service
from temporalio.client import ScheduleUpdate


def _not_found_error() -> service.RPCError:
    return service.RPCError("not found", service.RPCStatusCode.NOT_FOUND, b"")


@pytest.mark.asyncio
async def test_reconcile_creates_schedule_when_enabled_by_default_and_uses_config_cron() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_revrec_schedules(
        client,
        [
            {
                "tenant_id": "tenant-a",
                "schedule": {"cron": "15 3 * * *"},
            }
        ],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-a:revrec-analyst"
    assert create_args[1].spec.cron_expressions == ["15 3 * * *"]


@pytest.mark.asyncio
async def test_reconcile_deletes_schedule_when_disabled() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_revrec_schedules(
        client,
        [
            {
                "tenant_id": "tenant-a",
                "schedule": {"enabled": False, "cron": "0 2 * * *"},
            }
        ],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_reconcile_updates_existing_schedule_with_new_cron() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.describe = AsyncMock(return_value=SimpleNamespace())
    schedule_handle.update = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_revrec_schedules(
        client,
        [
            {
                "tenant_id": "tenant-a",
                "schedule": {"enabled": True, "cron": "0 4 * * *"},
            }
        ],
    )

    schedule_handle.update.assert_awaited_once()
    update_callback = schedule_handle.update.await_args.args[0]
    update_result = update_callback(SimpleNamespace(description=SimpleNamespace(schedule=SimpleNamespace())))
    assert isinstance(update_result, ScheduleUpdate)
    assert update_result.schedule.spec.cron_expressions == ["0 4 * * *"]


@pytest.mark.asyncio
async def test_reconcile_recreates_schedule_when_re_enabled() -> None:
    disabled_handle = AsyncMock()
    disabled_handle.delete = AsyncMock()

    enabled_handle = AsyncMock()
    enabled_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.side_effect = [disabled_handle, enabled_handle]
    client.create_schedule = AsyncMock()

    await worker.reconcile_revrec_schedules(
        client,
        [
            {
                "tenant_id": "tenant-a",
                "schedule": {"enabled": False, "cron": "0 2 * * *"},
            }
        ],
    )
    await worker.reconcile_revrec_schedules(
        client,
        [
            {
                "tenant_id": "tenant-a",
                "schedule": {"enabled": True, "cron": "0 6 * * *"},
            }
        ],
    )

    disabled_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-a:revrec-analyst"
    assert create_args[1].spec.cron_expressions == ["0 6 * * *"]


@pytest.mark.asyncio
async def test_reconcile_is_idempotent_for_repeated_enabled_config() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = [_not_found_error(), SimpleNamespace()]
    schedule_handle.update = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    config_rows = [
        {
            "tenant_id": "tenant-a",
            "schedule": {"enabled": True, "cron": "0 4 * * *"},
        }
    ]

    await worker.reconcile_revrec_schedules(client, config_rows)
    await worker.reconcile_revrec_schedules(client, config_rows)

    assert client.create_schedule.await_count == 1
    schedule_handle.update.assert_awaited_once()
    update_callback = schedule_handle.update.await_args.args[0]
    update_result = update_callback(SimpleNamespace(description=SimpleNamespace(schedule=SimpleNamespace())))
    assert isinstance(update_result, ScheduleUpdate)
    assert update_result.schedule.spec.cron_expressions == ["0 4 * * *"]


def test_fetch_revrec_config_rows_returns_empty_on_404(monkeypatch: pytest.MonkeyPatch) -> None:
    # ops_agent_config not provisioned yet (pre-bootstrap) must NOT crash the worker.
    from urllib import error as urlerror

    def _raise_404(*_args, **_kwargs):
        raise urlerror.HTTPError("http://x", 404, "Not Found", hdrs=None, fp=None)

    monkeypatch.setattr(worker.settings, "supabase_url", "http://supabase.local", raising=False)
    monkeypatch.setattr(worker.settings, "supabase_service_role_key", "k", raising=False)
    monkeypatch.setattr(worker.request, "urlopen", _raise_404)
    assert worker._fetch_revrec_schedule_rows() == []


@pytest.mark.asyncio
async def test_reconcile_is_best_effort_when_config_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    from urllib import error as urlerror

    def _raise_500(*_args, **_kwargs):
        raise urlerror.HTTPError("http://x", 500, "boom", hdrs=None, fp=None)

    monkeypatch.setattr(worker.settings, "supabase_url", "http://supabase.local", raising=False)
    monkeypatch.setattr(worker.settings, "supabase_service_role_key", "k", raising=False)
    monkeypatch.setattr(worker.request, "urlopen", _raise_500)
    # _fetch raises on non-404, but main() wraps reconcile; assert the fetch path raises
    # only the controlled RuntimeError (so the main() guard can catch and continue).
    with pytest.raises(RuntimeError):
        worker._fetch_revrec_schedule_rows()


# ---------------------------------------------------------------------------
# PM evaluator schedule reconciliation tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pm_schedule_creates_when_enabled() -> None:
    """reconcile_pm_schedules must create a schedule when no existing schedule is found."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_pm_schedules(
        client,
        [{"tenant_id": "tenant-x", "schedule": {"cron": "0 */6 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-x:pm-evaluator"
    assert create_args[1].spec.cron_expressions == ["0 */6 * * *"]


@pytest.mark.asyncio
async def test_pm_schedule_deletes_when_disabled() -> None:
    """reconcile_pm_schedules must delete the schedule when the config disables it."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_pm_schedules(
        client,
        [{"tenant_id": "tenant-x", "schedule": {"enabled": False, "cron": "0 */6 * * *"}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_pm_schedule_updates_existing() -> None:
    """reconcile_pm_schedules must update an existing schedule with new cron."""
    schedule_handle = AsyncMock()
    schedule_handle.describe = AsyncMock(return_value=SimpleNamespace())
    schedule_handle.update = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_pm_schedules(
        client,
        [{"tenant_id": "tenant-x", "schedule": {"enabled": True, "cron": "0 8 * * *"}}],
    )

    schedule_handle.update.assert_awaited_once()
    update_callback = schedule_handle.update.await_args.args[0]
    update_result = update_callback(SimpleNamespace(description=SimpleNamespace(schedule=SimpleNamespace())))
    assert isinstance(update_result, ScheduleUpdate)
    assert update_result.schedule.spec.cron_expressions == ["0 8 * * *"]


@pytest.mark.asyncio
async def test_pm_schedule_creates_with_default_cron_when_none_given() -> None:
    """When config omits cron, the PM default cron must be used."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_pm_schedules(
        client,
        [{"tenant_id": "tenant-y"}],
    )

    assert client.create_schedule.await_count == 1
    created_schedule = client.create_schedule.await_args.args[1]
    # Must use the module-level default, not an empty string
    assert created_schedule.spec.cron_expressions == [worker._PM_DEFAULT_CRON]


@pytest.mark.asyncio
async def test_pm_schedule_not_created_when_reconcile_pm_not_called() -> None:
    """Behavioral: if reconcile_pm_schedules is never called, no PM schedule is created.

    This test would fail against any implementation that wires PM schedule creation
    inside the revrec reconcile path instead of the dedicated PM path.
    """
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    # Only calling revrec reconcile — PM schedules must not be created
    await worker.reconcile_revrec_schedules(
        client,
        [{"tenant_id": "tenant-z", "schedule": {"cron": "0 2 * * *"}}],
    )

    # The revrec schedule is created, but no pm-evaluator schedule should be
    for call_args in client.create_schedule.await_args_list:
        schedule_id = call_args.args[0]
        assert "pm-evaluator" not in schedule_id, (
            f"PM schedule must not be created by reconcile_revrec_schedules; got '{schedule_id}'"
        )


def test_fetch_pm_schedule_rows_returns_empty_on_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """PM config fetch must return [] on 404, consistent with revrec resilience."""
    from urllib import error as urlerror

    def _raise_404(*_args, **_kwargs):
        raise urlerror.HTTPError("http://x", 404, "Not Found", hdrs=None, fp=None)

    monkeypatch.setattr(worker.settings, "supabase_url", "http://supabase.local", raising=False)
    monkeypatch.setattr(worker.settings, "supabase_service_role_key", "k", raising=False)
    monkeypatch.setattr(worker.request, "urlopen", _raise_404)
    assert worker._fetch_pm_schedule_rows() == []


# ---------------------------------------------------------------------------
# Samsara integration schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_samsara_schedule_creates_when_enabled() -> None:
    """reconcile_samsara_schedules must create a schedule when none exists."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_samsara_schedules(
        client,
        [{"tenant_id": "tenant-s", "enabled": True, "schedule": {"cron": "0 */4 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "integration:tenant-s:samsara"
    assert create_args[1].spec.cron_expressions == ["0 */4 * * *"]


@pytest.mark.asyncio
async def test_samsara_schedule_workflow_input_has_correct_tenant_id() -> None:
    """The created schedule must use SamsaraSyncWorkflowInput with the right tenant_id."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_samsara_schedules(
        client,
        [{"tenant_id": "tenant-s", "enabled": True, "schedule": {"cron": "0 */6 * * *"}}],
    )

    created_schedule = client.create_schedule.await_args.args[1]
    workflow_input = created_schedule.action.args[0]
    assert workflow_input.tenant_id == "tenant-s"


@pytest.mark.asyncio
async def test_samsara_schedule_deletes_when_integration_disabled() -> None:
    """reconcile_samsara_schedules must delete the schedule when the integration is disabled."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_samsara_schedules(
        client,
        [{"tenant_id": "tenant-s", "enabled": False, "schedule": {"cron": "0 */6 * * *"}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_samsara_schedule_deletes_when_schedule_disabled() -> None:
    """reconcile_samsara_schedules must delete the schedule when schedule.enabled=False."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_samsara_schedules(
        client,
        [{"tenant_id": "tenant-s", "enabled": True, "schedule": {"enabled": False, "cron": "0 */6 * * *"}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_samsara_schedule_updates_existing() -> None:
    """reconcile_samsara_schedules must update an existing schedule with new cron."""
    schedule_handle = AsyncMock()
    schedule_handle.describe = AsyncMock(return_value=SimpleNamespace())
    schedule_handle.update = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_samsara_schedules(
        client,
        [{"tenant_id": "tenant-s", "enabled": True, "schedule": {"cron": "0 8 * * *"}}],
    )

    schedule_handle.update.assert_awaited_once()
    update_callback = schedule_handle.update.await_args.args[0]
    update_result = update_callback(SimpleNamespace(description=SimpleNamespace(schedule=SimpleNamespace())))
    assert isinstance(update_result, ScheduleUpdate)
    assert update_result.schedule.spec.cron_expressions == ["0 8 * * *"]


@pytest.mark.asyncio
async def test_samsara_schedule_creates_with_default_cron_when_none_given() -> None:
    """When config omits cron, the Samsara default cron must be used."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_samsara_schedules(
        client,
        [{"tenant_id": "tenant-s", "enabled": True}],
    )

    assert client.create_schedule.await_count == 1
    created_schedule = client.create_schedule.await_args.args[1]
    assert created_schedule.spec.cron_expressions == [worker._SAMSARA_DEFAULT_CRON]


@pytest.mark.asyncio
async def test_samsara_schedule_not_created_by_revrec_or_pm_reconcile() -> None:
    """Behavioral regression: Samsara schedule must not be created by revrec or PM reconcile paths."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_revrec_schedules(
        client,
        [{"tenant_id": "tenant-s", "schedule": {"cron": "0 2 * * *"}}],
    )
    await worker.reconcile_pm_schedules(
        client,
        [{"tenant_id": "tenant-s", "schedule": {"cron": "0 */6 * * *"}}],
    )

    for call_args in client.create_schedule.await_args_list:
        schedule_id = call_args.args[0]
        assert "samsara" not in schedule_id, (
            f"Samsara schedule must not be created by revrec/PM reconcile; got '{schedule_id}'"
        )


@pytest.mark.asyncio
async def test_revrec_and_pm_schedules_not_created_by_samsara_reconcile() -> None:
    """Behavioral regression: revrec and PM schedules must not be created by Samsara reconcile path."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_samsara_schedules(
        client,
        [{"tenant_id": "tenant-s", "enabled": True, "schedule": {"cron": "0 */6 * * *"}}],
    )

    for call_args in client.create_schedule.await_args_list:
        schedule_id = call_args.args[0]
        assert "revrec" not in schedule_id, (
            f"revrec schedule must not be created by reconcile_samsara_schedules; got '{schedule_id}'"
        )
        assert "pm-evaluator" not in schedule_id, (
            f"PM schedule must not be created by reconcile_samsara_schedules; got '{schedule_id}'"
        )


def test_fetch_samsara_config_rows_returns_empty_on_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """Samsara config fetch must return [] on 404, consistent with revrec/PM resilience."""
    from urllib import error as urlerror

    def _raise_404(*_args, **_kwargs):
        raise urlerror.HTTPError("http://x", 404, "Not Found", hdrs=None, fp=None)

    monkeypatch.setattr(worker.settings, "supabase_url", "http://supabase.local", raising=False)
    monkeypatch.setattr(worker.settings, "supabase_service_role_key", "k", raising=False)
    monkeypatch.setattr(worker.request, "urlopen", _raise_404)
    assert worker._fetch_samsara_config_rows() == []


@pytest.mark.asyncio
async def test_samsara_schedule_uses_same_workflow_id_as_manual_incremental_sync() -> None:
    """The scheduled workflow instance ID must match the manual incremental sync ID.

    Regression: old code used 'samsara-scheduled-sync-{tenant_id}' for scheduled runs
    and 'samsara-sync-{tenant_id}-{timestamp}' for manual runs, so scheduled and manual
    incremental syncs ran with different IDs, allowing them to overlap and race on the
    per-scope cursor row in integration_sync_state (last-writer-wins).  Both paths must
    now share the stable ID 'samsara-sync-{tenant_id}' so ALREADY_EXISTS deduplication
    applies across both entry points.
    """
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_samsara_schedules(
        client,
        [{"tenant_id": "tenant-s", "enabled": True, "schedule": {"cron": "0 */6 * * *"}}],
    )

    created_schedule = client.create_schedule.await_args.args[1]
    workflow_instance_id = created_schedule.action.id
    expected_id = "samsara-sync-tenant-s"
    assert workflow_instance_id == expected_id, (
        f"Scheduled workflow instance ID must be '{expected_id}' to share deduplication "
        f"namespace with manual incremental syncs; got '{workflow_instance_id}'"
    )


# ---------------------------------------------------------------------------
# Descartes integration schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_descartes_schedule_creates_when_enabled() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_descartes_schedules(
        client,
        [{"tenant_id": "tenant-d", "enabled": True, "schedule": {"cron": "0 */3 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "integration:tenant-d:descartes"
    assert create_args[1].spec.cron_expressions == ["0 */3 * * *"]
    assert create_args[1].action.id == "descartes-sync-tenant-d"


@pytest.mark.asyncio
async def test_descartes_schedule_deletes_when_disabled() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_descartes_schedules(
        client,
        [{"tenant_id": "tenant-d", "enabled": False, "schedule": {"cron": "0 */3 * * *"}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_descartes_schedule_deletes_when_disabled_overrides_schedule_enabled() -> None:
    """Connector-level enabled=False must override schedule.enabled=True."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_descartes_schedules(
        client,
        [{"tenant_id": "tenant-d", "enabled": False, "schedule": {"enabled": True, "cron": "0 */3 * * *"}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


# ---------------------------------------------------------------------------
# Coupa integration schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_coupa_schedule_creates_when_enabled() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_coupa_schedules(
        client,
        [{"tenant_id": "tenant-c", "enabled": True, "schedule": {"cron": "0 */6 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "integration:tenant-c:coupa"
    assert create_args[1].spec.cron_expressions == ["0 */6 * * *"]
    assert create_args[1].action.id == "coupa-sync-tenant-c"


@pytest.mark.asyncio
async def test_coupa_schedule_deletes_when_disabled() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_coupa_schedules(
        client,
        [{"tenant_id": "tenant-c", "enabled": False, "schedule": {"cron": "0 */6 * * *"}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_coupa_schedule_updates_existing() -> None:
    schedule_handle = AsyncMock()
    schedule_handle.describe = AsyncMock(return_value=SimpleNamespace())
    schedule_handle.update = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_coupa_schedules(
        client,
        [{"tenant_id": "tenant-c", "enabled": True, "schedule": {"cron": "0 8 * * *"}}],
    )

    schedule_handle.update.assert_awaited_once()
    update_callback = schedule_handle.update.await_args.args[0]
    update_result = update_callback(SimpleNamespace(description=SimpleNamespace(schedule=SimpleNamespace())))
    assert isinstance(update_result, ScheduleUpdate)
    assert update_result.schedule.spec.cron_expressions == ["0 8 * * *"]


def test_fetch_coupa_config_rows_returns_empty_on_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """Coupa config fetch must return [] on 404, consistent with other integration resilience."""
    from urllib import error as urlerror

    def _raise_404(*_args, **_kwargs):
        raise urlerror.HTTPError("http://x", 404, "Not Found", hdrs=None, fp=None)

    monkeypatch.setattr(worker.settings, "supabase_url", "http://supabase.local", raising=False)
    monkeypatch.setattr(worker.settings, "supabase_service_role_key", "k", raising=False)
    monkeypatch.setattr(worker.request, "urlopen", _raise_404)
    assert worker._fetch_coupa_config_rows() == []


# ---------------------------------------------------------------------------
# Fleet utilization schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fleet_schedule_creates_when_enabled() -> None:
    """reconcile_fleet_schedules must create a schedule when none exists."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_fleet_schedules(
        client,
        [{"tenant_id": "tenant-f", "schedule": {"cron": "0 3 * * 1"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-f:fleet-auditor"
    assert create_args[1].spec.cron_expressions == ["0 3 * * 1"]
    assert create_args[1].action.id == "ops-fleet-tenant-f"


@pytest.mark.asyncio
async def test_fleet_schedule_deletes_when_disabled() -> None:
    """reconcile_fleet_schedules must delete the schedule when the config disables it."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_fleet_schedules(
        client,
        [{"tenant_id": "tenant-f", "schedule": {"enabled": False, "cron": "0 3 * * 1"}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_fleet_schedule_updates_existing() -> None:
    """reconcile_fleet_schedules must update an existing schedule with new cron."""
    schedule_handle = AsyncMock()
    schedule_handle.describe = AsyncMock(return_value=SimpleNamespace())
    schedule_handle.update = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_fleet_schedules(
        client,
        [{"tenant_id": "tenant-f", "schedule": {"enabled": True, "cron": "0 4 * * 2"}}],
    )

    schedule_handle.update.assert_awaited_once()
    update_callback = schedule_handle.update.await_args.args[0]
    update_result = update_callback(SimpleNamespace(description=SimpleNamespace(schedule=SimpleNamespace())))
    assert isinstance(update_result, ScheduleUpdate)
    assert update_result.schedule.spec.cron_expressions == ["0 4 * * 2"]


@pytest.mark.asyncio
async def test_fleet_schedule_creates_with_default_cron_when_none_given() -> None:
    """When config omits cron, the fleet default cron (weekly) must be used."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_fleet_schedules(
        client,
        [{"tenant_id": "tenant-f"}],
    )

    assert client.create_schedule.await_count == 1
    created_schedule = client.create_schedule.await_args.args[1]
    assert created_schedule.spec.cron_expressions == [worker._FLEET_DEFAULT_CRON]


def test_fetch_fleet_schedule_rows_returns_empty_on_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fleet config fetch must return [] on 404."""
    from urllib import error as urlerror

    def _raise_404(*_args, **_kwargs):
        raise urlerror.HTTPError("http://x", 404, "Not Found", hdrs=None, fp=None)

    monkeypatch.setattr(worker.settings, "supabase_url", "http://supabase.local", raising=False)
    monkeypatch.setattr(worker.settings, "supabase_service_role_key", "k", raising=False)
    monkeypatch.setattr(worker.request, "urlopen", _raise_404)
    assert worker._fetch_fleet_schedule_rows() == []


# ---------------------------------------------------------------------------
# Credit analyst schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_credit_schedule_creates_when_enabled() -> None:
    """reconcile_credit_schedules must create a schedule when none exists."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_credit_schedules(
        client,
        [{"tenant_id": "tenant-cr", "schedule": {"cron": "0 3 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-cr:credit-analyst"
    assert create_args[1].spec.cron_expressions == ["0 3 * * *"]
    assert create_args[1].action.id == "ops-credit-tenant-cr"


@pytest.mark.asyncio
async def test_credit_schedule_deletes_when_disabled() -> None:
    """reconcile_credit_schedules must delete the schedule when the config disables it."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_credit_schedules(
        client,
        [{"tenant_id": "tenant-cr", "schedule": {"enabled": False, "cron": "0 3 * * *"}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_credit_schedule_updates_existing() -> None:
    """reconcile_credit_schedules must update an existing schedule with new cron."""
    schedule_handle = AsyncMock()
    schedule_handle.describe = AsyncMock(return_value=SimpleNamespace())
    schedule_handle.update = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_credit_schedules(
        client,
        [{"tenant_id": "tenant-cr", "schedule": {"enabled": True, "cron": "0 4 * * *"}}],
    )

    schedule_handle.update.assert_awaited_once()
    update_callback = schedule_handle.update.await_args.args[0]
    update_result = update_callback(SimpleNamespace(description=SimpleNamespace(schedule=SimpleNamespace())))
    assert isinstance(update_result, ScheduleUpdate)
    assert update_result.schedule.spec.cron_expressions == ["0 4 * * *"]


@pytest.mark.asyncio
async def test_credit_schedule_creates_with_default_cron_when_none_given() -> None:
    """When config omits cron, the credit default cron (nightly) must be used."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_credit_schedules(
        client,
        [{"tenant_id": "tenant-cr"}],
    )

    assert client.create_schedule.await_count == 1
    created_schedule = client.create_schedule.await_args.args[1]
    assert created_schedule.spec.cron_expressions == [worker._CREDIT_DEFAULT_CRON]


# ---------------------------------------------------------------------------
# Shop morning queue schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shop_schedule_creates_when_enabled() -> None:
    """reconcile_shop_schedules must create a schedule when none exists."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_shop_schedules(
        client,
        [{"tenant_id": "tenant-sh", "schedule": {"cron": "0 7 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-sh:shop-morning-queue"
    assert create_args[1].spec.cron_expressions == ["0 7 * * *"]
    assert create_args[1].action.id == "ops-shop-morning-queue-tenant-sh"


@pytest.mark.asyncio
async def test_shop_schedule_deletes_when_disabled() -> None:
    """reconcile_shop_schedules must delete the schedule when the config disables it."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_shop_schedules(
        client,
        [{"tenant_id": "tenant-sh", "schedule": {"enabled": False}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_shop_schedule_creates_with_default_cron_when_none_given() -> None:
    """When config omits cron, the shop default cron (daily morning) must be used."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_shop_schedules(
        client,
        [{"tenant_id": "tenant-sh"}],
    )

    assert client.create_schedule.await_count == 1
    created_schedule = client.create_schedule.await_args.args[1]
    assert created_schedule.spec.cron_expressions == [worker._SHOP_MORNING_QUEUE_DEFAULT_CRON]


# ---------------------------------------------------------------------------
# Branch morning brief schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_branch_schedule_creates_when_enabled() -> None:
    """reconcile_branch_schedules must create a schedule when none exists."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_branch_schedules(
        client,
        [{"tenant_id": "tenant-br", "schedule": {"cron": "0 7 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-br:branch-morning-brief"
    assert create_args[1].spec.cron_expressions == ["0 7 * * *"]
    assert create_args[1].action.id == "ops-branch-morning-brief-tenant-br"


@pytest.mark.asyncio
async def test_branch_schedule_deletes_when_disabled() -> None:
    """reconcile_branch_schedules must delete the schedule when the config disables it."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_branch_schedules(
        client,
        [{"tenant_id": "tenant-br", "schedule": {"enabled": False}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_branch_schedule_creates_with_default_cron_when_none_given() -> None:
    """When config omits cron, the branch default cron (daily morning) must be used."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_branch_schedules(
        client,
        [{"tenant_id": "tenant-br"}],
    )

    assert client.create_schedule.await_count == 1
    created_schedule = client.create_schedule.await_args.args[1]
    assert created_schedule.spec.cron_expressions == [worker._BRANCH_MORNING_BRIEF_DEFAULT_CRON]


# ---------------------------------------------------------------------------
# Account health queue schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_account_health_schedule_creates_when_enabled() -> None:
    """reconcile_account_health_schedules must create a schedule when none exists."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_account_health_schedules(
        client,
        [{"tenant_id": "tenant-ah", "schedule": {"cron": "0 4 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-ah:account-health-queue"
    assert create_args[1].spec.cron_expressions == ["0 4 * * *"]
    assert create_args[1].action.id == "ops-account-health-queue-tenant-ah"


@pytest.mark.asyncio
async def test_account_health_schedule_deletes_when_disabled() -> None:
    """reconcile_account_health_schedules must delete the schedule when the config disables it."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_account_health_schedules(
        client,
        [{"tenant_id": "tenant-ah", "schedule": {"enabled": False}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_account_health_schedule_creates_with_default_cron_when_none_given() -> None:
    """When config omits cron, the account-health default cron (nightly) must be used."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_account_health_schedules(
        client,
        [{"tenant_id": "tenant-ah"}],
    )

    assert client.create_schedule.await_count == 1
    created_schedule = client.create_schedule.await_args.args[1]
    assert created_schedule.spec.cron_expressions == [worker._ACCOUNT_HEALTH_DEFAULT_CRON]


# ---------------------------------------------------------------------------
# Integration exception queue schedule reconciliation tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_integration_exception_schedule_creates_when_enabled() -> None:
    """reconcile_integration_exception_schedules must create a schedule when none exists."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_integration_exception_schedules(
        client,
        [{"tenant_id": "tenant-ie", "schedule": {"cron": "0 5 * * *"}}],
    )

    assert client.create_schedule.await_count == 1
    create_args = client.create_schedule.await_args.args
    assert create_args[0] == "ops:tenant-ie:integration-exception-queue"
    assert create_args[1].spec.cron_expressions == ["0 5 * * *"]
    assert create_args[1].action.id == "ops-integration-exception-queue-tenant-ie"


@pytest.mark.asyncio
async def test_integration_exception_schedule_deletes_when_disabled() -> None:
    """reconcile_integration_exception_schedules must delete the schedule when the config disables it."""
    schedule_handle = AsyncMock()
    schedule_handle.delete = AsyncMock()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_integration_exception_schedules(
        client,
        [{"tenant_id": "tenant-ie", "schedule": {"enabled": False}}],
    )

    schedule_handle.delete.assert_awaited_once()
    assert client.create_schedule.await_count == 0


@pytest.mark.asyncio
async def test_integration_exception_schedule_creates_with_default_cron_when_none_given() -> None:
    """When config omits cron, the integration-exception default cron (nightly) must be used."""
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    await worker.reconcile_integration_exception_schedules(
        client,
        [{"tenant_id": "tenant-ie"}],
    )

    assert client.create_schedule.await_count == 1
    created_schedule = client.create_schedule.await_args.args[1]
    assert created_schedule.spec.cron_expressions == [worker._INTEGRATION_EXCEPTION_DEFAULT_CRON]


@pytest.mark.asyncio
async def test_ops_agent_schedules_are_isolated_from_each_other() -> None:
    """Behavioral regression: each ops agent reconcile path creates only its own schedule.

    Calling fleet, credit, shop, branch, account-health, and integration-exception
    reconcile in sequence must produce one schedule per agent, with no cross-contamination.
    """
    schedule_handle = AsyncMock()
    schedule_handle.describe.side_effect = _not_found_error()

    client = Mock()
    client.get_schedule_handle.return_value = schedule_handle
    client.create_schedule = AsyncMock()

    tenant_row = [{"tenant_id": "tenant-multi", "schedule": {"enabled": True, "cron": "0 3 * * *"}}]

    await worker.reconcile_fleet_schedules(client, tenant_row)
    await worker.reconcile_credit_schedules(client, tenant_row)
    await worker.reconcile_shop_schedules(client, tenant_row)
    await worker.reconcile_branch_schedules(client, tenant_row)
    await worker.reconcile_account_health_schedules(client, tenant_row)
    await worker.reconcile_integration_exception_schedules(client, tenant_row)

    created_ids = [call.args[0] for call in client.create_schedule.await_args_list]
    assert len(created_ids) == 6
    expected_ids = {
        "ops:tenant-multi:fleet-auditor",
        "ops:tenant-multi:credit-analyst",
        "ops:tenant-multi:shop-morning-queue",
        "ops:tenant-multi:branch-morning-brief",
        "ops:tenant-multi:account-health-queue",
        "ops:tenant-multi:integration-exception-queue",
    }
    assert set(created_ids) == expected_ids
