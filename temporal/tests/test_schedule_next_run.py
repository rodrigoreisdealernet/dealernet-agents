"""Tests for the agent schedule next-run resolution/persistence (issue #124).

Traceability to the acceptance criteria in
``docs/specs/124-feat-ops-proxima-execucao-real.md``:

* AC2 — the next run is *cron-derived* (the pure-Python 5-field calculation
  produces a coherent next execution for the seed crons, e.g. ``0 6 * * 1-5``).
* AC3 — during reconciliation / after run-now the worker captures the schedule's
  next fire time and persists it into ``schedule.next_run_at`` via PostgREST.
* AC4 — disabled / unscheduled agents persist ``None`` so the dashboard shows
  "no scheduled run" instead of a stale time.
* AC5 — robust fallback: Temporal's ``next_action_times`` is preferred; absence
  degrades to the cron calculation; an invalid cron degrades to ``None`` and
  never breaks reconciliation.

These tests are pure-Python and make no network calls: the PostgREST write is
monkeypatched (mirroring the urlopen-mocking style in
``test_worker_schedule_reconcile.py`` and ``test_ops_api.py``).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib import error

import pytest

from temporal.src import schedule_next_run
from temporal.src.schedule_next_run import (
    cron_next_run_iso,
    next_action_time_iso,
    next_cron_run,
    persist_schedule_next_run,
    resolve_next_run_iso,
)


def _utc(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# AC2 / AC5 — pure-Python 5-field cron next-occurrence (`next_cron_run`).
# 2026-06-26 is a Friday; the cases below pin the weekday/weekend behaviour.
# ---------------------------------------------------------------------------


def test_weekday_cron_rolls_friday_evening_to_monday_morning() -> None:
    # 0 6 * * 1-5 = weekdays at 06:00. From Friday 07:00 the next fire skips the
    # weekend (Sat/Sun) and lands on Monday 06:00.
    after = _utc(2026, 6, 26, 7, 0)  # Friday, after the 06:00 fire
    assert next_cron_run("0 6 * * 1-5", after) == _utc(2026, 6, 29, 6, 0)  # Monday


def test_weekday_cron_same_day_when_before_fire_time() -> None:
    # From Friday 05:00 (still a weekday, before 06:00) -> same Friday 06:00.
    after = _utc(2026, 6, 26, 5, 0)
    assert next_cron_run("0 6 * * 1-5", after) == _utc(2026, 6, 26, 6, 0)


def test_weekday_cron_skips_the_whole_weekend() -> None:
    # From Saturday -> Monday; from Sunday -> Monday. Weekend never fires.
    sat = next_cron_run("0 6 * * 1-5", _utc(2026, 6, 27, 12, 0))  # Saturday
    sun = next_cron_run("0 6 * * 1-5", _utc(2026, 6, 28, 12, 0))  # Sunday
    assert sat == _utc(2026, 6, 29, 6, 0)
    assert sun == _utc(2026, 6, 29, 6, 0)


def test_weekday_cron_is_strictly_after_when_exactly_on_fire_time() -> None:
    # Exactly at Monday 06:00 -> the *next* run is Tuesday 06:00 (strictly after).
    after = _utc(2026, 6, 22, 6, 0)  # Monday 06:00
    assert next_cron_run("0 6 * * 1-5", after) == _utc(2026, 6, 23, 6, 0)


def test_single_weekday_cron_parts_inventory_monday_only() -> None:
    # 0 6 * * 1 = Mondays at 06:00 (parts-inventory-advisor seed).
    after = _utc(2026, 6, 26, 9, 0)  # Friday
    assert next_cron_run("0 6 * * 1", after) == _utc(2026, 6, 29, 6, 0)  # Monday


def test_both_restricted_dom_and_dow_match_with_or_semantics() -> None:
    # When BOTH day-of-month and day-of-week are restricted, cron uses OR:
    # "0 0 13 * 5" fires at 00:00 on the 13th OR on any Friday.
    # 2026-06-26 is a Friday; the next Friday at 00:00 is 2026-07-03 (dow branch).
    assert next_cron_run("0 0 13 * 5", _utc(2026, 6, 26, 7, 0)) == _utc(2026, 7, 3, 0, 0)
    # 2026-08-13 is a Thursday (not a Friday): the 13th still fires via the
    # day-of-month branch, before the next Friday (2026-08-14).
    assert next_cron_run("0 0 13 * 5", _utc(2026, 8, 12, 12, 0)) == _utc(2026, 8, 13, 0, 0)


def test_daily_cron_next_occurrence() -> None:
    # 30 9 * * * = every day at 09:30.
    assert next_cron_run("30 9 * * *", _utc(2026, 6, 26, 8, 0)) == _utc(2026, 6, 26, 9, 30)
    assert next_cron_run("30 9 * * *", _utc(2026, 6, 26, 9, 30)) == _utc(2026, 6, 27, 9, 30)


def test_every_n_hours_cron_next_occurrence() -> None:
    # 0 */6 * * * = 00:00, 06:00, 12:00, 18:00. From 13:00 -> 18:00 same day.
    assert next_cron_run("0 */6 * * *", _utc(2026, 6, 26, 13, 0)) == _utc(2026, 6, 26, 18, 0)
    # From 19:00 -> next day's 00:00 (rolls past the last slot of the day).
    assert next_cron_run("0 */6 * * *", _utc(2026, 6, 26, 19, 0)) == _utc(2026, 6, 27, 0, 0)


def test_naive_after_is_treated_as_utc() -> None:
    naive = datetime(2026, 6, 26, 5, 0)  # no tzinfo
    assert next_cron_run("0 6 * * 1-5", naive) == _utc(2026, 6, 26, 6, 0)


@pytest.mark.parametrize("bad_cron", ["", "0 6 * *", "0 6 * * 1-5 7", "not a cron"])
def test_invalid_field_count_raises_value_error(bad_cron: str) -> None:
    with pytest.raises(ValueError):
        next_cron_run(bad_cron, _utc(2026, 6, 26, 7, 0))


def test_unsatisfiable_cron_returns_none_instead_of_spinning() -> None:
    # Minute 60 is out of bounds, so no candidate ever matches -> None (bounded scan).
    assert next_cron_run("60 6 * * *", _utc(2026, 6, 26, 7, 0)) is None


# ---------------------------------------------------------------------------
# AC2 / AC5 — `cron_next_run_iso` wraps `next_cron_run`, returning ISO or None.
# ---------------------------------------------------------------------------


def test_cron_next_run_iso_returns_iso_string() -> None:
    iso = cron_next_run_iso("0 6 * * 1-5")
    assert iso is not None
    parsed = datetime.fromisoformat(iso)
    # Always a future weekday at 06:00 UTC.
    assert parsed.hour == 6 and parsed.minute == 0
    assert parsed.weekday() < 5  # Mon..Fri
    assert parsed > datetime.now(timezone.utc)


@pytest.mark.parametrize("bad_cron", ["", "garbage", "0 6 * *"])
def test_cron_next_run_iso_returns_none_for_invalid(bad_cron: str) -> None:
    assert cron_next_run_iso(bad_cron) is None


# ---------------------------------------------------------------------------
# AC3 / AC5 — `next_action_time_iso` reads Temporal's next_action_times[0].
# ---------------------------------------------------------------------------


def test_next_action_time_iso_reads_first_action_time() -> None:
    when = _utc(2026, 6, 29, 6, 0)
    desc = SimpleNamespace(info=SimpleNamespace(next_action_times=[when, _utc(2026, 6, 30, 6, 0)]))
    assert next_action_time_iso(desc) == when.isoformat()


def test_next_action_time_iso_none_when_empty_or_missing() -> None:
    assert next_action_time_iso(SimpleNamespace(info=SimpleNamespace(next_action_times=[]))) is None
    assert next_action_time_iso(SimpleNamespace(info=SimpleNamespace(next_action_times=None))) is None
    assert next_action_time_iso(SimpleNamespace()) is None
    assert next_action_time_iso(None) is None


# ---------------------------------------------------------------------------
# AC5 — `resolve_next_run_iso` prefers Temporal, falls back to cron, else None.
# ---------------------------------------------------------------------------


def test_resolve_prefers_temporal_next_action_time_over_cron() -> None:
    temporal_when = _utc(2030, 1, 1, 6, 0)
    desc = SimpleNamespace(info=SimpleNamespace(next_action_times=[temporal_when]))
    # Even with a valid cron, the Temporal-reported time wins.
    assert resolve_next_run_iso(desc, "0 6 * * 1-5") == temporal_when.isoformat()


def test_resolve_falls_back_to_cron_when_temporal_unavailable() -> None:
    desc = SimpleNamespace(info=SimpleNamespace(next_action_times=[]))
    resolved = resolve_next_run_iso(desc, "0 6 * * 1-5")
    assert resolved is not None
    assert resolved == cron_next_run_iso("0 6 * * 1-5")


def test_resolve_returns_none_when_both_temporal_and_cron_fail() -> None:
    desc = SimpleNamespace()  # no info -> no next_action_times
    assert resolve_next_run_iso(desc, "totally invalid cron") is None


# ---------------------------------------------------------------------------
# AC3 / AC4 — `persist_schedule_next_run` PATCHes schedule.next_run_at via
# PostgREST. No real network: urlopen is monkeypatched to capture the writes.
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def _install_fake_postgrest(
    monkeypatch: pytest.MonkeyPatch, *, get_rows: list[dict], captured: dict
):
    monkeypatch.setattr(schedule_next_run.settings, "supabase_url", "http://supabase.local", raising=False)
    monkeypatch.setattr(
        schedule_next_run.settings, "supabase_service_role_key", "service-key", raising=False
    )

    def _fake_urlopen(req, timeout=None):  # noqa: ANN001
        method = req.get_method()
        if method == "GET":
            captured["get_url"] = req.full_url
            return _FakeResponse(json.dumps(get_rows).encode("utf-8"))
        if method == "PATCH":
            captured["patch_url"] = req.full_url
            captured["patch_body"] = json.loads(req.data.decode("utf-8"))
            return _FakeResponse(b"")
        raise AssertionError(f"unexpected method {method}")

    monkeypatch.setattr(schedule_next_run.request, "urlopen", _fake_urlopen)


def test_persist_merges_next_run_into_current_schedule(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}
    rows = [{"id": "ver-1", "data": {"schedule": {"cron": "0 6 * * 1-5", "enabled": True}}}]
    _install_fake_postgrest(monkeypatch, get_rows=rows, captured=captured)

    persist_schedule_next_run("vehicle-aging-analyst", "tenant-a", "2026-06-29T06:00:00+00:00")

    # PATCH targets the current version row and preserves existing schedule keys.
    assert "id=eq.ver-1" in captured["patch_url"]
    schedule = captured["patch_body"]["data"]["schedule"]
    assert schedule["next_run_at"] == "2026-06-29T06:00:00+00:00"
    assert schedule["cron"] == "0 6 * * 1-5"  # untouched
    assert schedule["enabled"] is True


def test_persist_none_clears_stale_next_run(monkeypatch: pytest.MonkeyPatch) -> None:
    # AC4: disabled/unscheduled -> persist None so the dashboard shows "no run".
    captured: dict = {}
    rows = [{"id": "ver-9", "data": {"schedule": {"cron": "0 6 * * 1-5", "next_run_at": "STALE"}}}]
    _install_fake_postgrest(monkeypatch, get_rows=rows, captured=captured)

    persist_schedule_next_run("collections-prioritizer", "tenant-b", None)

    assert captured["patch_body"]["data"]["schedule"]["next_run_at"] is None


def test_persist_skips_patch_when_no_current_version(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}
    _install_fake_postgrest(monkeypatch, get_rows=[], captured=captured)

    persist_schedule_next_run("vehicle-aging-analyst", "tenant-a", "2026-06-29T06:00:00+00:00")

    assert "patch_body" not in captured  # nothing to update -> no PATCH


def test_persist_never_raises_on_postgrest_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    # AC5: a failed write degrades silently; it must not break reconciliation.
    monkeypatch.setattr(schedule_next_run.settings, "supabase_url", "http://supabase.local", raising=False)
    monkeypatch.setattr(
        schedule_next_run.settings, "supabase_service_role_key", "service-key", raising=False
    )

    def _boom(req, timeout=None):  # noqa: ANN001
        raise error.URLError("connection refused")

    monkeypatch.setattr(schedule_next_run.request, "urlopen", _boom)

    # Must not raise.
    persist_schedule_next_run("vehicle-aging-analyst", "tenant-a", "2026-06-29T06:00:00+00:00")
