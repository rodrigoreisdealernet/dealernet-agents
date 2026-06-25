from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_contract_ocr

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)


@dataclass
class ContractOcrRevalidationWorkflowInput:
    tenant_id: str
    contract_payload: dict[str, Any]
    config: dict[str, Any]


@workflow.defn
class ContractOcrRevalidationWorkflow:
    @workflow.run
    async def run(self, inp: ContractOcrRevalidationWorkflowInput) -> dict[str, Any]:
        return await workflow.execute_activity(
            ops_contract_ocr.ops_contract_ocr_revalidate_pages,
            args=[inp.contract_payload, inp.config],
            start_to_close_timeout=workflow.timedelta(seconds=30),
            retry_policy=_STANDARD_RETRY,
        )


@dataclass
class ContractAnalysisWorkflowInput:
    tenant_id: str
    contract_payload: dict[str, Any]
    config: dict[str, Any]


@workflow.defn
class ContractAnalysisWorkflow:
    @workflow.run
    async def run(self, inp: ContractAnalysisWorkflowInput) -> dict[str, Any]:
        ocr_result = await workflow.execute_child_workflow(
            ContractOcrRevalidationWorkflow.run,
            ContractOcrRevalidationWorkflowInput(
                tenant_id=inp.tenant_id,
                contract_payload=inp.contract_payload,
                config=inp.config,
            ),
        )

        ocr_status = str(ocr_result.get("status") or "blocked")
        if ocr_status != "analysis_ready":
            return {
                "status": ocr_status,
                "ocr_result": ocr_result,
            }

        analysis_result = await workflow.execute_activity(
            ops_contract_ocr.ops_contract_analyze_contract,
            args=[inp.contract_payload],
            start_to_close_timeout=workflow.timedelta(minutes=2),
            retry_policy=_STANDARD_RETRY,
        )

        return {
            "status": "analysis_ready",
            "ocr_result": ocr_result,
            "analysis_result": analysis_result,
        }
