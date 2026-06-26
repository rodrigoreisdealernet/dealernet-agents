"""Next-run resolution and persistence for agent Temporal Schedules.

The Agents (DIA) dashboard reads ``ops_agent_status_view.next_run_at``, which is
derived from ``ops_agent_config.schedule.next_run_at``. The worker owns that
value: during reconciliation it captures the Schedule's real next fire time
(``ScheduleHandle.describe().info.next_action_times[0]``) and persists it back to
the agent config so the dashboard can show a truthful "next run".

This module is intentionally dependency-free:

* ``next_cron_run`` is a pure-Python next-occurrence for 5-field cron
  expressions (minute hour day-of-month month day-of-week). It exists as a
  production fallback so an unavailable Temporal / missing ``next_action_times``
  never leaves the dashboard blind. We deliberately avoid ``croniter`` (a new
  heavy dependency would require an ADR).
* ``persist_schedule_next_run`` is a best-effort PostgREST write that merges the
  computed value into the current ``agent_config`` entity version. It never
  raises: a failed write degrades to a stale/``null`` value, it must not break
  reconciliation or the view.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib import error, parse, request

from .config import settings

logger = logging.getLogger(__name__)

# (low, high) inclusive bounds for minute, hour, day-of-month, month, day-of-week.
# Day-of-week allows 7 as an alias for Sunday (normalised to 0 below).
_FIELD_BOUNDS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))

# Cap the minute-by-minute scan so a pathological (never-matching) expression
# can never spin forever; valid crons resolve in well under a day.
_MAX_SCAN_DAYS = 366 * 4


def _parse_cron_field(expr: str, low: int, high: int) -> set[int]:
    """Expand a single cron field into the set of matching integers.

    Supports ``*``, comma lists, ``a-b`` ranges and ``*/n`` / ``a-b/n`` steps.
    """
    values: set[int] = set()
    for raw_part in expr.split(","):
        part = raw_part.strip()
        if not part:
            continue
        step = 1
        base = part
        if "/" in part:
            base, _, step_raw = part.partition("/")
            step = int(step_raw)
            if step <= 0:
                raise ValueError(f"invalid cron step in {expr!r}")
        if base in ("*", ""):
            start, end = low, high
        elif "-" in base:
            start_raw, _, end_raw = base.partition("-")
            start, end = int(start_raw), int(end_raw)
        else:
            start = end = int(base)
        for value in range(start, end + 1, step):
            if low <= value <= high:
                values.add(value)
    return values


def next_cron_run(cron: str, after: datetime) -> datetime | None:
    """Return the first fire time strictly after *after* for a 5-field *cron*.

    Returns ``None`` when no occurrence is found within the scan window.
    """
    fields = cron.split()
    if len(fields) != 5:
        raise ValueError(f"expected a 5-field cron expression, got {cron!r}")

    minutes, hours, doms, months, dows = (
        _parse_cron_field(field, low, high)
        for field, (low, high) in zip(fields, _FIELD_BOUNDS)
    )
    # Normalise day-of-week 7 (Sunday) to 0 so both spellings match.
    if 7 in dows:
        dows = (dows - {7}) | {0}

    dom_restricted = fields[2].strip() != "*"
    dow_restricted = fields[4].strip() != "*"

    if after.tzinfo is None:
        after = after.replace(tzinfo=timezone.utc)
    candidate = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    limit = candidate + timedelta(days=_MAX_SCAN_DAYS)

    while candidate <= limit:
        if (
            candidate.month in months
            and candidate.hour in hours
            and candidate.minute in minutes
        ):
            dom_ok = candidate.day in doms
            # Python weekday(): Mon=0..Sun=6; cron day-of-week: Sun=0..Sat=6.
            cron_dow = (candidate.weekday() + 1) % 7
            dow_ok = cron_dow in dows
            if dom_restricted and dow_restricted:
                day_match = dom_ok or dow_ok
            elif dom_restricted:
                day_match = dom_ok
            elif dow_restricted:
                day_match = dow_ok
            else:
                day_match = True
            if day_match:
                return candidate
        candidate += timedelta(minutes=1)
    return None


def _isoformat_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def cron_next_run_iso(cron: str) -> str | None:
    """Pure-cron fallback: ISO-8601 next run for *cron*, or ``None`` on failure."""
    try:
        nxt = next_cron_run(cron, datetime.now(timezone.utc))
    except (ValueError, OverflowError) as exc:
        logger.warning("cron next-run fallback failed for %r: %s", cron, exc)
        return None
    return _isoformat_utc(nxt) if nxt is not None else None


def next_action_time_iso(desc: Any) -> str | None:
    """Read ``desc.info.next_action_times[0]`` as ISO-8601, or ``None``."""
    try:
        times = getattr(getattr(desc, "info", None), "next_action_times", None)
        if times:
            first = times[0]
            if isinstance(first, datetime):
                return _isoformat_utc(first)
    except Exception as exc:  # noqa: BLE001 - best-effort read, never propagate
        logger.warning("could not read next_action_times: %s", exc)
    return None


def resolve_next_run_iso(desc: Any, cron: str) -> str | None:
    """Prefer Temporal's reported next fire time; fall back to cron calculation."""
    from_temporal = next_action_time_iso(desc)
    if from_temporal is not None:
        return from_temporal
    return cron_next_run_iso(cron)


def _service_role_headers() -> dict[str, str]:
    return {
        "apikey": settings.supabase_service_role_key,
        "Authorization": "Bearer " + settings.supabase_service_role_key,
    }


def persist_schedule_next_run(agent_key: str, tenant_id: str, next_run_at: str | None) -> None:
    """Persist *next_run_at* into the current ``agent_config`` schedule (best-effort).

    Merges ``schedule.next_run_at`` into the current ``entity_versions`` row for
    ``<tenant_id>:<agent_key>``. A ``None`` value clears any stale time so a
    disabled / unscheduled agent shows "no scheduled run". Never raises.
    """
    base_url = settings.supabase_url.rstrip("/")
    source_record_id = f"{tenant_id}:{agent_key}"
    encoded = parse.quote(source_record_id, safe="")
    try:
        get_url = (
            f"{base_url}/rest/v1/entity_versions"
            "?select=id,data,entities!inner(entity_type,source_record_id)"
            "&entities.entity_type=eq.agent_config"
            f"&entities.source_record_id=eq.{encoded}"
            "&is_current=is.true"
        )
        get_req = request.Request(
            get_url,
            headers={**_service_role_headers(), "Accept": "application/json"},
            method="GET",
        )
        with request.urlopen(get_req, timeout=30) as response:
            rows = json.loads(response.read().decode("utf-8"))

        if not isinstance(rows, list) or not rows:
            logger.warning(
                "next_run_at persist skipped: agent_config version not found",
                extra={"agent_key": agent_key, "tenant_id": tenant_id},
            )
            return

        row = rows[0]
        version_id = row.get("id")
        data = row.get("data")
        if version_id is None or not isinstance(data, dict):
            logger.warning(
                "next_run_at persist skipped: malformed agent_config version",
                extra={"agent_key": agent_key, "tenant_id": tenant_id},
            )
            return

        schedule = dict(data.get("schedule") or {})
        schedule["next_run_at"] = next_run_at
        data["schedule"] = schedule

        patch_url = f"{base_url}/rest/v1/entity_versions?id=eq.{parse.quote(str(version_id), safe='')}"
        patch_req = request.Request(
            patch_url,
            data=json.dumps({"data": data}).encode("utf-8"),
            headers={
                **_service_role_headers(),
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            method="PATCH",
        )
        with request.urlopen(patch_req, timeout=30):
            pass
        logger.info(
            "Persisted schedule next_run_at",
            extra={"agent_key": agent_key, "tenant_id": tenant_id, "next_run_at": next_run_at},
        )
    except (error.HTTPError, error.URLError, OSError, ValueError) as exc:
        logger.warning(
            "Failed to persist schedule next_run_at (best-effort)",
            extra={"agent_key": agent_key, "tenant_id": tenant_id, "error": str(exc)},
        )
