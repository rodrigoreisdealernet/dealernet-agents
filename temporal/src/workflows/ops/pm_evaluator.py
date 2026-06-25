"""Preventative-maintenance evaluator workflow.

Periodically scans all enabled PM policies, evaluates trigger conditions
(meter / rental-count / time-interval), and idempotently creates maintenance
work orders for any asset that is due.

Design constraints (from issue #434 design approval):
- One active preventative work order per asset per policy window.
- Meter triggers block auto-due when no fresh reading is available.
- Re-running the evaluator must not create duplicate open work orders.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_pm
    from ...models.rental import PMEvaluatorInput, PMEvaluatorSummary

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)

# Upper bound: prevent runaway activity cost when a tenant has thousands of
# assets each with multiple policies.
_DEFAULT_MAX_WO_PER_RUN = 200


@workflow.defn
class PMEvaluatorWorkflow:
    """Scan enabled PM policies and create due maintenance work orders.

    Triggered by a Temporal schedule (one per tenant) configured in worker.py.
    Can also be invoked ad-hoc for testing.
    """

    @workflow.run
    async def run(self, inp: PMEvaluatorInput) -> dict[str, Any]:
        summary = PMEvaluatorSummary(tenant_id=inp.tenant_id)
        evaluation_timestamp = inp.evaluation_timestamp or workflow.now().isoformat()

        try:
            # 1. Scope all enabled policies (category defaults merged to asset level)
            policies: list[dict[str, Any]] = await workflow.execute_activity(
                ops_pm.pm_scope_enabled_policies,
                inp.tenant_id,
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary.total_policies_scoped = len(policies)

            if not policies:
                return asdict(summary)

            # 2. Fetch existing open PM work-order fingerprints for deduplication
            existing_fingerprints: list[str] = await workflow.execute_activity(
                ops_pm.pm_list_open_wo_fingerprints,
                inp.tenant_id,
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            seen: set[str] = set(existing_fingerprints)

            # 3. Evaluate all policies concurrently; asset_context is embedded
            #    in the policy dict by pm_scope_enabled_policies (denormalised).
            evaluate_tasks = [
                workflow.execute_activity(
                    ops_pm.pm_evaluate_trigger,
                    args=[policy, policy.get("asset_context", {}), evaluation_timestamp],
                    start_to_close_timeout=workflow.timedelta(seconds=15),
                    retry_policy=_STANDARD_RETRY,
                )
                for policy in policies
            ]
            evaluations: list[dict[str, Any]] = (
                await asyncio.gather(*evaluate_tasks) if evaluate_tasks else []
            )

            # 4. For each due evaluation, create a work order (idempotent)
            wo_created = 0
            wo_skipped = 0
            run_id = f"pm-eval:{inp.tenant_id}:{evaluation_timestamp}"

            for evaluation in evaluations:
                if evaluation.get("is_due"):
                    summary.due_count += 1
                elif evaluation.get("is_pre_due"):
                    summary.pre_due_count += 1

                if not evaluation.get("is_due"):
                    continue

                fingerprint = str(evaluation.get("fingerprint") or "")
                if fingerprint in seen:
                    wo_skipped += 1
                    summary.work_orders_skipped_duplicate += 1
                    continue

                if wo_created >= _DEFAULT_MAX_WO_PER_RUN:
                    # Safety cap reached; remaining will be picked up on next run.
                    break

                seen.add(fingerprint)
                await workflow.execute_activity(
                    ops_pm.pm_upsert_work_order,
                    args=[evaluation, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=15),
                    retry_policy=_MONEY_RETRY,
                )
                wo_created += 1
                summary.work_orders_created += 1

        except Exception:
            summary.status = "failed"
            raise

        return asdict(summary)
