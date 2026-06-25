from __future__ import annotations

import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.workflows.ops.contract_ocr import (
    ContractAnalysisWorkflow,
    ContractAnalysisWorkflowInput,
    ContractOcrRevalidationWorkflow,
    ContractOcrRevalidationWorkflowInput,
)


def _config(min_confidence_to_analyze: float = 0.85) -> dict:
    return {
        "thresholds": {"min_confidence_to_analyze": min_confidence_to_analyze},
    }


async def _run_revalidation(contract_payload: dict, config: dict) -> dict:
    wf = ContractOcrRevalidationWorkflow()

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        args = kw.get("args", list(pos_args))
        return fn_or_str(*args)

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_contract_ocr_workflow")),
    ):
        return await wf.run(
            ContractOcrRevalidationWorkflowInput(
                tenant_id="tenant-a",
                contract_payload=contract_payload,
                config=config,
            )
        )


@pytest.mark.asyncio
async def test_contract_ocr_revalidation_happy_path_returns_analysis_ready() -> None:
    result = await _run_revalidation(
        contract_payload={
        "contract_id": "ctr-1",
        "pages": [
            {"page_number": 1, "confidence": 0.99},
            {"page_number": 2, "confidence": 0.85},
        ],
    },
        config=_config(),
    )

    assert result["status"] == "analysis_ready"
    assert result["manual_review_pages"] == []


@pytest.mark.asyncio
async def test_contract_ocr_revalidation_routes_low_confidence_and_disputed_pages() -> None:
    result = await _run_revalidation(
        contract_payload={
        "contract_id": "ctr-2",
        "pages": [
            {"page_number": 1, "confidence": 0.84, "reason": "low_confidence"},
            {"page_number": 2, "confidence": 0.91, "is_disputed": True, "reason": "customer_dispute"},
        ],
    },
        config=_config(min_confidence_to_analyze=0.85),
    )

    assert result["status"] == "manual_review_required"
    assert result["manual_review_pages"] == [
        {
            "page_number": 1,
            "confidence": 0.84,
            "status": "manual_review_required",
            "reason": "low_confidence",
        },
        {
            "page_number": 2,
            "confidence": 0.91,
            "status": "disputed",
            "reason": "customer_dispute",
        },
    ]


@pytest.mark.asyncio
async def test_contract_ocr_revalidation_blocks_when_ocr_is_blocked() -> None:
    result = await _run_revalidation(
        contract_payload={
            "contract_id": "ctr-3",
            "ocr_blocked": True,
            "blocked_reason": "source_document_missing",
            "pages": [],
        },
        config=_config(),
    )

    assert result["status"] == "blocked"
    assert result["reason"] == "source_document_missing"


@pytest.mark.asyncio
async def test_contract_ocr_revalidation_threshold_edge_is_analysis_ready() -> None:
    result = await _run_revalidation(
        contract_payload={
            "contract_id": "ctr-4",
            "pages": [{"page_number": 1, "confidence": 0.85}],
        },
        config=_config(min_confidence_to_analyze=0.85),
    )

    assert result["status"] == "analysis_ready"
    assert result["manual_review_pages"] == []


@pytest.mark.asyncio
async def test_contract_ocr_revalidation_propagates_blocked_page_details() -> None:
    result = await _run_revalidation(
        contract_payload={
            "contract_id": "ctr-5",
            "pages": [
                {
                    "page_number": 7,
                    "confidence": 0.12,
                    "status": "blocked",
                    "reason": "ocr_engine_timeout",
                }
            ],
        },
        config=_config(),
    )

    assert result["status"] == "blocked"
    assert result["manual_review_pages"] == [
        {
            "page_number": 7,
            "confidence": 0.12,
            "status": "blocked",
            "reason": "ocr_engine_timeout",
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("ocr_status", ["manual_review_required", "blocked"])
async def test_contract_analysis_workflow_never_bypasses_non_ready_ocr(ocr_status: str) -> None:
    wf = ContractAnalysisWorkflow()
    child_result = {
        "status": ocr_status,
        "manual_review_pages": [
            {"page_number": 1, "confidence": 0.3, "status": "low_confidence", "reason": "blurred_scan"}
        ],
    }

    async def fake_execute_child_workflow(*args, **kwargs):
        return child_result

    async def fail_if_analysis_activity_called(*args, **kwargs):
        raise AssertionError("Downstream analysis must not run when OCR is not analysis_ready")

    with (
        patch.object(tw_mod, "execute_child_workflow", side_effect=fake_execute_child_workflow),
        patch.object(tw_mod, "execute_activity", side_effect=fail_if_analysis_activity_called),
        patch.object(tw_mod, "logger", logging.getLogger("test_contract_ocr_workflow")),
    ):
        result = await wf.run(
            ContractAnalysisWorkflowInput(
                tenant_id="tenant-a",
                contract_payload={"contract_id": "ctr-6"},
                config=_config(),
            )
        )

    assert result["status"] == ocr_status
    assert result["ocr_result"] == child_result
    assert "analysis_result" not in result


@pytest.mark.asyncio
async def test_contract_analysis_workflow_runs_analysis_after_ready_ocr() -> None:
    wf = ContractAnalysisWorkflow()

    async def fake_execute_child_workflow(*args, **kwargs):
        return {"status": "analysis_ready", "manual_review_pages": []}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_contract_analyze_contract":
            return {
                "analysis_status": "completed",
                "contract_id": str(args[0].get("contract_id") or ""),
                "summary": "analysis_ok",
            }
        raise AssertionError(f"Unexpected activity: {fn_name}")

    with (
        patch.object(tw_mod, "execute_child_workflow", side_effect=fake_execute_child_workflow),
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_contract_ocr_workflow")),
    ):
        result = await wf.run(
            ContractAnalysisWorkflowInput(
                tenant_id="tenant-a",
                contract_payload={"contract_id": "ctr-7"},
                config=_config(),
            )
        )

    assert result["status"] == "analysis_ready"
    assert result["analysis_result"]["analysis_status"] == "completed"
