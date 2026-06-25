from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_fleet

_DEFAULT_MAX_FINDINGS_PER_RUN = 50

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)
_EXECUTIVE_OPERATING_MODEL_TAGS = [
    "operations-executive:t1",
    "operations-executive:t3",
    "operations-executive:t4",
    "operations-executive:t7",
]


def _signal_key_prefix(asset_id: str, finding_type: str) -> str:
    return f"{asset_id}:{finding_type}:"


def _decision_path(
    disposition: str,
    *,
    utilization_pct: float,
    benchmark_gap_pct: float | None,
    stale_signals: list[str],
) -> str:
    if stale_signals:
        return "regional_follow_up"
    normalized = disposition.lower()
    if normalized == "transfer":
        return "transfer"
    if normalized == "re_rent_out":
        return "re_rent"
    if normalized == "sell":
        return "buy"
    if normalized == "replace":
        return "buy"
    if benchmark_gap_pct is not None and benchmark_gap_pct <= -15.0:
        return "transfer"
    if utilization_pct <= 20.0:
        return "re_rent"
    return "regional_follow_up"


@dataclass
class FleetUtilizationWorkflowInput:
    tenant_id: str
    run_window_start: str | None = None
    run_window_end: str | None = None
    approval_timeout_seconds: int = 300


@dataclass
class ApproveFleetFindingSignal:
    asset_id: str
    finding_type: str
    approver_id: str
    fingerprint: str | None = None
    approver_name: str | None = None
    note: str | None = None


@dataclass
class RejectFleetFindingSignal:
    asset_id: str
    finding_type: str
    approver_id: str
    fingerprint: str | None = None
    approver_name: str | None = None
    note: str | None = None


@workflow.defn
class FleetUtilizationWorkflow:
    def __init__(self) -> None:
        self._decisions: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: FleetUtilizationWorkflowInput) -> dict[str, Any]:
        workflow_key = "fleet-auditor"
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_assets_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "deduped_findings": 0,
            "approved_findings": 0,
            "rejected_findings": 0,
            "timed_out_findings": 0,
            "dispatch_plan_writes": 0,
            "remaining_findings_count": 0,
            "no_op": False,
            "auto_apply": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_fleet.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {"run_window_start": inp.run_window_start, "run_window_end": inp.run_window_end},
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_fleet.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["auto_apply"] = False

            thresholds = config.get("thresholds") or {}
            utilization_threshold = float(thresholds.get("utilization_pct_threshold", 35.0))
            scoped_assets = await workflow.execute_activity(
                ops_fleet.ops_scope_fleet_assets,
                args=[
                    inp.tenant_id,
                    {
                        "run_window_start": inp.run_window_start,
                        "run_window_end": inp.run_window_end,
                        "utilization_threshold": utilization_threshold,
                        "thresholds": thresholds,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_assets_scoped"] = len(scoped_assets)
            if not scoped_assets:
                summary["status"] = "no_op"
                summary["no_op"] = True
                return {"run_id": run_id, **summary}

            analyze_tasks = [
                workflow.execute_activity(
                    ops_fleet.ops_fleet_assess,
                    args=[asset_payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for asset_payload in scoped_assets
            ]
            assessed = await asyncio.gather(*analyze_tasks) if analyze_tasks else []

            surfaced: list[dict[str, Any]] = []
            for idx, recommendation in enumerate(assessed):
                asset_payload = scoped_assets[idx]
                asset_id = str(recommendation.get("asset_id") or asset_payload.get("asset_id") or "")
                disposition = str(recommendation.get("disposition") or "keep")
                utilization_pct = float(recommendation.get("utilization_pct") or 0.0)
                benchmark_utilization_pct = asset_payload.get("benchmark_utilization_pct")
                try:
                    benchmark_utilization_pct = (
                        float(benchmark_utilization_pct) if benchmark_utilization_pct is not None else None
                    )
                except (TypeError, ValueError):
                    benchmark_utilization_pct = None
                benchmark_gap_pct = (
                    utilization_pct - benchmark_utilization_pct
                    if benchmark_utilization_pct is not None
                    else None
                )
                stale_signals = list(asset_payload.get("stale_signals") or [])
                source_gaps = list(asset_payload.get("source_gaps") or [])
                source_gap_state = str(asset_payload.get("source_gap_state") or "ok")
                demand_gap_state = str(asset_payload.get("demand_gap_state") or "ok")
                snapshot_value = asset_payload.get("demand_gap_snapshot")
                demand_gap_snapshot = (
                    dict(snapshot_value or {})
                    if isinstance(snapshot_value, dict)
                    else {}
                )
                threshold_flags = list(asset_payload.get("threshold_flags") or [])
                decision_path = _decision_path(
                    disposition,
                    utilization_pct=utilization_pct,
                    benchmark_gap_pct=benchmark_gap_pct,
                    stale_signals=stale_signals,
                )
                demand_gap_blocks_recommendation = demand_gap_state != "ok"
                recommendation_blocked = source_gap_state == "blocked" or demand_gap_blocks_recommendation
                if recommendation_blocked:
                    decision_path = "regional_follow_up"
                target_branch_id = (
                    recommendation.get("target_branch_id")
                    if demand_gap_state == "ok"
                    else None
                )
                branch_id = str(asset_payload.get("home_branch_id") or recommendation.get("home_branch_id") or "")
                category_id = str(asset_payload.get("category_id") or "")
                fingerprint = (
                    f"cross_branch_utilization:{branch_id}:{category_id}:"
                    f"cross_branch_utilization_outlier:{decision_path}"
                )
                urgency_score = max(
                    0.0,
                    (benchmark_utilization_pct - utilization_pct) if benchmark_utilization_pct is not None else (40.0 - utilization_pct),
                ) + (8.0 if stale_signals else 0.0)
                assumptions: list[str] = [
                    "Human executive approval is required before transfer, re-rent, buy, or branch corrective action."
                ]
                if benchmark_utilization_pct is None:
                    assumptions.append("Benchmark utilization signal unavailable; urgency ranking uses low-utilization fallback.")
                else:
                    assumptions.append("Benchmark gap uses utilization_pct - benchmark_utilization_pct from current scoped signals.")
                if threshold_flags:
                    assumptions.append(f"Candidate surfaced by tenant thresholds: {', '.join(sorted(set(threshold_flags)))}.")
                if source_gaps:
                    assumptions.append(f"Source gaps detected: {', '.join(sorted(set(source_gaps)))}.")
                if demand_gap_state != "ok":
                    assumptions.append("Demand-gap sourcing evidence is incomplete; manual evidence required before branch action.")
                base_confidence = float(recommendation.get("confidence") or 0.0)
                confidence = (
                    0.0
                    if source_gap_state == "blocked"
                    else min(base_confidence, 0.45)
                    if source_gap_state == "degraded"
                    else base_confidence
                )
                surfaced.append(
                    {
                        "asset_id": asset_id,
                        "home_branch_id": branch_id,
                        "category_id": category_id,
                        "target_branch_id": target_branch_id,
                        "finding_type": "cross_branch_utilization_outlier",
                        "severity": "critical" if utilization_pct < 15 else "high" if utilization_pct < 25 else "medium",
                        "disposition": disposition,
                        "recommendation_path": decision_path,
                        "utilization_pct": utilization_pct,
                        "benchmark_utilization_pct": benchmark_utilization_pct,
                        "benchmark_gap_pct": benchmark_gap_pct,
                        "urgency_score": urgency_score,
                        "estimated_monthly_revenue_uplift": float(
                            recommendation.get("estimated_monthly_revenue_uplift") or 0.0
                        ),
                        "evidence": [
                            *list(recommendation.get("evidence") or []),
                            *list(asset_payload.get("benchmark_evidence") or []),
                            *list(asset_payload.get("kpi_evidence") or []),
                            *list(asset_payload.get("telematics_evidence") or []),
                            *list(asset_payload.get("revenue_evidence") or []),
                            *list(asset_payload.get("maintenance_evidence") or []),
                            *list(asset_payload.get("downtime_evidence") or []),
                            *list(asset_payload.get("market_evidence") or []),
                            *list(asset_payload.get("demand_gap_evidence") or []),
                            *list(demand_gap_snapshot.get("manual_evidence") or []),
                            *stale_signals,
                            *source_gaps,
                        ],
                        "stale_signals": stale_signals,
                        "source_gaps": source_gaps,
                        "source_gap_state": source_gap_state,
                        "demand_gap_state": demand_gap_state,
                        "demand_gap_snapshot": demand_gap_snapshot,
                        "recommendation_blocked": recommendation_blocked,
                        "threshold_flags": threshold_flags,
                        "lifecycle_snapshot": asset_payload.get("lifecycle_snapshot"),
                        "assumptions": assumptions,
                        "operating_model_tags": list(_EXECUTIVE_OPERATING_MODEL_TAGS),
                        "confidence": confidence,
                        "rationale": str(recommendation.get("rationale") or ""),
                        "fingerprint": fingerprint,
                        "tenant_id": inp.tenant_id,
                        "agent_key": workflow_key,
                        "workflow_id": f"ops-fleet:{run_id}",
                    }
                )
            surfaced.sort(
                key=lambda item: (
                    -float(item.get("urgency_score") or 0.0),
                    float(item.get("utilization_pct") or 0.0),
                    str(item.get("fingerprint") or ""),
                )
            )

            existing_fingerprints = await workflow.execute_activity(
                ops_fleet.ops_list_open_finding_fingerprints,
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
            if not bounded_findings:
                summary["status"] = "no_op"
                summary["no_op"] = True

            for finding in bounded_findings:
                await workflow.execute_activity(
                    ops_fleet.ops_record_finding,
                    args=[finding, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_findings"] += 1
                requires_approval = await workflow.execute_activity(
                    ops_fleet.ops_requires_transfer_approval,
                    args=[finding, config],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                if not requires_approval:
                    continue
                dispatch_proposal = await workflow.execute_activity(
                    ops_fleet.ops_transfer_request_payload,
                    args=[finding, None],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                fingerprint = str(finding["fingerprint"])
                signal_key_prefix = _signal_key_prefix(
                    str(finding.get("asset_id") or ""),
                    str(finding.get("finding_type") or ""),
                )
                try:
                    await workflow.wait_condition(
                        lambda fingerprint=fingerprint, signal_key_prefix=signal_key_prefix: fingerprint in self._decisions
                        or any(key.startswith(signal_key_prefix) for key in self._decisions),
                        timeout=workflow.timedelta(seconds=inp.approval_timeout_seconds),
                    )
                    decision_key = (
                        fingerprint
                        if fingerprint in self._decisions
                        else next((key for key in self._decisions if key.startswith(signal_key_prefix)), None)
                    )
                    if decision_key is None:
                        raise TimeoutError("decision missing after approval signal")
                    decision = self._decisions.pop(decision_key)
                except TimeoutError:
                    summary["timed_out_findings"] += 1
                    await workflow.execute_activity(
                        ops_fleet.ops_record_finding_disposition,
                        args=[
                            _with_dispatch_audit_evidence(
                                finding,
                                dispatch_proposal=dispatch_proposal,
                                dispatch_outcome="timed_out",
                                approved_dispatch_plan=None,
                            ),
                            "timed_out",
                            run_id,
                            None,
                        ],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                    continue
                if decision["decision"] == "approved":
                    summary["approved_findings"] += 1
                    approved_handoff = await workflow.execute_activity(
                        ops_fleet.ops_draft_disposition_handoff,
                        args=[finding, decision["approver"]],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                    summary["dispatch_plan_writes"] += 1
                    await workflow.execute_activity(
                        ops_fleet.ops_record_finding_disposition,
                        args=[
                            _with_dispatch_audit_evidence(
                                finding,
                                dispatch_proposal=dispatch_proposal,
                                dispatch_outcome="approved",
                                approved_dispatch_plan=approved_handoff,
                            ),
                            "approved",
                            run_id,
                            decision["approver"],
                        ],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                else:
                    summary["rejected_findings"] += 1
                    await workflow.execute_activity(
                        ops_fleet.ops_record_finding_disposition,
                        args=[
                            _with_dispatch_audit_evidence(
                                finding,
                                dispatch_proposal=dispatch_proposal,
                                dispatch_outcome="rejected",
                                approved_dispatch_plan=None,
                            ),
                            "rejected",
                            run_id,
                            decision["approver"],
                        ],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
            return {"run_id": run_id, **summary}
        except Exception:
            summary["status"] = "failed"
            raise
        finally:
            if run_id:
                await workflow.execute_activity(
                    ops_fleet.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def approve_finding(self, sig: ApproveFleetFindingSignal) -> None:
        decision_key = str(sig.fingerprint or f"{sig.asset_id}:{sig.finding_type}:")
        self._decisions[decision_key] = {
            "decision": "approved",
            "approver": {
                "approver_id": sig.approver_id,
                "approver_name": sig.approver_name,
                "note": sig.note,
            },
        }

    @workflow.signal
    async def reject_finding(self, sig: RejectFleetFindingSignal) -> None:
        decision_key = str(sig.fingerprint or f"{sig.asset_id}:{sig.finding_type}:")
        self._decisions[decision_key] = {
            "decision": "rejected",
            "approver": {
                "approver_id": sig.approver_id,
                "approver_name": sig.approver_name,
                "note": sig.note,
            },
        }


def _with_dispatch_audit_evidence(
    finding: dict[str, Any],
    *,
    dispatch_proposal: dict[str, Any],
    dispatch_outcome: str,
    approved_dispatch_plan: dict[str, Any] | None,
) -> dict[str, Any]:
    evidence = list(finding.get("evidence") or [])
    evidence.append(
        {
            "dispatch_proposal": dispatch_proposal,
            "dispatch_outcome": dispatch_outcome,
            "approved_dispatch_plan": approved_dispatch_plan,
        }
    )
    return {
        **finding,
        "evidence": evidence,
        "dispatch_proposal": dispatch_proposal,
        "dispatch_outcome": dispatch_outcome,
        "approved_dispatch_plan": approved_dispatch_plan,
    }
