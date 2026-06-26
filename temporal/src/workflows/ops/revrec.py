from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_revrec

_DEFAULT_MAX_FINDINGS_PER_RUN = 50

# RetryPolicy constants tuned per activity class (ADR-0003).
_NON_RETRYABLE = ["ValueError", "ApplicationError"]
# Standard DB read/write activities: 3 attempts for transient Supabase errors.
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
# Money-moving creates (draft adjustments): tight 2-attempt cap to avoid duplicates.
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
# AI/HTTP activity: 2 attempts maximum; heartbeat_timeout enforced separately on
# the execute_activity call so a stalled LLM/HTTP call is detected quickly.
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
# Heartbeat timeout for the AI analyst activity (must be > heartbeat interval in
# the activity implementation, which pulses every 15 s).
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)


@dataclass
class RevenueRecognitionWorkflowInput:
    tenant_id: str
    run_window_start: str | None = None
    run_window_end: str | None = None
    approval_timeout_seconds: int = 300
    locale: str = "pt-BR"


@dataclass
class ApproveFindingSignal:
    contract_id: str
    line_item_id: str
    finding_type: str
    approver_id: str
    approver_name: str | None = None
    note: str | None = None


@dataclass
class RejectFindingSignal:
    contract_id: str
    line_item_id: str
    finding_type: str
    approver_id: str
    approver_name: str | None = None
    note: str | None = None


@workflow.defn
class RevenueRecognitionWorkflow:
    def __init__(self) -> None:
        self._decisions: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: RevenueRecognitionWorkflowInput) -> dict[str, Any]:
        workflow_key = "revrec-analyst"
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_contracts_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "deduped_findings": 0,
            "approved_findings": 0,
            "rejected_findings": 0,
            "timed_out_findings": 0,
            "draft_adjustments_created": 0,
            "remaining_findings_count": 0,
            "auto_apply": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_revrec.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {
                        "run_window_start": inp.run_window_start,
                        "run_window_end": inp.run_window_end,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_revrec.ops_load_agent_config,
                args=[inp.tenant_id, "revrec-analyst"],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            requested_auto_apply = bool(config.get("auto_apply", False))
            # v1 invariant: never auto-apply money-moving changes.
            summary["auto_apply"] = False

            scoped_contracts = await workflow.execute_activity(
                ops_revrec.ops_scope_revrec_contracts,
                args=[
                    inp.tenant_id,
                    {
                        "run_window_start": inp.run_window_start,
                        "run_window_end": inp.run_window_end,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_contracts_scoped"] = len(scoped_contracts)

            analyze_tasks = []
            for contract_payload in scoped_contracts:
                prompt_variables = {
                    "tenant_id": inp.tenant_id,
                    # Fallback until tenant profile lookup is wired for display names.
                    "tenant_name": inp.tenant_id,
                    "run_window_start": inp.run_window_start or "",
                    "run_window_end": inp.run_window_end or "",
                    "cycle": inp.run_window_start or "",
                    "contract_id": str(contract_payload.get("contract_id") or ""),
                    "evidence_json": json.dumps(contract_payload, sort_keys=True),
                }
                analyze_tasks.append(
                    workflow.execute_activity(
                        ops_revrec.ops_revrec_analyze,
                        args=[
                            contract_payload,
                            {
                                **config,
                                "system_prompt": ops_revrec.interpolate_prompt_template(
                                    str(config.get("system_prompt") or ""),
                                    prompt_variables,
                                ),
                                "user_prompt_template": ops_revrec.interpolate_prompt_template(
                                    str(config.get("user_prompt_template") or ""),
                                    prompt_variables,
                                ),
                                "locale": inp.locale,
                            },
                        ],
                        start_to_close_timeout=workflow.timedelta(minutes=2),
                        heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                        retry_policy=_AI_RETRY,
                    )
                )
            analyzed = await asyncio.gather(*analyze_tasks) if analyze_tasks else []

            surfaced: list[dict[str, Any]] = []
            for idx, result in enumerate(analyzed):
                contract_payload = scoped_contracts[idx]
                contract_id = str(result.get("contract_id") or contract_payload.get("contract_id", ""))
                for finding in result.get("findings") or []:
                    line_item_id = str(finding.get("line_item_id", ""))
                    finding_type = str(finding.get("finding_type", ""))
                    fingerprint = f"{contract_id}:{line_item_id}:{finding_type}"
                    surfaced.append(
                        {
                            **finding,
                            "contract_id": contract_id,
                            "line_item_id": line_item_id,
                            "fingerprint": fingerprint,
                        }
                    )

            existing_fingerprints = await workflow.execute_activity(
                ops_revrec.ops_list_open_finding_fingerprints,
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
                    (config.get("bounds") or {}).get(
                        "max_findings_per_run",
                        _DEFAULT_MAX_FINDINGS_PER_RUN,
                    )
                )
            except (TypeError, ValueError):
                max_findings = _DEFAULT_MAX_FINDINGS_PER_RUN
            max_findings = max(0, max_findings)
            bounded_findings = deduped[:max_findings]
            summary["remaining_findings_count"] = max(0, len(deduped) - len(bounded_findings))
            if summary["remaining_findings_count"] > 0:
                workflow.logger.info(
                    "revrec_findings_remaining",
                    extra={
                        "remaining_findings_count": summary["remaining_findings_count"],
                        "max_findings_per_run": max_findings,
                    },
                )

            summary["processed_findings"] = len(bounded_findings)
            for finding in bounded_findings:
                await workflow.execute_activity(
                    ops_revrec.ops_record_finding,
                    args=[finding, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_findings"] += 1
                proposed_action = str(finding.get("proposed_action") or "").strip()
                if not proposed_action:
                    continue

                if requested_auto_apply:
                    workflow.logger.warning(
                        "revrec_auto_apply_overridden",
                        extra={"fingerprint": finding["fingerprint"]},
                    )

                fingerprint = str(finding["fingerprint"])
                try:
                    await workflow.wait_condition(
                        lambda fingerprint=fingerprint: fingerprint in self._decisions,
                        timeout=workflow.timedelta(seconds=inp.approval_timeout_seconds),
                    )
                    decision = self._decisions.pop(fingerprint)
                except TimeoutError:
                    summary["timed_out_findings"] += 1
                    await workflow.execute_activity(
                        ops_revrec.ops_record_finding_disposition,
                        args=[finding, "timed_out", run_id, None],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                    continue

                if decision["decision"] == "approved":
                    summary["approved_findings"] += 1
                    await workflow.execute_activity(
                        ops_revrec.ops_draft_invoice_adjustment,
                        args=[finding, run_id, decision["approver"]],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_MONEY_RETRY,
                    )
                    summary["draft_adjustments_created"] += 1
                    await workflow.execute_activity(
                        ops_revrec.ops_record_finding_disposition,
                        args=[finding, "approved", run_id, decision["approver"]],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                else:
                    summary["rejected_findings"] += 1
                    await workflow.execute_activity(
                        ops_revrec.ops_record_finding_disposition,
                        args=[finding, "rejected", run_id, decision["approver"]],
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
                    ops_revrec.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def approve_finding(self, sig: ApproveFindingSignal) -> None:
        fingerprint = f"{sig.contract_id}:{sig.line_item_id}:{sig.finding_type}"
        self._decisions[fingerprint] = {
            "decision": "approved",
            "approver": {
                "approver_id": sig.approver_id,
                "approver_name": sig.approver_name,
                "note": sig.note,
            },
        }

    @workflow.signal
    async def reject_finding(self, sig: RejectFindingSignal) -> None:
        fingerprint = f"{sig.contract_id}:{sig.line_item_id}:{sig.finding_type}"
        self._decisions[fingerprint] = {
            "decision": "rejected",
            "approver": {
                "approver_id": sig.approver_id,
                "approver_name": sig.approver_name,
                "note": sig.note,
            },
        }
