from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_parts_inventory

_DEFAULT_MAX_FINDINGS_PER_RUN = 50

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)

_WORKFLOW_KEY = "parts-inventory-advisor"


@dataclass
class PartsInventoryWorkflowInput:
    tenant_id: str
    run_window_start: str | None = None
    run_window_end: str | None = None


@workflow.defn
class PartsInventoryWorkflow:
    @workflow.run
    async def run(self, inp: PartsInventoryWorkflowInput) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_parts_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "deduped_findings": 0,
            "remaining_findings_count": 0,
            "auto_apply": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_parts_inventory.ops_create_workflow_run,
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
                ops_parts_inventory.ops_load_agent_config,
                args=[inp.tenant_id, _WORKFLOW_KEY],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["auto_apply"] = False
            thresholds = config.get("thresholds") or {}
            bounds = config.get("bounds") or {}
            scope_context = {"thresholds": thresholds, "max_parts": bounds.get("max_parts")}

            replenish_parts = await workflow.execute_activity(
                ops_parts_inventory.ops_scope_parts_replenish,
                args=[inp.tenant_id, scope_context],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            dead_stock_parts = await workflow.execute_activity(
                ops_parts_inventory.ops_scope_parts_dead_stock,
                args=[inp.tenant_id, scope_context],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            scoped_parts = [*replenish_parts, *dead_stock_parts]
            summary["total_parts_scoped"] = len(scoped_parts)
            if not scoped_parts:
                return {"run_id": run_id, **summary}

            assess_tasks = [
                workflow.execute_activity(
                    ops_parts_inventory.ops_parts_inventory_assess,
                    args=[part_payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for part_payload in scoped_parts
            ]
            assessed = await asyncio.gather(*assess_tasks) if assess_tasks else []

            surfaced: list[dict[str, Any]] = []
            for idx, assessment in enumerate(assessed):
                part = scoped_parts[idx]
                surfaced.append(
                    {
                        "part_id": str(part.get("part_id") or ""),
                        "tenant_id": inp.tenant_id,
                        "agent_key": _WORKFLOW_KEY,
                        "workflow_id": f"ops-parts-inventory:{run_id}",
                        "finding_type": str(part.get("finding_type") or "replenish_now"),
                        "severity": str(part.get("severity") or "medium"),
                        "quantity_suggested": int(part.get("quantity_suggested") or 0),
                        "value_at_risk": float(part.get("value_at_risk") or 0.0),
                        "part_number": part.get("part_number"),
                        "manufacturer": part.get("manufacturer"),
                        "stock_status": part.get("stock_status"),
                        "quantity_in_stock": part.get("quantity_in_stock"),
                        "reorder_point": part.get("reorder_point"),
                        "stock_value": part.get("stock_value"),
                        "velocity": part.get("velocity"),
                        "recommended_action": str(assessment.get("recommended_action") or "monitor"),
                        "evidence": list(assessment.get("evidence") or []),
                        "confidence": float(assessment.get("confidence") or 0.0),
                        "rationale": str(assessment.get("rationale") or ""),
                        "fingerprint": str(part.get("fingerprint") or ""),
                        "priority": float(part.get("priority") or 0.0),
                    }
                )
            surfaced.sort(
                key=lambda item: (
                    -float(item.get("priority") or 0.0),
                    str(item.get("fingerprint") or ""),
                )
            )

            existing_fingerprints = await workflow.execute_activity(
                ops_parts_inventory.ops_list_open_finding_fingerprints,
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
                    ops_parts_inventory.ops_record_finding,
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
                    ops_parts_inventory.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
