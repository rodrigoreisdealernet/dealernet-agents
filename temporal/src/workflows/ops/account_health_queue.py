"""Account health and dormant-account growth queue workflow.

Builds a ranked, deduplicated account-health queue for the outside sales
representative by aggregating rental-history, utilization-shift, open-
opportunity, and contact-gap signals for dormant, lost, at-risk, and
growth-prone accounts.

Design (issue #1813, operating-model tags outside-sales-representative:t6/t7):
- assist only — no automatic outreach, campaign launch, account-stage mutation,
  or commercial offer.
- Duplicate signals for the same account collapse into one canonical thread.
- Explicit no-op state when no materially new account-health signal exists.
- Stale or weak signals are surfaced explicitly so the rep can decide whether
  the evidence is fresh enough to act on.
- Rep reviews and edits the outreach draft before any contact is made.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_account_health

_DEFAULT_MAX_ACCOUNTS_PER_RUN = 100

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)


@dataclass
class AccountHealthQueueWorkflowInput:
    tenant_id: str
    rep_id: str | None = None
    run_date: str | None = None


@dataclass
class ReviewAccountThreadSignal:
    """Rep reviews an account health thread — informational only.

    No account stage, outreach, or commercial term is changed.
    The rep's decision (accepted_angle / rejected) is recorded so the thread
    can be tracked as reviewed.
    """
    account_id: str
    health_signal: str
    reviewer_id: str
    decision: str  # "accepted_angle" | "rejected" | "needs_more_info"
    fingerprint: str | None = None
    reviewer_name: str | None = None
    note: str | None = None


def _thread_key(account_id: str, health_signal: str, fingerprint: str | None) -> str:
    return fingerprint or f"{account_id}:{health_signal}"


@workflow.defn
class AccountHealthQueueWorkflow:
    """Build a ranked account-health and dormant-account growth queue.

    Scopes dormant, lost, at-risk, and growth-opportunity accounts from
    rental history, utilization, open opportunities, and contact gaps;
    runs AI assessment per account; surfaces the ranked queue as findings
    for rep review with a draft outreach angle.

    Signals:
      review_account_thread — rep marks a thread reviewed (informational,
                              no account stage or outreach is changed).

    No-op path:
      If no new account-health signals exist (scoped_accounts is empty),
      the workflow returns immediately with status='no_op' so the caller
      knows there is nothing materially new to act on.
    """

    def __init__(self) -> None:
        self._reviews: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: AccountHealthQueueWorkflowInput) -> dict[str, Any]:
        workflow_key = "account-health-queue"
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_accounts_scoped": 0,
            "processed_accounts": 0,
            "recorded_threads": 0,
            "deduped_threads": 0,
            "reviewed_threads": 0,
            "no_op": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_account_health.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {
                        "rep_id": inp.rep_id,
                        "run_date": inp.run_date,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_account_health.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )

            # Scope candidate accounts.
            scoped_accounts: list[dict[str, Any]] = await workflow.execute_activity(
                ops_account_health.ops_account_health_scope,
                args=[inp.tenant_id, inp.rep_id, inp.run_date],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_accounts_scoped"] = len(scoped_accounts)

            # Explicit no-op state: no new account-health signals.
            if not scoped_accounts:
                summary["status"] = "no_op"
                summary["no_op"] = True
                return {"run_id": run_id, **summary}

            # Deduplicate against existing open findings.
            existing_fingerprints: list[str] = await workflow.execute_activity(
                ops_account_health.ops_list_open_finding_fingerprints,
                args=[inp.tenant_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            seen: set[str] = set(existing_fingerprints)

            try:
                max_accounts = int(
                    (config.get("bounds") or {}).get("max_findings_per_run", _DEFAULT_MAX_ACCOUNTS_PER_RUN)
                )
            except (TypeError, ValueError):
                max_accounts = _DEFAULT_MAX_ACCOUNTS_PER_RUN
            max_accounts = max(0, max_accounts)

            # AI assessment per account (concurrent).
            assess_tasks = [
                workflow.execute_activity(
                    ops_account_health.ops_account_health_assess,
                    args=[account_payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for account_payload in scoped_accounts[:max_accounts]
            ]
            assessed: list[dict[str, Any]] = await asyncio.gather(*assess_tasks) if assess_tasks else []
            summary["processed_accounts"] = len(assessed)

            # Sort by priority (critical > high > medium > low).
            _priority_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
            assessed.sort(key=lambda x: _priority_rank.get(str(x.get("priority") or "low"), 3))

            for thread in assessed:
                account_id = str(thread.get("account_id") or "")
                health_signal = str(thread.get("health_signal") or "dormant")
                fingerprint = f"account-health:{account_id}:{health_signal}"
                thread["fingerprint"] = fingerprint
                thread["agent_key"] = workflow_key
                thread["workflow_id"] = f"account-health-queue:{run_id}"

                if fingerprint in seen:
                    summary["deduped_threads"] += 1
                    continue
                seen.add(fingerprint)

                await workflow.execute_activity(
                    ops_account_health.ops_record_finding,
                    args=[thread, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_threads"] += 1

            return {"run_id": run_id, **summary}

        except Exception:
            summary["status"] = "failed"
            raise
        finally:
            if run_id:
                await workflow.execute_activity(
                    ops_account_health.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def review_account_thread(self, sig: ReviewAccountThreadSignal) -> None:
        """Rep reviews an account health thread — informational only.

        No account stage, CRM opportunity, outreach, or commercial term is
        changed.  The review decision is recorded so the rep can track which
        threads have been acted on.
        """
        key = _thread_key(sig.account_id, sig.health_signal, sig.fingerprint)
        self._reviews[key] = {
            "reviewer_id": sig.reviewer_id,
            "reviewer_name": sig.reviewer_name,
            "decision": sig.decision,
            "note": sig.note,
            "reviewed": True,
        }
