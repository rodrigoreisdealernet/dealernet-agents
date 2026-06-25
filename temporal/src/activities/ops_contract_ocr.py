from __future__ import annotations

from typing import Any

from temporalio import activity

_DEFAULT_MIN_CONFIDENCE_TO_ANALYZE = 0.85


def _as_float(value: Any, *, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _manual_review_entry(page_payload: dict[str, Any], *, fallback_page_number: int) -> dict[str, Any]:
    confidence = _as_float(page_payload.get("confidence"), default=0.0)
    raw_status = str(page_payload.get("status") or "").strip().lower()
    reason = str(page_payload.get("reason") or "").strip()
    page_status = raw_status or "manual_review_required"
    if not reason:
        reason = "manual_review_required"
    return {
        "page_number": int(page_payload.get("page_number") or fallback_page_number),
        "confidence": confidence,
        "status": page_status,
        "reason": reason,
    }


@activity.defn
def ops_contract_ocr_revalidate_pages(
    contract_payload: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any]:
    if bool(contract_payload.get("ocr_blocked")):
        return {
            "status": "blocked",
            "manual_review_pages": [],
            "reason": str(contract_payload.get("blocked_reason") or "ocr_blocked"),
        }

    thresholds = config.get("thresholds") or {}
    min_confidence_to_analyze = _as_float(
        thresholds.get("min_confidence_to_analyze"),
        default=_DEFAULT_MIN_CONFIDENCE_TO_ANALYZE,
    )

    manual_review_pages: list[dict[str, Any]] = []
    for idx, page in enumerate(contract_payload.get("pages") or []):
        if not isinstance(page, dict):
            continue
        confidence = _as_float(page.get("confidence"), default=0.0)
        status = str(page.get("status") or "").strip().lower()
        disputed = bool(page.get("is_disputed"))

        if status in {"blocked", "error", "unreadable"}:
            manual_review_pages.append(
                _manual_review_entry(
                    page,
                    fallback_page_number=idx + 1,
                )
            )
            return {
                "status": "blocked",
                "manual_review_pages": manual_review_pages,
                "reason": str(page.get("reason") or status or "blocked_page"),
            }

        needs_manual_review = disputed or status == "manual_review_required" or confidence < min_confidence_to_analyze
        if needs_manual_review:
            review_page = dict(page)
            if disputed and not review_page.get("status"):
                review_page["status"] = "disputed"
            if confidence < min_confidence_to_analyze and not review_page.get("reason"):
                review_page["reason"] = "low_confidence"
            manual_review_pages.append(
                _manual_review_entry(
                    review_page,
                    fallback_page_number=idx + 1,
                )
            )

    if manual_review_pages:
        return {
            "status": "manual_review_required",
            "manual_review_pages": manual_review_pages,
        }

    return {
        "status": "analysis_ready",
        "manual_review_pages": [],
    }


@activity.defn
def ops_contract_analyze_contract(contract_payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "analysis_status": "completed",
        "contract_id": str(contract_payload.get("contract_id") or ""),
        "summary": str(contract_payload.get("analysis_summary") or "contract_analysis_completed"),
    }
