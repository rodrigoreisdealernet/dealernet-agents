from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_collections

_DEFAULT_MAX_FINDINGS_PER_RUN = 50

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)

_WORKFLOW_KEY = "collections-prioritizer"


@dataclass
class CollectionsPrioritizerWorkflowInput:
    tenant_id: str
    run_window_start: str | None = None
    run_window_end: str | None = None


@workflow.defn
class CollectionsPrioritizerWorkflow:
    @workflow.run
    async def run(self, inp: CollectionsPrioritizerWorkflowInput) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_customers_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "deduped_findings": 0,
            "remaining_findings_count": 0,
            "auto_apply": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_collections.ops_create_workflow_run,
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
                ops_collections.ops_load_agent_config,
                args=[inp.tenant_id, _WORKFLOW_KEY],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["auto_apply"] = False
            thresholds = config.get("thresholds") or {}
            bounds = config.get("bounds") or {}

            scoped_customers = await workflow.execute_activity(
                ops_collections.ops_scope_collections,
                args=[inp.tenant_id, {"thresholds": thresholds, "max_customers": bounds.get("max_customers")}],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_customers_scoped"] = len(scoped_customers)
            if not scoped_customers:
                return {"run_id": run_id, **summary}

            assess_tasks = [
                workflow.execute_activity(
                    ops_collections.ops_collections_assess,
                    args=[customer_payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for customer_payload in scoped_customers
            ]
            assessed = await asyncio.gather(*assess_tasks) if assess_tasks else []

            surfaced: list[dict[str, Any]] = []
            for idx, assessment in enumerate(assessed):
                customer = scoped_customers[idx]
                surfaced.append(
                    {
                        "customer_id": str(customer.get("customer_id") or ""),
                        "tenant_id": inp.tenant_id,
                        "agent_key": _WORKFLOW_KEY,
                        "workflow_id": f"ops-collections-prioritizer:{run_id}",
                        "finding_type": "collections_priority",
                        "severity": str(customer.get("severity") or "medium"),
                        "total_exposure": float(customer.get("total_exposure") or 0.0),
                        "days_overdue": int(customer.get("max_days_overdue") or customer.get("days_overdue") or 0),
                        "predicted_breach_at": customer.get("predicted_breach_at"),
                        "days_to_breach": customer.get("days_to_breach"),
                        "recommended_action": str(assessment.get("recommended_action") or "monitor"),
                        "next_step_note": str(assessment.get("next_step_note") or ""),
                        "evidence": list(assessment.get("evidence") or []),
                        "confidence": float(assessment.get("confidence") or 0.0),
                        "rationale": str(assessment.get("rationale") or ""),
                        "fingerprint": str(customer.get("fingerprint") or ""),
                    }
                )
            surfaced.sort(
                key=lambda item: (
                    -float(item.get("total_exposure") or 0.0),
                    str(item.get("fingerprint") or ""),
                )
            )

            existing_fingerprints = await workflow.execute_activity(
                ops_collections.ops_list_open_finding_fingerprints,
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
                max_findings = int((config.get("bounds") or {}).get("max_findings_per_run", _DEFAULT_MAX_FINDINGS_PER_RUN))
            except (TypeError, ValueError):
                max_findings = _DEFAULT_MAX_FINDINGS_PER_RUN
            max_findings = max(0, max_findings)
            bounded_findings = deduped[:max_findings]
            summary["remaining_findings_count"] = max(0, len(deduped) - len(bounded_findings))
            summary["processed_findings"] = len(bounded_findings)

            for finding in bounded_findings:
                await workflow.execute_activity(
                    ops_collections.ops_record_finding,
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
                    ops_collections.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
