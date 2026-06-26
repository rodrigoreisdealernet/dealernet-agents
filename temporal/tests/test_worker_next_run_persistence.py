"""Worker-side wiring of schedule next-run persistence (issue #124).

These exercise ``worker._persist_schedule_next_run_best_effort`` — the function
the four DIA reconcilers call to capture and persist each schedule's next fire
time. They map to:

* AC3 — enabled agents persist Temporal's reported next fire time.
* AC4 — disabled agents persist ``None`` (clears any stale time).
* AC5 — when ``describe()`` is unavailable, it degrades to the pure-Python cron
  calculation; persistence failures are swallowed and never break reconciliation.

No network / Temporal: the PostgREST write (``persist_schedule_next_run``) is
monkeypatched to capture its arguments, following the mocking style in
``test_worker_schedule_reconcile.py``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from temporal.src import worker
from temporal.src.schedule_next_run import cron_next_run_iso


@pytest.fixture()
def captured_persist(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    """Capture every (agent_key, tenant_id, next_run_at) the worker persists."""
    calls: list[tuple] = []

    def _capture(agent_key: str, tenant_id: str, next_run_at: str | None) -> None:
        calls.append((agent_key, tenant_id, next_run_at))

    monkeypatch.setattr(worker, "persist_schedule_next_run", _capture)
    return calls


@pytest.mark.asyncio
async def test_disabled_agent_persists_null_next_run(captured_persist: list[tuple]) -> None:
    # AC4: a disabled agent clears its next-run; no describe() is consulted.
    await worker._persist_schedule_next_run_best_effort(
        None, "vehicle-aging-analyst", "tenant-a", "0 6 * * 1-5", enabled=False
    )
    assert captured_persist == [("vehicle-aging-analyst", "tenant-a", None)]


@pytest.mark.asyncio
async def test_enabled_agent_persists_temporal_next_action_time(
    captured_persist: list[tuple],
) -> None:
    # AC3: enabled agent persists Temporal's reported next fire time verbatim.
    when = datetime(2026, 6, 29, 6, 0, tzinfo=timezone.utc)
    handle = AsyncMock()
    handle.describe = AsyncMock(
        return_value=SimpleNamespace(info=SimpleNamespace(next_action_times=[when]))
    )

    await worker._persist_schedule_next_run_best_effort(
        handle, "collections-prioritizer", "tenant-b", "0 6 * * 1-5", enabled=True
    )

    assert captured_persist == [("collections-prioritizer", "tenant-b", when.isoformat())]


@pytest.mark.asyncio
async def test_enabled_agent_falls_back_to_cron_when_describe_raises(
    captured_persist: list[tuple],
) -> None:
    # AC5: Temporal down -> describe() raises -> use the pure-Python cron calc.
    handle = AsyncMock()
    handle.describe = AsyncMock(side_effect=RuntimeError("temporal unavailable"))

    await worker._persist_schedule_next_run_best_effort(
        handle, "service-estimate-rescue", "tenant-c", "0 7 * * 1-5", enabled=True
    )

    assert len(captured_persist) == 1
    agent_key, tenant_id, next_run_at = captured_persist[0]
    assert (agent_key, tenant_id) == ("service-estimate-rescue", "tenant-c")
    assert next_run_at is not None
    assert next_run_at == cron_next_run_iso("0 7 * * 1-5")  # cron fallback used


@pytest.mark.asyncio
async def test_enabled_agent_with_empty_next_action_times_uses_cron(
    captured_persist: list[tuple],
) -> None:
    # AC5: describe() works but reports no upcoming actions -> cron fallback.
    handle = AsyncMock()
    handle.describe = AsyncMock(
        return_value=SimpleNamespace(info=SimpleNamespace(next_action_times=[]))
    )

    await worker._persist_schedule_next_run_best_effort(
        handle, "parts-inventory-advisor", "tenant-d", "0 6 * * 1", enabled=True
    )

    assert captured_persist[0][2] == cron_next_run_iso("0 6 * * 1")


@pytest.mark.asyncio
async def test_persistence_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    # AC5: a raising persist must not propagate out of reconciliation.
    def _boom(agent_key: str, tenant_id: str, next_run_at: str | None) -> None:
        raise RuntimeError("postgrest exploded")

    monkeypatch.setattr(worker, "persist_schedule_next_run", _boom)

    # Must not raise.
    await worker._persist_schedule_next_run_best_effort(
        None, "vehicle-aging-analyst", "tenant-a", "0 6 * * 1-5", enabled=False
    )
