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
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)

# Finding type constants keep the workflow code self-documenting.
_FINDING_TYPE_CREDIT_APPLICATION = "credit_application_review"
_FINDING_TYPE_LIEN_DEADLINE = "lien_deadline"
_FINDING_TYPE_LIEN_WAIVER = "lien_waiver"

# Agent key used for all three finding types in this workflow.
_AGENT_KEY = "credit-lien-control"


def _signal_key_prefix(obligation_id: str, finding_type: str) -> str:
    return f"{obligation_id}:{finding_type}:"


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class CreditLienControlWorkflowInput:
    tenant_id: str
    run_window_start: str | None = None
    run_window_end: str | None = None
    approval_timeout_seconds: int = 300


@dataclass
class ApproveCreditLienFindingSignal:
    obligation_id: str
    finding_type: str
    approver_id: str
    fingerprint: str | None = None
    approver_name: str | None = None
    note: str | None = None


@dataclass
class RejectCreditLienFindingSignal:
    obligation_id: str
    finding_type: str
    approver_id: str
    fingerprint: str | None = None
    approver_name: str | None = None
    note: str | None = None


# ---------------------------------------------------------------------------
# Workflow
# ---------------------------------------------------------------------------


@workflow.defn
class CreditLienControlWorkflow:
    """Ops workflow that surfaces credit-application reviews, lien-deadline
    obligations, and lien-waiver tracking items for analyst approval.

    Implements operating-model tasks t2 (credit applications), t4 (lien
    deadlines), and t5 (lien waivers) for the credit-billing-analyst role.

    Human-approved actions:
        • Credit limit / payment-terms changes (t2)
        • Preliminary notice send (t4)
        • Waiver closeout / receivable closure (t5)

    Duplicate-collapse: findings with the same material_signal_key as an
    existing open finding are skipped; only materially new evidence surfaces.
    """

    def __init__(self) -> None:
        self._decisions: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: CreditLienControlWorkflowInput) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "status": "succeeded",
            "workflow_state": "active",
            "credit_applications_scoped": 0,
            "lien_deadlines_scoped": 0,
            "lien_waivers_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "no_op_findings": 0,
            "approved_findings": 0,
            "rejected_findings": 0,
            "timed_out_findings": 0,
            "remaining_findings_count": 0,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_credit.ops_create_workflow_run,
                args=[
                    _AGENT_KEY,
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
                args=[inp.tenant_id, _AGENT_KEY],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            thresholds = config.get("thresholds") or {}
            min_confidence = float(thresholds.get("min_confidence_to_surface", 0.6))
            run_context = {
                "run_window_start": inp.run_window_start,
                "run_window_end": inp.run_window_end,
                "thresholds": thresholds,
            }

            # Scope all three obligation types in parallel
            (
                credit_applications,
                lien_deadlines,
                lien_waivers,
            ) = await asyncio.gather(
                workflow.execute_activity(
                    ops_credit.ops_scope_credit_applications,
                    args=[inp.tenant_id, run_context],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                ),
                workflow.execute_activity(
                    ops_credit.ops_scope_lien_deadlines,
                    args=[inp.tenant_id, run_context],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                ),
                workflow.execute_activity(
                    ops_credit.ops_scope_lien_waivers,
                    args=[inp.tenant_id, run_context],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                ),
            )
            summary["credit_applications_scoped"] = len(credit_applications)
            summary["lien_deadlines_scoped"] = len(lien_deadlines)
            summary["lien_waivers_scoped"] = len(lien_waivers)

            # Assess all obligations in parallel, grouped by type
            application_tasks = [
                workflow.execute_activity(
                    ops_credit.ops_application_assess,
                    args=[payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for payload in credit_applications
            ]
            deadline_tasks = [
                workflow.execute_activity(
                    ops_credit.ops_lien_deadline_assess,
                    args=[payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for payload in lien_deadlines
            ]
            waiver_tasks = [
                workflow.execute_activity(
                    ops_credit.ops_lien_waiver_assess,
                    args=[payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for payload in lien_waivers
            ]

            all_tasks = application_tasks + deadline_tasks + waiver_tasks
            all_payloads = credit_applications + lien_deadlines + lien_waivers
            all_finding_types = (
                [_FINDING_TYPE_CREDIT_APPLICATION] * len(credit_applications)
                + [_FINDING_TYPE_LIEN_DEADLINE] * len(lien_deadlines)
                + [_FINDING_TYPE_LIEN_WAIVER] * len(lien_waivers)
            )

            assessed = await asyncio.gather(*all_tasks) if all_tasks else []

            # Filter + deduplicate
            surfaced: list[dict[str, Any]] = []
            for idx, proposal in enumerate(assessed):
                payload = all_payloads[idx]
                finding_type = all_finding_types[idx]
                obligation_id = str(
                    proposal.get("obligation_id")
                    or proposal.get("application_id")
                    or payload.get("obligation_id")
                    or payload.get("application_id")
                    or ""
                )
                confidence = float(proposal.get("confidence") or 0.0)
                if confidence < min_confidence:
                    continue
                fingerprint = f"{obligation_id}:{finding_type}"
                surfaced.append({
                    **proposal,
                    "obligation_id": obligation_id,
                    "finding_type": finding_type,
                    "fingerprint": fingerprint,
                    "tenant_id": inp.tenant_id,
                    "agent_key": _AGENT_KEY,
                    "workflow_id": f"{_AGENT_KEY}:{run_id}",
                    "account_id": str(
                        proposal.get("account_id") or payload.get("account_id") or ""
                    ),
                    "customer_name": str(
                        proposal.get("customer_name") or payload.get("customer_name") or ""
                    ),
                    "project_id": str(
                        proposal.get("project_id") or payload.get("project_id") or ""
                    ),
                })

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
                recommended_action = str(finding.get("recommended_action") or "")
                if recommended_action in {"no_op", "acknowledge_no_action_required", "not_required"}:
                    summary["no_op_findings"] += 1
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
                    and existing_expected.get("material_signal_key")
                ):
                    summary["no_op_findings"] += 1
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
                    args=[_lien_control_finding_for_storage(finding), run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_findings"] += 1

                fingerprint = str(finding["fingerprint"])
                obligation_id = str(finding.get("obligation_id") or "")
                finding_type = str(finding.get("finding_type") or "")
                signal_key_prefix = _signal_key_prefix(obligation_id, finding_type)
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
                        args=[_lien_control_finding_for_storage(finding), "timed_out", run_id, None],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                    continue

                if decision["decision"] == "approved":
                    summary["approved_findings"] += 1
                    await workflow.execute_activity(
                        ops_credit.ops_record_finding_disposition,
                        args=[
                            _lien_control_finding_for_storage(finding),
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
                        ops_credit.ops_record_finding_disposition,
                        args=[
                            _lien_control_finding_for_storage(finding),
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
                    ops_credit.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def approve_finding(self, sig: ApproveCreditLienFindingSignal) -> None:
        decision_key = str(
            sig.fingerprint
            or _signal_key_prefix(sig.obligation_id, sig.finding_type)
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
    async def reject_finding(self, sig: RejectCreditLienFindingSignal) -> None:
        decision_key = str(
            sig.fingerprint
            or _signal_key_prefix(sig.obligation_id, sig.finding_type)
        )
        self._decisions[decision_key] = {
            "decision": "rejected",
            "approver": {
                "approver_id": sig.approver_id,
                "approver_name": sig.approver_name,
                "note": sig.note,
            },
        }


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------


def _lien_control_finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    """Map an assessed proposal into the generic finding storage schema."""
    obligation_id = str(finding.get("obligation_id") or finding.get("application_id") or "")
    finding_type = str(finding.get("finding_type") or "")
    severity = _urgency_to_severity(
        str(finding.get("urgency") or finding.get("risk_level") or "medium")
    )
    return {
        **finding,
        "contract_id": str(finding.get("project_id") or finding.get("account_id") or obligation_id),
        "line_item_id": None,
        "expected": {
            "obligation_id": obligation_id,
            "project_id": finding.get("project_id"),
            "account_id": finding.get("account_id"),
            "customer_name": finding.get("customer_name"),
            "finding_type": finding_type,
            "recommended_action": finding.get("recommended_action"),
            "material_signal_key": finding.get("material_signal_key"),
            "stale_inputs": list(finding.get("stale_inputs") or []),
            "operating_model_tags": list(finding.get("operating_model_tags") or []),
            # Lien-deadline specific
            "state": finding.get("state"),
            "deadline_date": finding.get("deadline_date"),
            "days_remaining": finding.get("days_remaining"),
            "urgency": finding.get("urgency"),
            "notice_sent": finding.get("notice_sent"),
            # Waiver specific
            "waiver_type": finding.get("waiver_type"),
            "waiver_status": finding.get("waiver_status"),
            "payment_amount": finding.get("payment_amount"),
            # Credit application specific
            "proposed_credit_limit": finding.get("proposed_credit_limit"),
            "proposed_terms": finding.get("proposed_terms"),
            "requested_credit_limit": finding.get("requested_credit_limit"),
        },
        "billed": {
            "amount": float(finding.get("payment_amount") or finding.get("requested_credit_limit") or 0),
        },
        "delta": float(finding.get("payment_amount") or finding.get("requested_credit_limit") or 0),
        "proposed_action": finding.get("recommended_action"),
        "finding_type": finding_type,
        "severity": severity,
    }


def _urgency_to_severity(urgency: str) -> str:
    return {
        "overdue": "high",
        "critical": "high",
        "warning": "medium",
        "ok": "low",
        "not_required": "low",
        "unknown_jurisdiction": "medium",
        "high": "high",
        "medium": "medium",
        "low": "low",
        "critical_risk": "high",
    }.get(urgency, "medium")
