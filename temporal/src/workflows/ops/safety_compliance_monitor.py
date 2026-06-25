"""Safety & compliance monitor workflow."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_safety_compliance_monitor

_DEFAULT_MAX_FINDINGS_PER_RUN = 100

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)


@dataclass
class SafetyComplianceMonitorWorkflowInput:
    tenant_id: str
    trigger: str = "daily"
    run_date: str | None = None
    branch_id: str | None = None
    checkout_subject_ids: list[str] = field(default_factory=list)


def _priority_rank(item: dict[str, Any]) -> int:
    return {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(str(item.get("priority") or "low"), 3)


@workflow.defn
class SafetyComplianceMonitorWorkflow:
    """Evaluates safety/compliance subjects and records canonical findings."""

    @workflow.run
    async def run(self, inp: SafetyComplianceMonitorWorkflowInput) -> dict[str, Any]:
        workflow_key = "safety-compliance-monitor"
        trigger = (inp.trigger or "daily").strip().lower()
        summary: dict[str, Any] = {
            "status": "succeeded",
            "trigger": trigger,
            "total_subjects_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "deduped_findings": 0,
            "superseded_findings": 0,
            "source_gap_findings": 0,
            "no_op": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_safety_compliance_monitor.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {
                        "trigger": trigger,
                        "run_date": inp.run_date,
                        "branch_id": inp.branch_id,
                        "checkout_subject_ids": list(inp.checkout_subject_ids or []),
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_safety_compliance_monitor.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            scoped: list[dict[str, Any]] = await workflow.execute_activity(
                ops_safety_compliance_monitor.ops_safety_compliance_scope,
                args=[inp.tenant_id, trigger, inp.run_date, inp.branch_id, list(inp.checkout_subject_ids or [])],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_subjects_scoped"] = len(scoped)
            summary["source_gap_findings"] = sum(1 for i in scoped if bool(i.get("source_gap")))
            if not scoped:
                summary["status"] = "no_op"
                summary["no_op"] = True
                return {"run_id": run_id, **summary}

            existing_fingerprints: list[str] = await workflow.execute_activity(
                ops_safety_compliance_monitor.ops_list_open_finding_fingerprints,
                args=[inp.tenant_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            seen = set(existing_fingerprints)

            try:
                max_findings = int(
                    (config.get("bounds") or {}).get("max_findings_per_run", _DEFAULT_MAX_FINDINGS_PER_RUN)
                )
            except (TypeError, ValueError):
                max_findings = _DEFAULT_MAX_FINDINGS_PER_RUN
            max_findings = max(0, max_findings)

            assess_tasks = [
                workflow.execute_activity(
                    ops_safety_compliance_monitor.ops_safety_compliance_assess,
                    args=[item_payload, config],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                for item_payload in scoped[:max_findings]
            ]
            assessed: list[dict[str, Any]] = await asyncio.gather(*assess_tasks) if assess_tasks else []
            summary["processed_findings"] = len(assessed)

            # Collapse to one canonical active thread per subject_key (highest priority wins).
            canonical_by_subject: dict[str, dict[str, Any]] = {}
            for item in assessed:
                key = str(item.get("subject_key") or "")
                if not key:
                    continue
                existing = canonical_by_subject.get(key)
                if existing is None or _priority_rank(item) < _priority_rank(existing):
                    if existing is not None:
                        summary["superseded_findings"] += 1
                    canonical_by_subject[key] = item
                else:
                    summary["superseded_findings"] += 1

            canonical_findings = sorted(canonical_by_subject.values(), key=_priority_rank)
            for finding in canonical_findings:
                fingerprint = str(finding.get("fingerprint") or "")
                if not fingerprint:
                    continue
                finding["agent_key"] = workflow_key
                finding["workflow_id"] = f"{workflow_key}:{run_id}"
                if fingerprint in seen:
                    summary["deduped_findings"] += 1
                    continue
                seen.add(fingerprint)
                await workflow.execute_activity(
                    ops_safety_compliance_monitor.ops_record_finding,
                    args=[finding, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_findings"] += 1

            if summary["recorded_findings"] == 0 and summary["deduped_findings"] >= len(canonical_findings):
                summary["no_op"] = True
            return {"run_id": run_id, **summary}

        except Exception:
            summary["status"] = "failed"
            raise
        finally:
            if run_id:
                await workflow.execute_activity(
                    ops_safety_compliance_monitor.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
