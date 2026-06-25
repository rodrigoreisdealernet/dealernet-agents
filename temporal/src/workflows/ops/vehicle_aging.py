from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_vehicle_aging

_DEFAULT_MAX_FINDINGS_PER_RUN = 50

# RetryPolicy constants tuned per activity class (ADR-0003), mirroring revrec/fleet.
_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
# Must exceed the activity's 15 s heartbeat interval.
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)

_WORKFLOW_KEY = "vehicle-aging-analyst"


@dataclass
class VehicleAgingWorkflowInput:
    tenant_id: str
    run_window_start: str | None = None
    run_window_end: str | None = None


@workflow.defn
class VehicleAgingWorkflow:
    """Fire-and-forget vehicle stock-aging analyst.

    scope (deterministic) -> assess (LLM, parallel) -> dedupe -> record findings
    as ``pending_approval``.  Human approval happens out of band via the ops
    findings decision API; the workflow never blocks on approval.
    """

    @workflow.run
    async def run(self, inp: VehicleAgingWorkflowInput) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_vehicles_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "deduped_findings": 0,
            "remaining_findings_count": 0,
            "auto_apply": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_vehicle_aging.ops_create_workflow_run,
                args=[
                    _WORKFLOW_KEY,
                    inp.tenant_id,
                    {"run_window_start": inp.run_window_start, "run_window_end": inp.run_window_end},
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_vehicle_aging.ops_load_agent_config,
                args=[inp.tenant_id, _WORKFLOW_KEY],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            # v1 invariant: never auto-apply; all dispositions require human approval.
            summary["auto_apply"] = False
            thresholds = config.get("thresholds") or {}

            scoped_vehicles = await workflow.execute_activity(
                ops_vehicle_aging.ops_scope_vehicle_aging,
                args=[inp.tenant_id, {"thresholds": thresholds}],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_vehicles_scoped"] = len(scoped_vehicles)
            if not scoped_vehicles:
                return {"run_id": run_id, **summary}

            assess_tasks = [
                workflow.execute_activity(
                    ops_vehicle_aging.ops_vehicle_aging_assess,
                    args=[vehicle_payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for vehicle_payload in scoped_vehicles
            ]
            assessed = await asyncio.gather(*assess_tasks) if assess_tasks else []

            surfaced: list[dict[str, Any]] = []
            for idx, assessment in enumerate(assessed):
                vehicle = scoped_vehicles[idx]
                surfaced.append(
                    {
                        "vehicle_id": str(vehicle.get("vehicle_id") or ""),
                        "tenant_id": inp.tenant_id,
                        "agent_key": _WORKFLOW_KEY,
                        "workflow_id": f"ops-vehicle-aging:{run_id}",
                        "finding_type": "stock_aging_90d",
                        "severity": str(vehicle.get("severity") or "medium"),
                        "days_in_stock": int(vehicle.get("days_in_stock") or 0),
                        "aging_bucket": str(vehicle.get("aging_bucket") or "approaching"),
                        "brand": vehicle.get("brand"),
                        "model": vehicle.get("model"),
                        "model_year": vehicle.get("model_year"),
                        "store": vehicle.get("store"),
                        "condition": vehicle.get("condition"),
                        "cost": vehicle.get("cost"),
                        "sale_price": vehicle.get("sale_price"),
                        "floor_plan_cost": vehicle.get("floor_plan_cost"),
                        "estimated_exposure": vehicle.get("estimated_exposure"),
                        "recommended_action": str(assessment.get("recommended_action") or "monitor"),
                        "evidence": list(assessment.get("evidence") or []),
                        "confidence": float(assessment.get("confidence") or 0.0),
                        "rationale": str(assessment.get("rationale") or ""),
                        "fingerprint": str(vehicle.get("fingerprint") or ""),
                    }
                )
            surfaced.sort(
                key=lambda item: (
                    -int(item.get("days_in_stock") or 0),
                    str(item.get("fingerprint") or ""),
                )
            )

            existing_fingerprints = await workflow.execute_activity(
                ops_vehicle_aging.ops_list_open_finding_fingerprints,
                args=[inp.tenant_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            seen = set(existing_fingerprints)
            deduped: list[dict[str, Any]] = []
            for finding in surfaced:
                fingerprint = str(finding["fingerprint"])
                if fingerprint in seen:
                    summary["deduped_findings"] += 1
                    continue
                seen.add(fingerprint)
                deduped.append(finding)

            try:
                max_findings = int(
                    (config.get("bounds") or {}).get("max_findings_per_run", _DEFAULT_MAX_FINDINGS_PER_RUN)
                )
            except (TypeError, ValueError):
                max_findings = _DEFAULT_MAX_FINDINGS_PER_RUN
            max_findings = max(0, max_findings)
            bounded_findings = deduped[:max_findings]
            summary["remaining_findings_count"] = max(0, len(deduped) - len(bounded_findings))
            summary["processed_findings"] = len(bounded_findings)

            for finding in bounded_findings:
                await workflow.execute_activity(
                    ops_vehicle_aging.ops_record_finding,
                    args=[finding, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_findings"] += 1

            return {"run_id": run_id, **summary}
        except Exception:
            summary["status"] = "failed"
            raise
        finally:
            if run_id:
                await workflow.execute_activity(
                    ops_vehicle_aging.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
