"""Preventative-maintenance evaluator activities.

Trigger families supported:
  - meter          : due when latest meter reading >= threshold
  - rental_count   : due when completed-rental count >= threshold
  - time_interval  : due when days since last maintenance >= interval_days

Idempotency:
  Each due event produces a stable ``fingerprint`` key.  Before creating a
  work order the workflow checks ``pm_list_open_wo_fingerprints``; if the key
  is already present the work order is skipped.  Work-order IDs are derived
  deterministically from the fingerprint (UUID-v5), so retried activity
  executions cannot produce duplicate rows.

Sparse-data safety:
  A ``meter`` policy with no meter readings available returns ``is_due=False``
  rather than assuming usage.
"""
from __future__ import annotations

import logging
import math
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from temporalio import activity

from ..models.rental import PMEvaluationResult, PMTriggerType

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_ops_persistence_client():
    """Return a configured Supabase PostgREST client.

    Defined as a module-level function so tests can patch
    ``temporal.src.activities.ops_pm._get_ops_persistence_client``
    without touching other activity modules.
    """
    from . import ops_revrec  # noqa: PLC0415 — lazy import avoids circular init
    return ops_revrec._get_ops_persistence_client()  # noqa: SLF001


def _json_object(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _idempotent_id(seed: str) -> str:
    """Return a deterministic UUID-v5 from *seed* (namespace: DNS)."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, seed))


def _parse_iso(ts: str | None) -> datetime | None:
    """Parse an ISO-8601 string to an aware datetime; return None on failure."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except ValueError:
        return None


def _meter_fingerprint(asset_id: str, policy_id: str, threshold: float, meter_value: float) -> str:
    """Stable key for a meter-based due event.

    The window is the threshold band the asset is currently in:
    ``floor(meter / threshold) * threshold``.  This means a new fingerprint
    is minted each time the meter crosses another multiple of the threshold,
    so a 500h policy generates a different fingerprint at 500h, 1000h, 1500h, etc.
    """
    band = int(math.floor(meter_value / threshold) * threshold) if threshold > 0 else 0
    return f"pm:{asset_id}:{policy_id}:meter:{band}"


def _rental_count_fingerprint(asset_id: str, policy_id: str, threshold: float, count: int) -> str:
    """Stable key for a rental-count due event (one per threshold crossing band)."""
    band = int(math.floor(count / threshold)) if threshold > 0 else 0
    return f"pm:{asset_id}:{policy_id}:rental_count:{band}"


def _time_interval_fingerprint(
    asset_id: str,
    policy_id: str,
    interval_days: int,
    baseline: datetime,
    eval_now: datetime,
) -> str:
    """Stable key for a time-interval due event (one per interval window).

    The window index is derived from ``eval_now`` — the evaluation timestamp
    passed by the caller — not from wall-clock time.  This guarantees the
    fingerprint is identical for any two calls with the same
    ``evaluation_timestamp``, even if those calls span a midnight boundary or
    are separated by hours during a Temporal retry.
    """
    elapsed_days = (eval_now - baseline).days
    window = elapsed_days // interval_days if interval_days > 0 else 0
    return f"pm:{asset_id}:{policy_id}:time_interval:{window}"


# ---------------------------------------------------------------------------
# Activity: scope enabled policies
# ---------------------------------------------------------------------------

@activity.defn
def pm_scope_enabled_policies(tenant_id: str) -> list[dict[str, Any]]:
    """Return effective PM policies with embedded asset context for *tenant_id*.

    Queries ``v_pm_policy_effective`` (which merges category defaults with
    asset-level overrides), filters to the tenant's assets, then annotates
    each policy dict with an ``asset_context`` sub-dict containing the data
    needed by ``pm_evaluate_trigger``:

    - ``latest_meter_value``       – most recent meter reading (float | None)
    - ``rental_completion_count``  – total completed rentals (int)
    - ``last_maintenance_at``      – ISO-8601 timestamp of last downtime event (str | None)
    - ``asset_created_at``         – ISO-8601 entity creation timestamp (str)

    Also embeds ``tenant_id`` in each policy dict so it flows through to
    ``pm_upsert_work_order`` without a separate argument.
    """
    client = _get_ops_persistence_client()

    # 1. Resolve the tenant's asset IDs from current entity state.
    asset_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id,data,created_at",
        filters={"entity_type": "asset"},
    )
    tenant_assets: dict[str, dict[str, Any]] = {}
    for row in asset_rows:
        data = _json_object(row.get("data"))
        if str(data.get("tenant_id")) == tenant_id:
            asset_id = str(row.get("entity_id") or "")
            if asset_id:
                tenant_assets[asset_id] = {
                    "asset_created_at": str(row.get("created_at") or ""),
                }

    if not tenant_assets:
        logger.info("pm_scope_enabled_policies: no assets for tenant", extra={"tenant_id": tenant_id})
        return []

    # 2. Fetch all effective PM policies; filter to this tenant's assets in Python
    #    (v_pm_policy_effective has no tenant_id column).
    policy_rows = client.select("v_pm_policy_effective")
    tenant_policies = [
        row for row in policy_rows
        if str(row.get("asset_id") or "") in tenant_assets
    ]

    if not tenant_policies:
        return []

    # 3. Fetch latest meter readings (one per asset).
    meter_rows = client.select("v_asset_latest_meter", columns="asset_id,reading_value")
    meter_by_asset: dict[str, Any] = {
        str(r.get("asset_id")): r.get("reading_value") for r in meter_rows
    }

    # 4. Fetch rental completion counts.
    count_rows = client.select(
        "v_asset_rental_completion_count",
        columns="asset_id,rental_completion_count",
    )
    count_by_asset: dict[str, int] = {
        str(r.get("asset_id")): int(r.get("rental_completion_count") or 0)
        for r in count_rows
    }

    # 5. Fetch last maintenance timestamps from time_series_points.
    #    Scoped to fact_type 'asset_downtime' AND metadata->>'source' = 'maintenance'
    #    so that inspection-sourced downtime rows do not advance the PM baseline.
    last_maint_by_asset: dict[str, str] = {}
    ft_rows = client.select("fact_types", columns="id", filters={"key": "asset_downtime"}, limit=1)
    if ft_rows:
        ft_id = str(ft_rows[0]["id"])
        maint_rows = client.select(
            "time_series_points",
            columns="entity_id,observed_at",
            filters={"fact_type_id": ft_id, "metadata->>source": "maintenance"},
            order_by="observed_at",
            descending=True,
        )
        for row in maint_rows:
            eid = str(row.get("entity_id") or "")
            if eid and eid not in last_maint_by_asset:
                last_maint_by_asset[eid] = str(row.get("observed_at") or "")

    # 6. Build result: one dict per policy with asset_context embedded.
    result: list[dict[str, Any]] = []
    for policy in tenant_policies:
        asset_id = str(policy.get("asset_id") or "")
        asset_info = tenant_assets.get(asset_id, {})
        result.append({
            "policy_id": str(policy.get("policy_id") or ""),
            "asset_id": asset_id,
            "trigger_type": str(policy.get("trigger_type") or ""),
            "threshold": policy.get("threshold"),
            "interval_days": policy.get("interval_days"),
            "lead_window_days": int(policy.get("lead_window_days") or 0),
            "label": policy.get("label"),
            "tenant_id": tenant_id,
            "asset_context": {
                "latest_meter_value": meter_by_asset.get(asset_id),
                "rental_completion_count": count_by_asset.get(asset_id, 0),
                "last_maintenance_at": last_maint_by_asset.get(asset_id),
                "asset_created_at": asset_info.get("asset_created_at", ""),
            },
        })

    logger.info(
        "pm_scope_enabled_policies",
        extra={"tenant_id": tenant_id, "policy_count": len(result)},
    )
    return result


# ---------------------------------------------------------------------------
# Activity: evaluate a single policy trigger
# ---------------------------------------------------------------------------

@activity.defn
def pm_evaluate_trigger(
    policy: dict[str, Any],
    asset_context: dict[str, Any],
    evaluation_timestamp: str,
) -> dict[str, Any]:
    """Evaluate whether the PM policy is due or pre-due for the given asset.

    Args:
        policy: Dict matching ``PMPolicyConfig`` fields (policy_id, asset_id,
                trigger_type, threshold, interval_days, lead_window_days).
                May also carry ``tenant_id`` which is passed through to the
                result for downstream use.
        asset_context: Asset-level data snapshot containing:
                       - ``latest_meter_value`` (float | None)
                       - ``rental_completion_count`` (int)
                       - ``last_maintenance_at`` (ISO-8601 str | None)
                       - ``asset_created_at`` (ISO-8601 str)
        evaluation_timestamp: ISO-8601 timestamp representing "now" for the run.
                              All time-based calculations use this value, not
                              wall-clock time, to ensure retry-stable results.

    Returns:
        Dict matching ``PMEvaluationResult`` fields plus ``tenant_id``.
    """
    policy_id = str(policy.get("policy_id") or "")
    asset_id = str(policy.get("asset_id") or "")
    trigger_type = str(policy.get("trigger_type") or "")
    threshold = policy.get("threshold")
    interval_days = policy.get("interval_days")
    lead_window_days = int(policy.get("lead_window_days") or 0)
    tenant_id = str(policy.get("tenant_id") or "")

    is_due = False
    is_pre_due = False
    fingerprint = f"pm:{asset_id}:{policy_id}:unknown"
    reason: str | None = None

    eval_now = _parse_iso(evaluation_timestamp) or datetime.now(tz=UTC)

    if trigger_type == PMTriggerType.METER:
        meter_value = asset_context.get("latest_meter_value")
        if meter_value is None:
            # Sparse-data safety: no reading means we cannot confirm due.
            reason = "no meter reading available"
        elif threshold is None:
            reason = "policy has no threshold configured"
        else:
            thr = float(threshold)
            val = float(meter_value)
            fingerprint = _meter_fingerprint(asset_id, policy_id, thr, val)
            if val >= thr:
                is_due = True
                reason = f"meter {val} >= threshold {thr}"
            elif lead_window_days > 0 and val >= (thr - lead_window_days):
                is_pre_due = True
                reason = f"meter {val} within lead window of threshold {thr}"

    elif trigger_type == PMTriggerType.RENTAL_COUNT:
        count = int(asset_context.get("rental_completion_count") or 0)
        if threshold is None:
            reason = "policy has no threshold configured"
        else:
            thr = float(threshold)
            fingerprint = _rental_count_fingerprint(asset_id, policy_id, thr, count)
            if count >= thr:
                is_due = True
                reason = f"rental count {count} >= threshold {thr}"
            elif lead_window_days > 0 and count >= (thr - lead_window_days):
                is_pre_due = True
                reason = f"rental count {count} within lead window of threshold {thr}"

    elif trigger_type == PMTriggerType.TIME_INTERVAL:
        if interval_days is None:
            reason = "policy has no interval_days configured"
        else:
            last_maint_str = asset_context.get("last_maintenance_at")
            created_str = asset_context.get("asset_created_at")
            baseline = _parse_iso(last_maint_str) or _parse_iso(created_str) or eval_now
            fingerprint = _time_interval_fingerprint(
                asset_id, policy_id, int(interval_days), baseline, eval_now
            )
            elapsed = (eval_now - baseline).days
            if elapsed >= interval_days:
                is_due = True
                reason = f"elapsed {elapsed} days >= interval {interval_days} days"
            elif lead_window_days > 0 and elapsed >= (interval_days - lead_window_days):
                is_pre_due = True
                reason = f"elapsed {elapsed} days within lead window of interval {interval_days} days"
    else:
        reason = f"unknown trigger_type '{trigger_type}'"

    result = PMEvaluationResult(
        policy_id=policy_id,
        asset_id=asset_id,
        trigger_type=trigger_type,
        is_due=is_due,
        is_pre_due=is_pre_due,
        fingerprint=fingerprint,
        reason=reason,
    )
    logger.info(
        "pm_evaluate_trigger",
        extra={
            "asset_id": asset_id,
            "policy_id": policy_id,
            "trigger_type": trigger_type,
            "is_due": is_due,
            "is_pre_due": is_pre_due,
            "fingerprint": fingerprint,
        },
    )
    return {
        "policy_id": result.policy_id,
        "asset_id": result.asset_id,
        "trigger_type": result.trigger_type,
        "is_due": result.is_due,
        "is_pre_due": result.is_pre_due,
        "fingerprint": result.fingerprint,
        "reason": result.reason,
        "tenant_id": tenant_id,
    }


# ---------------------------------------------------------------------------
# Activity: list open PM work-order fingerprints (for deduplication)
# ---------------------------------------------------------------------------

@activity.defn
def pm_list_open_wo_fingerprints(tenant_id: str) -> list[str]:
    """Return fingerprints of open preventative maintenance work orders.

    Queries the ``pm_work_orders`` table for rows belonging to *tenant_id*
    with ``status = 'open'``.  The workflow uses this set to skip creating
    duplicate work orders in the same threshold-crossing window.
    """
    client = _get_ops_persistence_client()
    rows = client.select(
        "pm_work_orders",
        columns="fingerprint",
        filters={"tenant_id": tenant_id, "status": "open"},
    )
    fingerprints = sorted({str(row.get("fingerprint")) for row in rows if row.get("fingerprint")})
    logger.info(
        "pm_list_open_wo_fingerprints",
        extra={"tenant_id": tenant_id, "open_count": len(fingerprints)},
    )
    return fingerprints


# ---------------------------------------------------------------------------
# Activity: upsert a preventative maintenance work order
# ---------------------------------------------------------------------------

@activity.defn
def pm_upsert_work_order(
    evaluation: dict[str, Any],
    run_id: str,
) -> dict[str, Any]:
    """Create or confirm a preventative maintenance work order.

    Upserts into ``pm_work_orders`` on ``(tenant_id, fingerprint)``.
    The work-order UUID is derived deterministically from the fingerprint so
    that a retried activity execution produces the same row without creating
    a duplicate.

    Args:
        evaluation: Dict produced by ``pm_evaluate_trigger`` (includes
                    ``policy_id``, ``asset_id``, ``trigger_type``,
                    ``fingerprint``, ``reason``, and ``tenant_id``).
        run_id:     Identifier of the PMEvaluatorWorkflow run.

    Returns:
        Dict with ``work_order_id``, ``asset_id``, ``maintenance_type``,
        ``trigger_type``, ``policy_id``, ``fingerprint``, and ``status``.
    """
    fingerprint = str(evaluation.get("fingerprint") or "")
    asset_id = str(evaluation.get("asset_id") or "")
    policy_id = str(evaluation.get("policy_id") or "")
    trigger_type = str(evaluation.get("trigger_type") or "")
    tenant_id = str(evaluation.get("tenant_id") or "")
    work_order_id = _idempotent_id(f"pm_wo:{fingerprint}")

    if not tenant_id:
        raise ValueError("pm_upsert_work_order: tenant_id is required in evaluation dict")

    client = _get_ops_persistence_client()
    row = client.upsert(
        "pm_work_orders",
        {
            "id": work_order_id,
            "tenant_id": tenant_id,
            "asset_id": asset_id or None,
            "policy_id": policy_id or None,
            "trigger_type": trigger_type,
            "maintenance_type": "preventive",
            "status": "open",
            "fingerprint": fingerprint,
            "run_id": run_id,
            "reason": evaluation.get("reason"),
        },
        on_conflict="tenant_id,fingerprint",
    )
    status = str(row.get("status") or "open")
    logger.info(
        "pm_upsert_work_order",
        extra={
            "work_order_id": work_order_id,
            "asset_id": asset_id,
            "policy_id": policy_id,
            "trigger_type": trigger_type,
            "fingerprint": fingerprint,
            "run_id": run_id,
            "status": status,
        },
    )
    return {
        "work_order_id": work_order_id,
        "asset_id": asset_id,
        "maintenance_type": "preventive",
        "trigger_type": trigger_type,
        "policy_id": policy_id,
        "fingerprint": fingerprint,
        "status": status,
    }


# ---------------------------------------------------------------------------
# Activity: record rental completion fact (drives rental-count PM trigger)
# ---------------------------------------------------------------------------

@activity.defn
def pm_record_rental_completion(asset_id: str, contract_line_id: str) -> bool:
    """Append an ``asset_rental_completion`` time-series fact for *asset_id*.

    Called by the rental workflow after a contract line is successfully
    returned.  Incrementing this fact counter is what makes the
    ``rental_count`` PM trigger family functional: ``v_asset_rental_completion_count``
    aggregates these rows, and ``pm_scope_enabled_policies`` reads that view
    to supply the count to ``pm_evaluate_trigger``.

    The TSP row uses ``source_id = contract_line_id`` as its deduplication key.
    The DB trigger ``emit_rental_completion_trg`` (on entity_versions) and this
    activity share the same key so the fact-type-specific partial unique index
    ``uq_tsp_rc_source`` on ``(entity_id, source_id)`` (scoped to the
    ``asset_rental_completion`` fact type) ensures exactly one row is written
    per return event regardless of which path fires first.

    Args:
        asset_id:         UUID of the returned asset entity.
        contract_line_id: UUID of the contract line entity being closed.

    Returns:
        ``True`` on success, ``False`` if the ``asset_rental_completion``
        fact type is not found in the database (schema mismatch warning).
    """
    client = _get_ops_persistence_client()

    ft_rows = client.select(
        "fact_types",
        columns="id",
        filters={"key": "asset_rental_completion"},
        limit=1,
    )
    if not ft_rows:
        logger.warning(
            "pm_record_rental_completion: fact_type 'asset_rental_completion' not found",
            extra={"asset_id": asset_id, "contract_line_id": contract_line_id},
        )
        return False

    fact_type_id = str(ft_rows[0]["id"])
    # source_id = contract_line_id is the cross-path deduplication key.
    # Both this activity (Temporal path) and the DB trigger on entity_versions
    # (direct RPC / frontend path) use source_id so the fact-type-specific
    # partial unique index uq_tsp_rc_source guarantees exactly one TSP row
    # per return event.
    client.upsert(
        "time_series_points",
        {
            "entity_id": asset_id,
            "fact_type_id": fact_type_id,
            "observed_at": datetime.now(tz=UTC).isoformat(),
            "data_payload": {"count": 1},
            "source_id": contract_line_id,
        },
        on_conflict="entity_id,source_id",
    )
    logger.info(
        "pm_record_rental_completion",
        extra={"asset_id": asset_id, "contract_line_id": contract_line_id},
    )
    return True
