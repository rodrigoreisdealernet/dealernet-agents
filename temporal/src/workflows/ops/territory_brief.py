"""Territory account brief and follow-up assistant workflow.

Builds a disposition-ready territory account brief for the outside sales
representative by aggregating recent rentals, open opportunities, visit
history, multi-branch signals, promised follow-ups, and branch-side
execution risks for each active account.

Design (issue #1811, operating-model tags t1/t2/t4):
- assist only — no automatic customer outreach, account-stage mutation,
  pricing commitment, or branch promise.
- Explicit no-op state when no account or branch signal exists.
- Stale or missing signals are surfaced explicitly so the rep knows what to
  verify before acting — briefs are never falsely complete.
- A ConfirmFollowUpSignal supports reviewable post-visit follow-up updates
  without silently mutating CRM stages or notes.
- Drill-down to source account, quote, and branch records is preserved in
  source_account_id and source_opportunity_id fields.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_territory_brief

_DEFAULT_MAX_ACCOUNTS_PER_RUN = 100

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)


@dataclass
class TerritoryAccountBriefWorkflowInput:
    tenant_id: str
    rep_id: str | None = None
    account_id: str | None = None
    run_date: str | None = None


@dataclass
class ConfirmFollowUpSignal:
    """Rep confirms a post-visit follow-up update — informational only.

    No CRM stage, account note, opportunity record, or outreach is mutated.
    The rep's confirmation is recorded so the follow-up context can be tracked
    as reviewed and ready for manual CRM entry.
    """
    account_id: str
    brief_type: str
    reviewer_id: str
    decision: str  # "confirmed" | "edited" | "discarded"
    fingerprint: str | None = None
    reviewer_name: str | None = None
    note: str | None = None


def _brief_key(account_id: str, brief_type: str, fingerprint: str | None) -> str:
    return fingerprint or f"{account_id}:{brief_type}"


@workflow.defn
class TerritoryAccountBriefWorkflow:
    """Build a territory account brief for the outside sales representative.

    Scopes active accounts from rental history, open opportunities, visit
    facts, promised follow-ups, and branch-side signals; runs AI assessment
    per account; surfaces the ranked brief as findings for rep review.

    Signals:
      confirm_follow_up — rep confirms a post-visit follow-up update
                          (informational, no CRM stage or note is changed).

    No-op path:
      If no account signals exist (scoped_accounts is empty), the workflow
      returns immediately with status='no_op' so the caller knows there is
      nothing materially new to act on.
    """

    def __init__(self) -> None:
        self._confirmations: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: TerritoryAccountBriefWorkflowInput) -> dict[str, Any]:
        workflow_key = "territory-account-brief"
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_accounts_scoped": 0,
            "processed_accounts": 0,
            "recorded_items": 0,
            "deduped_items": 0,
            "confirmed_items": 0,
            "no_op": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_territory_brief.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {
                        "rep_id": inp.rep_id,
                        "account_id": inp.account_id,
                        "run_date": inp.run_date,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_territory_brief.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )

            # Scope candidate accounts.
            scoped_accounts: list[dict[str, Any]] = await workflow.execute_activity(
                ops_territory_brief.ops_territory_brief_scope,
                args=[inp.tenant_id, inp.rep_id, inp.account_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_accounts_scoped"] = len(scoped_accounts)

            # Explicit no-op state: no account or branch signals.
            if not scoped_accounts:
                summary["status"] = "no_op"
                summary["no_op"] = True
                return {"run_id": run_id, **summary}

            # Deduplicate against existing open findings.
            existing_fingerprints: list[str] = await workflow.execute_activity(
                ops_territory_brief.ops_list_open_finding_fingerprints,
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
                    ops_territory_brief.ops_territory_brief_assess,
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

            for item in assessed:
                account_id = str(item.get("account_id") or "")
                brief_type = str(item.get("brief_type") or "territory_plan")
                source_account_id = str(item.get("source_account_id") or account_id)
                fingerprint = f"territory-brief:{brief_type}:{source_account_id}"
                item["fingerprint"] = fingerprint
                item["agent_key"] = workflow_key
                item["workflow_id"] = f"territory-account-brief:{run_id}"

                if fingerprint in seen:
                    summary["deduped_items"] += 1
                    continue
                seen.add(fingerprint)

                await workflow.execute_activity(
                    ops_territory_brief.ops_record_finding,
                    args=[item, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_items"] += 1

            return {"run_id": run_id, **summary}

        except Exception:
            summary["status"] = "failed"
            raise
        finally:
            if run_id:
                await workflow.execute_activity(
                    ops_territory_brief.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def confirm_follow_up(self, sig: ConfirmFollowUpSignal) -> None:
        """Rep confirms a post-visit follow-up context update — informational only.

        No CRM stage, account note, opportunity record, or customer-facing
        outreach is changed.  The rep's confirmation is recorded so follow-up
        items can be tracked as reviewed and ready for manual CRM entry.
        """
        key = _brief_key(sig.account_id, sig.brief_type, sig.fingerprint)
        self._confirmations[key] = {
            "reviewer_id": sig.reviewer_id,
            "reviewer_name": sig.reviewer_name,
            "decision": sig.decision,
            "note": sig.note,
            "confirmed": True,
        }
