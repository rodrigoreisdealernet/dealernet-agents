from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_credit

_DEFAULT_MAX_FINDINGS_PER_RUN = 50

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
# 45 s matches the LLM activity heartbeat used across all ops agents — long
# enough for a multi-round tool-call conversation, short enough that a hung
# LLM call is detected and retried within the activity start_to_close window.
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)


def _signal_key_prefix(account_id: str, finding_type: str) -> str:
    return f"{account_id}:{finding_type}:"


@dataclass
class CreditRiskWorkflowInput:
    tenant_id: str
    run_window_start: str | None = None
    run_window_end: str | None = None
    approval_timeout_seconds: int = 300
    locale: str = "pt-BR"


@dataclass
class ApproveCreditFindingSignal:
    account_id: str
    finding_type: str
    approver_id: str
    fingerprint: str | None = None
    approver_name: str | None = None
    note: str | None = None


@dataclass
class RejectCreditFindingSignal:
    account_id: str
    finding_type: str
    approver_id: str
    fingerprint: str | None = None
    approver_name: str | None = None
    note: str | None = None


@workflow.defn
class CreditRiskWorkflow:
    def __init__(self) -> None:
        self._decisions: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: CreditRiskWorkflowInput) -> dict[str, Any]:
        workflow_key = "credit-analyst"
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_accounts_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "no_op_accounts": 0,
            "approved_findings": 0,
            "rejected_findings": 0,
            "timed_out_findings": 0,
            "remaining_findings_count": 0,
            "auto_apply": False,
            "workflow_state": "active",
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_credit.ops_create_workflow_run,
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
                ops_credit.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["auto_apply"] = False

            thresholds = config.get("thresholds") or {}
            min_confidence = float(thresholds.get("min_confidence_to_surface", 0.6))

            scoped_accounts = await workflow.execute_activity(
                ops_credit.ops_scope_credit_accounts,
                args=[
                    inp.tenant_id,
                    {
                        "run_window_start": inp.run_window_start,
                        "run_window_end": inp.run_window_end,
                        "thresholds": thresholds,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_accounts_scoped"] = len(scoped_accounts)

            analyze_tasks = [
                workflow.execute_activity(
                    ops_credit.ops_credit_assess,
                    args=[account_payload, {**config, "locale": inp.locale}, run_id],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for account_payload in scoped_accounts
            ]
            assessed = await asyncio.gather(*analyze_tasks) if analyze_tasks else []

            surfaced: list[dict[str, Any]] = []
            for idx, proposal in enumerate(assessed):
                account_payload = scoped_accounts[idx]
                account_id = str(
                    proposal.get("account_id") or account_payload.get("account_id") or ""
                )
                finding_type = "collections_priority"
                risk_level = str(proposal.get("risk_level") or "medium")
                proposed_action = str(proposal.get("proposed_action") or "no_op")
                fingerprint = f"{account_id}:{finding_type}"
                confidence = float(proposal.get("confidence") or 0.0)
                if confidence < min_confidence:
                    continue
                surfaced.append(
                    {
                        "account_id": account_id,
                        "customer_id": str(
                            proposal.get("customer_id") or account_payload.get("customer_id") or ""
                        ),
                        "finding_type": finding_type,
                        "severity": _risk_level_to_severity(risk_level),
                        "risk_level": risk_level,
                        "proposed_action": proposed_action,
                        "proposed_credit_limit": proposal.get("proposed_credit_limit"),
                        "proposed_terms": proposal.get("proposed_terms"),
                        "proposed_hold": bool(proposal.get("proposed_hold")),
                        "current_exposure": float(proposal.get("current_exposure") or 0.0),
                        "overdue_amount": float(proposal.get("overdue_amount") or 0.0),
                        "oldest_overdue_days": int(proposal.get("oldest_overdue_days") or 0),
                        "escalation_stage": str(proposal.get("escalation_stage") or "routine_follow_up"),
                        "stale_inputs": list(proposal.get("stale_inputs") or []),
                        "latest_payment_at": proposal.get("latest_payment_at"),
                        "material_signal_key": str(proposal.get("material_signal_key") or ""),
                        "account_label": str(proposal.get("account_label") or account_payload.get("account_label") or ""),
                        "customer_name": str(proposal.get("customer_name") or account_payload.get("customer_name") or ""),
                        "branch_context": str(proposal.get("branch_context") or account_payload.get("branch_context") or ""),
                        "operating_model_tags": list(proposal.get("operating_model_tags") or []),
                        "aging_trend": str(proposal.get("aging_trend") or "unknown"),
                        "payment_behavior_score": float(
                            proposal.get("payment_behavior_score") or 0.0
                        ),
                        "evidence": list(proposal.get("evidence") or []),
                        "confidence": confidence,
                        "rationale": str(proposal.get("rationale") or ""),
                        "fingerprint": fingerprint,
                        "tenant_id": inp.tenant_id,
                        "agent_key": workflow_key,
                        "workflow_id": f"ops-credit:{run_id}",
                    }
                )

            existing_findings = await workflow.execute_activity(
                ops_credit.ops_list_existing_findings,
                args=[inp.tenant_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            existing_by_fingerprint = {
                str(row.get("fingerprint") or ""): dict(row)
                for row in existing_findings
                if str(row.get("fingerprint") or "")
            }
            materially_changed: list[dict[str, Any]] = []
            for finding in surfaced:
                if str(finding.get("proposed_action") or "") == "no_op":
                    summary["no_op_accounts"] += 1
                    continue
                fp = str(finding["fingerprint"])
                existing = existing_by_fingerprint.get(fp, {})
                existing_expected = (
                    dict(existing.get("expected"))
                    if isinstance(existing.get("expected"), dict)
                    else {}
                )
                if (
                    existing_expected.get("material_signal_key")
                    == finding.get("material_signal_key")
                ):
                    summary["no_op_accounts"] += 1
                    continue
                materially_changed.append(finding)

            try:
                max_findings = int(
                    (config.get("bounds") or {}).get(
                        "max_findings_per_run", _DEFAULT_MAX_FINDINGS_PER_RUN
                    )
                )
            except (TypeError, ValueError):
                max_findings = _DEFAULT_MAX_FINDINGS_PER_RUN
            max_findings = max(0, max_findings)
            bounded_findings = materially_changed[:max_findings]
            summary["remaining_findings_count"] = max(
                0, len(materially_changed) - len(bounded_findings)
            )
            summary["processed_findings"] = len(bounded_findings)
            if summary["processed_findings"] == 0:
                summary["status"] = "no_op"
                summary["workflow_state"] = "no_op"

            for finding in bounded_findings:
                await workflow.execute_activity(
                    ops_credit.ops_record_finding,
                    args=[finding, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_findings"] += 1

                fingerprint = str(finding["fingerprint"])
                signal_key_prefix = _signal_key_prefix(
                    str(finding.get("account_id") or ""),
                    str(finding.get("finding_type") or ""),
                )
                try:
                    await workflow.wait_condition(
                        lambda fingerprint=fingerprint, signal_key_prefix=signal_key_prefix: fingerprint in self._decisions
                        or any(
                            key.startswith(signal_key_prefix) for key in self._decisions
                        ),
                        timeout=workflow.timedelta(seconds=inp.approval_timeout_seconds),
                    )
                    decision_key = (
                        fingerprint
                        if fingerprint in self._decisions
                        else next(
                            (
                                key
                                for key in self._decisions
                                if key.startswith(signal_key_prefix)
                            ),
                            None,
                        )
                    )
                    if decision_key is None:
                        raise TimeoutError("decision missing after approval signal")
                    decision = self._decisions.pop(decision_key)
                except TimeoutError:
                    summary["timed_out_findings"] += 1
                    await workflow.execute_activity(
                        ops_credit.ops_record_finding_disposition,
                        args=[finding, "timed_out", run_id, None],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                    continue

                if decision["decision"] == "approved":
                    summary["approved_findings"] += 1
                    await workflow.execute_activity(
                        ops_credit.ops_record_finding_disposition,
                        args=[finding, "approved", run_id, decision["approver"]],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                else:
                    summary["rejected_findings"] += 1
                    await workflow.execute_activity(
                        ops_credit.ops_record_finding_disposition,
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
                    ops_credit.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def approve_finding(self, sig: ApproveCreditFindingSignal) -> None:
        decision_key = str(
            sig.fingerprint or _signal_key_prefix(sig.account_id, sig.finding_type)
        )
        self._decisions[decision_key] = {
            "decision": "approved",
            "approver": {
                "approver_id": sig.approver_id,
                "approver_name": sig.approver_name,
                "note": sig.note,
            },
        }

    @workflow.signal
    async def reject_finding(self, sig: RejectCreditFindingSignal) -> None:
        decision_key = str(
            sig.fingerprint or _signal_key_prefix(sig.account_id, sig.finding_type)
        )
        self._decisions[decision_key] = {
            "decision": "rejected",
            "approver": {
                "approver_id": sig.approver_id,
                "approver_name": sig.approver_name,
                "note": sig.note,
            },
        }


def _risk_level_to_severity(risk_level: str) -> str:
    return {"low": "low", "medium": "medium", "high": "high", "critical": "high"}.get(
        risk_level, "medium"
    )
