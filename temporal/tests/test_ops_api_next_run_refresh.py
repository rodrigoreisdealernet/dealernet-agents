"""Run-now next-run refresh coverage (issue #124, AC3 second half).

``ops_api.app._refresh_next_run_after_trigger`` is the *other* half of AC3: after
a manual ``run_now`` trigger it re-reads the schedule's next fire time and
persists it. Its contract is deliberately **distinct** from the worker path and
must be pinned:

* It is **Temporal-only** — it persists ``next_action_times[0]`` and never uses
  the pure-Python cron fallback.
* When there is no next action time (or ``describe()`` fails), it does **not**
  invent a value and does **not** clear the stored value to ``None`` — it is a
  no-op, leaving any existing next-run untouched.
* It swallows ``BaseException`` — a failed refresh must never fail the run-now
  request.

No network / Temporal: the schedule handle's ``describe()`` and the PostgREST
write (``persist_schedule_next_run``) are mocked, following the style of
``test_ops_api.py`` / ``test_worker_schedule_reconcile.py``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from temporal.src.ops_api import app


@pytest.fixture()
def captured_persist(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    """Capture every (agent_key, tenant_id, next_run_at) persisted by app."""
    calls: list[tuple] = []

    def _capture(agent_key: str, tenant_id: str, next_run_at: str | None) -> None:
        calls.append((agent_key, tenant_id, next_run_at))

    monkeypatch.setattr(app, "persist_schedule_next_run", _capture)
    return calls


@pytest.mark.asyncio
async def test_refresh_persists_temporal_next_action_time(
    captured_persist: list[tuple],
) -> None:
    # Contract 1: persists Temporal's reported next fire time verbatim.
    when = datetime(2026, 6, 29, 6, 0, tzinfo=timezone.utc)
    handle = AsyncMock()
    handle.describe = AsyncMock(
        return_value=SimpleNamespace(
            info=SimpleNamespace(next_action_times=[when, datetime(2026, 6, 30, 6, 0, tzinfo=timezone.utc)])
        )
    )

    await app._refresh_next_run_after_trigger(
        handle, agent_key="vehicle-aging-analyst", tenant_id="tenant-a"
    )

    handle.describe.assert_awaited_once()
    assert captured_persist == [("vehicle-aging-analyst", "tenant-a", when.isoformat())]


@pytest.mark.asyncio
async def test_refresh_is_temporal_only_no_cron_fallback(
    captured_persist: list[tuple], monkeypatch: pytest.MonkeyPatch
) -> None:
    # Contract 2a: no next action time -> NO-OP. It must not invent a cron value
    # and must not clear the stored value to None. A valid cron is irrelevant
    # because this path never consults the cron calculation at all.
    cron_calls: list[object] = []

    def _spy_cron(*args, **kwargs):  # noqa: ANN002, ANN003
        cron_calls.append((args, kwargs))
        return "2099-01-01T06:00:00+00:00"

    # Guard against any accidental cron usage being wired into this module later.
    monkeypatch.setattr(app, "cron_next_run_iso", _spy_cron, raising=False)

    handle = AsyncMock()
    handle.describe = AsyncMock(
        return_value=SimpleNamespace(info=SimpleNamespace(next_action_times=[]))
    )

    await app._refresh_next_run_after_trigger(
        handle, agent_key="collections-prioritizer", tenant_id="tenant-b"
    )

    handle.describe.assert_awaited_once()
    assert captured_persist == []  # no-op: nothing persisted (not even None)
    assert cron_calls == []  # no cron fallback used


@pytest.mark.asyncio
async def test_refresh_noop_when_describe_fails(captured_persist: list[tuple]) -> None:
    # Contract 2b + 3: describe() failure is swallowed and persists nothing.
    handle = AsyncMock()
    handle.describe = AsyncMock(side_effect=RuntimeError("temporal unavailable"))

    # Must not raise.
    await app._refresh_next_run_after_trigger(
        handle, agent_key="service-estimate-rescue", tenant_id="tenant-c"
    )

    assert captured_persist == []


@pytest.mark.asyncio
async def test_refresh_swallows_persist_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    # Contract 3: a raising persist must not propagate out of run-now.
    def _boom(agent_key: str, tenant_id: str, next_run_at: str | None) -> None:
        raise RuntimeError("postgrest exploded")

    monkeypatch.setattr(app, "persist_schedule_next_run", _boom)

    when = datetime(2026, 6, 29, 6, 0, tzinfo=timezone.utc)
    handle = AsyncMock()
    handle.describe = AsyncMock(
        return_value=SimpleNamespace(info=SimpleNamespace(next_action_times=[when]))
    )

    # Must not raise even though persist explodes.
    await app._refresh_next_run_after_trigger(
        handle, agent_key="parts-inventory-advisor", tenant_id="tenant-d"
    )
