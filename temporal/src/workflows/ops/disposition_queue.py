"""Disposition recommendation queue workflow.

Turns lifecycle evidence into a canonical recommendation queue for the
Regional / Enterprise Operations Executive.  Each run:

  1. Scopes candidate assets that cross configured age, utilization, or
     maintenance-cost thresholds (monthly or on-demand trigger).
  2. Runs AI assessment per asset to produce a ranked keep / sell_now /
     replace recommendation with a timing rationale and evidence bundle.
  3. Maintains at most one active recommendation per asset — unchanged
     findings are skipped (no-op), changed findings are upserted so the
     recommendation is current.
  4. Retires findings for assets that no longer cross any threshold so the
     review queue stays clean.
  5. Waits for executive review signals during a configurable review window;
     each decision is persisted to the database via an activity so the review
     is durable beyond the assessment phase.

Design constraints (issue #2330):
  - No sale, retirement, or replacement purchase is ever executed automatically.
  - Stale or unchanged findings are surfaced explicitly or retired.
  - Trigger types: monthly_review (scheduled), threshold_breach (on-demand).
  - Operating-model tags: operations-executive:t1 / t5.
"""
from __future__ import annotations

import asyncio
import contextlib
from collections import deque
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_disposition

_DEFAULT_MAX_FINDINGS_PER_RUN = 100
_DEFAULT_REVIEW_WINDOW_DAYS = 30

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)


@dataclass
class DispositionQueueWorkflowInput:
    """Input for the DispositionQueueWorkflow.

    Attributes:
        tenant_id: Tenant scope for the run.
        trigger_type: 'monthly_review' (scheduled) or 'threshold_breach' (on-demand).
        run_date: Optional ISO date string to anchor the review window (default: now).
        age_months_threshold: Override configured age threshold (months).
        utilization_pct_threshold: Override configured utilization threshold (%).
        maintenance_cost_ratio_threshold: Override configured maintenance cost ratio.
    """
    tenant_id: str
    trigger_type: str = "monthly_review"
    run_date: str | None = None
    age_months_threshold: float | None = None
    utilization_pct_threshold: float | None = None
    maintenance_cost_ratio_threshold: float | None = None
    locale: str = "pt-BR"


@dataclass
class ReviewDispositionFindingSignal:
    """Executive reviews a disposition finding — informational only.

    No asset sale, retirement purchase, or depreciation entry is changed.
    The reviewer's decision is persisted so the finding can be tracked as reviewed.
    """
    asset_id: str
    reviewer_id: str
    decision: str  # "accepted" | "deferred" | "rejected" | "needs_more_info"
    fingerprint: str | None = None
    reviewer_name: str | None = None
    note: str | None = None


def _review_key(asset_id: str, fingerprint: str | None) -> str:
    return fingerprint or f"disposition-queue:{asset_id}"


@workflow.defn
class DispositionQueueWorkflow:
    """Build and maintain the asset disposition recommendation queue.

    Scopes assets crossing lifecycle thresholds; runs AI assessment for ALL
    scoped assets; sorts by priority globally; then records the top
    ``max_findings_per_run`` findings.  This ensures high-priority assets are
    never silently omitted due to input ordering.

    After recording findings the workflow remains alive for a configurable
    review window (``bounds.review_window_days``, default 30 days).  During
    this window the workflow accepts ``review_disposition_finding`` signals from
    the Operations Executive and persists each decision to the database via an
    activity so the review is durable regardless of when the workflow completes.

    Signals:
      review_disposition_finding — executive marks a finding reviewed
                                   (informational, no sale or purchase triggered).

    No-op path:
      If no candidate assets exist (nothing crosses thresholds), the workflow
      returns immediately with status='no_op'.
    """

    def __init__(self) -> None:
        self._pending_reviews: deque[ReviewDispositionFindingSignal] = deque()

    @workflow.run
    async def run(self, inp: DispositionQueueWorkflowInput) -> dict[str, Any]:
        workflow_key = "disposition-queue"
        summary: dict[str, Any] = {
            "status": "succeeded",
            "trigger_type": inp.trigger_type,
            "total_assets_scoped": 0,
            "processed_findings": 0,
            "recorded_findings": 0,
            "unchanged_findings": 0,
            "deduped_findings": 0,
            "retired_findings": 0,
            "remaining_findings_count": 0,
            "reviews_persisted": 0,
            "no_op": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_disposition.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {
                        "trigger_type": inp.trigger_type,
                        "run_date": inp.run_date,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_disposition.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )

            thresholds = config.get("thresholds") or {}
            run_context: dict[str, Any] = {
                "trigger_type": inp.trigger_type,
                "run_date": inp.run_date,
                "age_months_threshold": inp.age_months_threshold or thresholds.get("age_months_threshold"),
                "utilization_pct_threshold": inp.utilization_pct_threshold or thresholds.get("utilization_pct_threshold"),
                "maintenance_cost_ratio_threshold": inp.maintenance_cost_ratio_threshold or thresholds.get("maintenance_cost_ratio_threshold"),
            }

            scoped_assets: list[dict[str, Any]] = await workflow.execute_activity(
                ops_disposition.ops_disposition_scope,
                args=[inp.tenant_id, run_context],
                start_to_close_timeout=workflow.timedelta(seconds=60),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_assets_scoped"] = len(scoped_assets)

            if not scoped_assets:
                summary["status"] = "no_op"
                summary["no_op"] = True
                return {"run_id": run_id, **summary}

            scoped_asset_ids = [str(a.get("asset_id") or "") for a in scoped_assets]

            existing_findings: list[dict[str, Any]] = await workflow.execute_activity(
                ops_disposition.ops_disposition_list_existing_findings,
                args=[inp.tenant_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            existing_by_fingerprint: dict[str, dict[str, Any]] = {
                str(f.get("fingerprint") or ""): dict(f)
                for f in existing_findings
                if str(f.get("fingerprint") or "")
            }

            try:
                max_findings = int(
                    (config.get("bounds") or {}).get("max_findings_per_run", _DEFAULT_MAX_FINDINGS_PER_RUN)
                )
            except (TypeError, ValueError):
                max_findings = _DEFAULT_MAX_FINDINGS_PER_RUN
            max_findings = max(0, max_findings)

            # Assess ALL scoped assets concurrently so the global priority sort
            # is not distorted by input order.  The max_findings cap is applied
            # AFTER sorting so the highest-priority assets are always chosen.
            assess_tasks = [
                workflow.execute_activity(
                    ops_disposition.ops_disposition_assess,
                    args=[asset_payload, {**config, "locale": inp.locale}],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for asset_payload in scoped_assets
            ]
            assessed: list[dict[str, Any]] = await asyncio.gather(*assess_tasks) if assess_tasks else []

            _priority_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
            assessed.sort(key=lambda x: _priority_rank.get(str(x.get("priority") or "low"), 3))

            to_record: list[dict[str, Any]] = []
            for recommendation in assessed:
                asset_id = str(recommendation.get("asset_id") or "")
                if not asset_id:
                    continue
                fingerprint = f"disposition-queue:{asset_id}"
                recommendation["fingerprint"] = fingerprint
                recommendation["agent_key"] = workflow_key
                recommendation["workflow_id"] = f"disposition-queue:{run_id}"

                existing = existing_by_fingerprint.get(fingerprint, {})
                existing_action = str(existing.get("recommended_action") or "")
                new_action = str(recommendation.get("recommended_action") or "keep")

                if existing_action and existing_action == new_action:
                    summary["unchanged_findings"] += 1
                    continue

                to_record.append(recommendation)

            # Apply the cap AFTER global ranking so the highest-priority findings
            # are always chosen.  remaining_findings_count reflects how many were
            # cut off by the bound.
            summary["remaining_findings_count"] = max(0, len(to_record) - max_findings)
            bounded = to_record[:max_findings]
            summary["processed_findings"] = len(bounded)

            if not bounded:
                if not existing_by_fingerprint:
                    summary["status"] = "no_op"
                    summary["no_op"] = True

            for finding in bounded:
                await workflow.execute_activity(
                    ops_disposition.ops_record_finding,
                    args=[finding, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_findings"] += 1

            retired = await workflow.execute_activity(
                ops_disposition.ops_disposition_retire_stale_findings,
                args=[inp.tenant_id, scoped_asset_ids, run_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["retired_findings"] = retired

            # ----------------------------------------------------------------
            # Review window — keep the workflow alive so executives can send
            # review_disposition_finding signals.  Each signal is persisted to
            # the database via an activity (durable, not in-memory only).
            # ----------------------------------------------------------------
            try:
                review_window_days = int(
                    (config.get("bounds") or {}).get("review_window_days", _DEFAULT_REVIEW_WINDOW_DAYS)
                )
            except (TypeError, ValueError):
                review_window_days = _DEFAULT_REVIEW_WINDOW_DAYS
            review_window_days = max(0, review_window_days)

            if review_window_days > 0 and not summary.get("no_op"):
                # Anchor the deadline once so the workflow cannot outlive its
                # configured review window regardless of how many signals arrive.
                review_deadline = workflow.now() + workflow.timedelta(days=review_window_days)
                with contextlib.suppress(TimeoutError):
                    while True:
                        remaining = review_deadline - workflow.now()
                        if remaining.total_seconds() <= 0:
                            break
                        await workflow.wait_condition(
                            lambda: bool(self._pending_reviews),
                            timeout=remaining,
                        )
                        while self._pending_reviews:
                            rev = self._pending_reviews.popleft()
                            fp = _review_key(rev.asset_id, rev.fingerprint)
                            await workflow.execute_activity(
                                ops_disposition.ops_record_finding_review,
                                args=[inp.tenant_id, fp, rev.reviewer_id, rev.reviewer_name, rev.decision, rev.note, run_id],
                                start_to_close_timeout=workflow.timedelta(seconds=30),
                                retry_policy=_STANDARD_RETRY,
                            )
                            summary["reviews_persisted"] += 1

            return {"run_id": run_id, **summary}

        except Exception:
            summary["status"] = "failed"
            raise
        finally:
            if run_id:
                await workflow.execute_activity(
                    ops_disposition.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def review_disposition_finding(self, sig: ReviewDispositionFindingSignal) -> None:
        """Executive reviews a disposition finding — informational only.

        No asset sale, retirement, replacement purchase, or depreciation
        entry is changed.  The review decision is queued for durable
        persistence via an activity (see review window in ``run``).
        """
        self._pending_reviews.append(sig)
