"""Safety & compliance monitor activities.

Deterministic scoped finding generation for safety/compliance queue runs.
Supports:
  - daily trigger
  - regulated_checkout trigger
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from typing import Any

from temporalio import activity

from . import ops_revrec

_DEFAULT_WINDOW_DAYS = 30
_DEFAULT_AGENT_KEY = "safety-compliance-monitor"

_PRIORITY_TO_SEVERITY = {
    "critical": "critical",
    "high": "high",
    "medium": "medium",
    "low": "low",
}


def _get_ops_persistence_client():
    return ops_revrec._get_ops_persistence_client()  # noqa: SLF001


def _coerce_iso_date(value: Any) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def _today_from_run_date(run_date: str | None) -> date:
    parsed = _coerce_iso_date(run_date)
    return parsed or datetime.now(UTC).date()


def _safe_uuid_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _owner_payload(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "role": "safety_compliance_manager",
        "branch_id": _safe_uuid_text(item.get("branch_id")) or None,
        "branch_name": str(item.get("branch_name") or "").strip() or None,
    }


def _priority_rank(item: Mapping[str, Any]) -> int:
    return {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(str(item.get("priority") or "low"), 3)


def _subject_key(item: Mapping[str, Any]) -> str:
    subject_id = _safe_uuid_text(item.get("subject_id"))
    if subject_id:
        return f"person:{subject_id}"
    fallback = str(item.get("subject_name") or "").strip().lower()
    return f"anonymous:{fallback or 'unknown'}"


def _item_finding_for_storage(item: dict[str, Any]) -> dict[str, Any]:
    """Map safety/compliance monitor item fields to generic finding schema."""
    priority = str(item.get("priority") or "medium")
    subject_id = _safe_uuid_text(item.get("subject_id"))
    return {
        **item,
        "contract_id": subject_id or _safe_uuid_text(item.get("tenant_id")) or None,
        "line_item_id": _safe_uuid_text(item.get("line_item_id")) or None,
        "finding_type": str(item.get("finding_type") or "compliance_exception"),
        "severity": _PRIORITY_TO_SEVERITY.get(priority, "medium"),
        "proposed_action": str(item.get("recommended_next_action") or ""),
        "confidence": float(item.get("confidence") or 0.0),
        "expected": {
            "trigger": str(item.get("trigger") or "daily"),
            "subject_key": str(item.get("subject_key") or ""),
            "subject_name": str(item.get("subject_name") or ""),
            "source": str(item.get("source") or ""),
            "source_gap": bool(item.get("source_gap", False)),
            "rule_citation": str(item.get("rule_citation") or ""),
            "owner": _owner_payload(item),
            "recommended_next_action": str(item.get("recommended_next_action") or ""),
            "operating_model_tags": ["safety-compliance-manager:t2", "safety-compliance-manager:t4", "safety-compliance-manager:t7"],
        },
        "evidence": list(item.get("evidence_bundle") or []),
        "billed": {},
        "delta": None,
    }


def _qualification_findings(
    *,
    tenant_id: str,
    trigger: str,
    rows: list[dict[str, Any]],
    today: date,
    subject_filter: set[str] | None,
) -> list[dict[str, Any]]:
    window_end = today + timedelta(days=_DEFAULT_WINDOW_DAYS)
    findings: list[dict[str, Any]] = []
    for row in rows:
        subject_id = _safe_uuid_text(row.get("person_id"))
        if subject_filter is not None and subject_id and subject_id not in subject_filter:
            continue
        status = str(row.get("status") or "").strip().lower()
        expiry = _coerce_iso_date(row.get("expiry_date"))
        is_expired = status in {"expired", "suspended"} or (expiry is not None and expiry < today)
        is_expiring = not is_expired and expiry is not None and expiry <= window_end
        if not is_expired and not is_expiring:
            continue
        finding_type = "expired_qualification" if is_expired else "expiring_qualification"
        priority = "critical" if is_expired else "high"
        qualifier = str(row.get("qualification_type") or "driver qualification").strip()
        findings.append(
            {
                "tenant_id": tenant_id,
                "trigger": trigger,
                "source": "driver_qualification_records",
                "source_gap": False,
                "subject_id": subject_id,
                "subject_name": str(row.get("person_name") or "").strip(),
                "branch_id": _safe_uuid_text(row.get("branch_id")) or None,
                "branch_name": str(row.get("branch_name") or "").strip() or None,
                "finding_type": finding_type,
                "priority": priority,
                "rule_citation": str(row.get("cited_rule") or "49 CFR 391 — Driver Qualification Files"),
                "confidence": 0.93 if is_expired else 0.78,
                "recommended_next_action": (
                    f"Do not dispatch regulated work for {qualifier} until qualification is restored."
                    if is_expired
                    else f"Schedule renewal for {qualifier} before expiry."
                ),
                "evidence_bundle": [
                    f"qualification_type:{qualifier}",
                    f"status:{status or 'unknown'}",
                    f"expiry_date:{expiry.isoformat() if expiry else 'missing'}",
                    f"evidence_ref:{str(row.get('evidence_ref') or '')}",
                ],
            }
        )
    return findings


def _hos_findings(
    *,
    tenant_id: str,
    trigger: str,
    rows: list[dict[str, Any]],
    subject_filter: set[str] | None,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for row in rows:
        subject_id = _safe_uuid_text(row.get("person_id"))
        if subject_filter is not None and subject_id and subject_id not in subject_filter:
            continue
        severity = str(row.get("severity") or "warning").strip().lower()
        priority = "critical" if severity == "critical" else "high"
        violation = str(row.get("violation_type") or "hos_exception").strip()
        findings.append(
            {
                "tenant_id": tenant_id,
                "trigger": trigger,
                "source": "hos_exception_log",
                "source_gap": False,
                "subject_id": subject_id,
                "subject_name": str(row.get("person_name") or "").strip(),
                "branch_id": _safe_uuid_text(row.get("branch_id")) or None,
                "branch_name": str(row.get("branch_name") or "").strip() or None,
                "finding_type": "hos_exception",
                "priority": priority,
                "rule_citation": str(row.get("cited_rule") or "49 CFR 395 — Hours of Service"),
                "confidence": 0.9 if severity == "critical" else 0.74,
                "recommended_next_action": (
                    "Escalate to safety manager and hold regulated dispatch until reviewed."
                    if severity == "critical"
                    else "Review HOS exception and document corrective action."
                ),
                "evidence_bundle": [
                    f"violation_type:{violation}",
                    f"severity:{severity}",
                    f"violation_date:{str(row.get('violation_date') or '')}",
                    f"evidence_ref:{str(row.get('evidence_ref') or '')}",
                ],
            }
        )
    return findings


def _operator_cert_findings(
    *,
    tenant_id: str,
    trigger: str,
    rows: list[dict[str, Any]],
    today: date,
    subject_filter: set[str] | None,
) -> list[dict[str, Any]]:
    window_end = today + timedelta(days=_DEFAULT_WINDOW_DAYS)
    findings: list[dict[str, Any]] = []
    for row in rows:
        subject_id = _safe_uuid_text(row.get("person_id"))
        if subject_filter is not None and subject_id and subject_id not in subject_filter:
            continue
        status = str(row.get("status") or "").strip().lower()
        expiry = _coerce_iso_date(row.get("expiry_date"))
        is_expired = status in {"expired", "suspended"} or (expiry is not None and expiry < today)
        is_expiring = not is_expired and expiry is not None and expiry <= window_end
        if not is_expired and not is_expiring:
            continue
        cert = str(row.get("certification_type") or "operator certification").strip()
        findings.append(
            {
                "tenant_id": tenant_id,
                "trigger": trigger,
                "source": "operator_cert_records",
                "source_gap": False,
                "subject_id": subject_id,
                "subject_name": str(row.get("person_name") or "").strip(),
                "branch_id": _safe_uuid_text(row.get("branch_id")) or None,
                "branch_name": str(row.get("branch_name") or "").strip() or None,
                "finding_type": "expired_operator_certification" if is_expired else "expiring_operator_certification",
                "priority": "critical" if is_expired else "high",
                "rule_citation": str(row.get("cited_rule") or "OSHA 29 CFR 1910.178 / 1926.1427 — Operator Certification"),
                "confidence": 0.92 if is_expired else 0.79,
                "recommended_next_action": (
                    f"Block regulated equipment checkout until {cert} is current."
                    if is_expired
                    else f"Schedule {cert} renewal before expiry."
                ),
                "evidence_bundle": [
                    f"certification_type:{cert}",
                    f"status:{status or 'unknown'}",
                    f"expiry_date:{expiry.isoformat() if expiry else 'missing'}",
                    f"evidence_ref:{str(row.get('evidence_ref') or '')}",
                ],
            }
        )
    return findings


def _training_findings(
    *,
    tenant_id: str,
    trigger: str,
    rows: list[dict[str, Any]],
    today: date,
    subject_filter: set[str] | None,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for row in rows:
        subject_id = _safe_uuid_text(row.get("person_id"))
        if subject_filter is not None and subject_id and subject_id not in subject_filter:
            continue
        status = str(row.get("status") or "").strip().lower()
        due_date = _coerce_iso_date(row.get("due_date"))
        is_overdue = status == "overdue" or (due_date is not None and due_date < today and status not in {"completed", "waived"})
        if not is_overdue:
            continue
        training_type = str(row.get("training_type") or "regulated training").strip()
        findings.append(
            {
                "tenant_id": tenant_id,
                "trigger": trigger,
                "source": "personnel_training_records",
                "source_gap": False,
                "subject_id": subject_id,
                "subject_name": str(row.get("person_name") or "").strip(),
                "branch_id": _safe_uuid_text(row.get("branch_id")) or None,
                "branch_name": str(row.get("branch_name") or "").strip() or None,
                "finding_type": "overdue_training",
                "priority": "high",
                "rule_citation": str(row.get("cited_rule") or "Internal training policy / OSHA recordkeeping"),
                "confidence": 0.82,
                "recommended_next_action": f"Complete {training_type} before next regulated assignment.",
                "evidence_bundle": [
                    f"training_type:{training_type}",
                    f"status:{status or 'unknown'}",
                    f"due_date:{due_date.isoformat() if due_date else 'missing'}",
                    f"evidence_ref:{str(row.get('evidence_ref') or '')}",
                ],
            }
        )
    return findings


def _inspection_findings(
    *,
    tenant_id: str,
    trigger: str,
    rows: list[dict[str, Any]],
    today: date,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for row in rows:
        data = dict(row.get("data") or {}) if isinstance(row.get("data"), Mapping) else {}
        if str(data.get("tenant_id") or "") != tenant_id:
            continue
        status = str(data.get("status") or "").strip().lower()
        if status in {"completed", "approved", "closed", "pass"}:
            continue
        due_date = _coerce_iso_date(data.get("due_date"))
        if due_date is None or due_date >= today:
            continue
        subject_id = _safe_uuid_text(data.get("assignee_person_id")) or _safe_uuid_text(data.get("inspector_person_id"))
        findings.append(
            {
                "tenant_id": tenant_id,
                "trigger": trigger,
                "source": "rental_current_entity_state:inspection",
                "source_gap": False,
                "subject_id": subject_id,
                "subject_name": str(data.get("assignee_name") or data.get("inspector_name") or "").strip(),
                "branch_id": _safe_uuid_text(data.get("branch_id")) or None,
                "branch_name": str(data.get("branch_name") or "").strip() or None,
                "line_item_id": _safe_uuid_text(row.get("entity_id")) or None,
                "finding_type": "overdue_inspection",
                "priority": "critical",
                "rule_citation": str(data.get("cited_rule") or "Pre-rental / return inspection policy"),
                "confidence": 0.87,
                "recommended_next_action": "Complete overdue inspection before regulated checkout.",
                "evidence_bundle": [
                    f"inspection_id:{_safe_uuid_text(row.get('entity_id'))}",
                    f"status:{status or 'unknown'}",
                    f"due_date:{due_date.isoformat()}",
                ],
            }
        )
    return findings


def _regulated_checkout_prerequisite_findings(
    *,
    tenant_id: str,
    trigger: str,
    checkout_subject_ids: list[str],
    qualification_rows: list[dict[str, Any]],
    operator_cert_rows: list[dict[str, Any]],
    today: date,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    active_qualification_subjects: set[str] = set()
    for row in qualification_rows:
        subject_id = _safe_uuid_text(row.get("person_id"))
        if not subject_id:
            continue
        status = str(row.get("status") or "").strip().lower()
        expiry = _coerce_iso_date(row.get("expiry_date"))
        if status in {"active", "expiring"} and (expiry is None or expiry >= today):
            active_qualification_subjects.add(subject_id)
    active_cert_subjects: set[str] = set()
    for row in operator_cert_rows:
        subject_id = _safe_uuid_text(row.get("person_id"))
        if not subject_id:
            continue
        status = str(row.get("status") or "").strip().lower()
        expiry = _coerce_iso_date(row.get("expiry_date"))
        if status in {"active", "expiring"} and (expiry is None or expiry >= today):
            active_cert_subjects.add(subject_id)

    for subject_id in checkout_subject_ids:
        missing: list[str] = []
        if subject_id not in active_qualification_subjects:
            missing.append("driver_qualification")
        if subject_id not in active_cert_subjects:
            missing.append("operator_certification")
        if not missing:
            continue
        findings.append(
            {
                "tenant_id": tenant_id,
                "trigger": trigger,
                "source": "regulated_checkout_prerequisites",
                "source_gap": False,
                "subject_id": subject_id,
                "subject_name": "",
                "finding_type": "missing_regulated_prerequisite",
                "priority": "critical",
                "rule_citation": "Regulated-rental checkout prerequisite policy",
                "confidence": 0.88,
                "recommended_next_action": "Resolve missing prerequisite before checkout.",
                "evidence_bundle": [
                    f"subject_id:{subject_id}",
                    f"missing:{','.join(missing)}",
                ],
            }
        )
    return findings


@activity.defn
def ops_safety_compliance_scope(
    tenant_id: str,
    trigger: str = "daily",
    run_date: str | None = None,
    branch_id: str | None = None,
    checkout_subject_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Scope safety/compliance subjects and emit queue items.

    trigger values:
      - daily
      - regulated_checkout
    """
    trigger_key = (trigger or "daily").strip().lower()
    if trigger_key not in {"daily", "regulated_checkout"}:
        raise ValueError("trigger must be one of: daily, regulated_checkout")

    today = _today_from_run_date(run_date)
    client = _get_ops_persistence_client()
    checkout_subject_ids = [s for s in (checkout_subject_ids or []) if isinstance(s, str) and s.strip()]
    subject_filter = set(checkout_subject_ids) if trigger_key == "regulated_checkout" and checkout_subject_ids else None

    qualification_rows = client.select(
        "driver_qualification_records",
        columns="person_id,person_name,branch_id,branch_name,qualification_type,expiry_date,status,cited_rule,evidence_ref",
        filters={"tenant_id": tenant_id},
        limit=500,
    )
    hos_rows = client.select(
        "hos_exception_log",
        columns="person_id,person_name,branch_id,branch_name,violation_type,violation_date,cited_rule,evidence_ref,severity,resolved_at",
        filters={"tenant_id": tenant_id},
        limit=500,
    )
    hos_rows = [r for r in hos_rows if not r.get("resolved_at")]
    operator_cert_rows = client.select(
        "operator_cert_records",
        columns="person_id,person_name,branch_id,branch_name,certification_type,expiry_date,status,cited_rule,evidence_ref",
        filters={"tenant_id": tenant_id},
        limit=500,
    )
    training_rows = client.select(
        "personnel_training_records",
        columns="person_id,person_name,branch_id,branch_name,training_type,due_date,status,cited_rule,evidence_ref",
        filters={"tenant_id": tenant_id},
        limit=500,
    )
    inspection_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id,data,updated_at",
        filters={"entity_type": "inspection"},
        order_by="updated_at",
        descending=True,
        limit=500,
    )

    scoped: list[dict[str, Any]] = []
    scoped.extend(
        _qualification_findings(
            tenant_id=tenant_id,
            trigger=trigger_key,
            rows=[dict(r) for r in qualification_rows],
            today=today,
            subject_filter=subject_filter,
        )
    )
    scoped.extend(
        _hos_findings(
            tenant_id=tenant_id,
            trigger=trigger_key,
            rows=[dict(r) for r in hos_rows],
            subject_filter=subject_filter,
        )
    )
    scoped.extend(
        _operator_cert_findings(
            tenant_id=tenant_id,
            trigger=trigger_key,
            rows=[dict(r) for r in operator_cert_rows],
            today=today,
            subject_filter=subject_filter,
        )
    )
    scoped.extend(
        _training_findings(
            tenant_id=tenant_id,
            trigger=trigger_key,
            rows=[dict(r) for r in training_rows],
            today=today,
            subject_filter=subject_filter,
        )
    )
    if trigger_key == "daily":
        scoped.extend(
            _inspection_findings(
                tenant_id=tenant_id,
                trigger=trigger_key,
                rows=[dict(r) for r in inspection_rows],
                today=today,
            )
        )

    if trigger_key == "regulated_checkout":
        if not checkout_subject_ids:
            return [
                {
                    "tenant_id": tenant_id,
                    "trigger": trigger_key,
                    "source": "regulated_checkout_subjects",
                    "source_gap": True,
                    "subject_id": tenant_id,
                    "subject_name": "",
                    "finding_type": "source_gap_checkout_subject",
                    "priority": "critical",
                    "rule_citation": "Regulated-rental checkout prerequisite policy",
                    "confidence": 0.98,
                    "recommended_next_action": "Escalate: checkout subject roster is missing; run manual compliance review.",
                    "evidence_bundle": ["missing:checkout_subject_ids"],
                }
            ]
        scoped.extend(
            _regulated_checkout_prerequisite_findings(
                tenant_id=tenant_id,
                trigger=trigger_key,
                checkout_subject_ids=checkout_subject_ids,
                qualification_rows=[dict(r) for r in qualification_rows],
                operator_cert_rows=[dict(r) for r in operator_cert_rows],
                today=today,
            )
        )
        if not qualification_rows and not operator_cert_rows:
            scoped.append(
                {
                    "tenant_id": tenant_id,
                    "trigger": trigger_key,
                    "source": "regulated_checkout_prerequisites",
                    "source_gap": True,
                    "subject_id": tenant_id,
                    "subject_name": "",
                    "finding_type": "source_gap_prerequisite_feed",
                    "priority": "critical",
                    "rule_citation": "Regulated-rental checkout prerequisite policy",
                    "confidence": 0.97,
                    "recommended_next_action": "Escalate: prerequisite feeds unavailable; require human compliance sign-off.",
                    "evidence_bundle": ["missing:driver_qualification_records", "missing:operator_cert_records"],
                }
            )

    # Collapse to one canonical candidate per subject; highest priority wins.
    canonical: dict[str, dict[str, Any]] = {}
    for item in scoped:
        if branch_id and _safe_uuid_text(item.get("branch_id")) not in {"", str(branch_id)}:
            continue
        key = _subject_key(item)
        existing = canonical.get(key)
        if existing is None or _priority_rank(item) < _priority_rank(existing):
            canonical[key] = {
                **item,
                "subject_key": key,
                "owner": _owner_payload(item),
                "fingerprint": f"safety-compliance:{key}",
            }
    return sorted(canonical.values(), key=_priority_rank)


@activity.defn
def ops_safety_compliance_assess(item_payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """Deterministic assessor for scoped compliance items."""
    _ = config  # reserved for thresholds/model controls if needed later
    confidence = float(item_payload.get("confidence") or 0.0)
    if confidence < 0:
        confidence = 0.0
    if confidence > 1:
        confidence = 1.0
    return {
        **item_payload,
        "confidence": confidence,
    }


# ---------------------------------------------------------------------------
# Named wrappers (avoid Temporal activity name collisions)
# ---------------------------------------------------------------------------


@activity.defn(name="ops_safety_compliance_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    try:
        return ops_revrec.ops_load_agent_config(tenant_id, agent_key)
    except Exception:
        return {
            "tenant_id": tenant_id,
            "agent_key": agent_key,
            "enabled": True,
            "bounds": {"max_findings_per_run": 100},
        }


@activity.defn(name="ops_safety_compliance_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_safety_compliance_create_workflow_run")
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_safety_compliance_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


@activity.defn(name="ops_safety_compliance_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    finding.setdefault("agent_key", _DEFAULT_AGENT_KEY)
    return ops_revrec.ops_record_finding(_item_finding_for_storage(finding), run_id)


__all__ = [
    "ops_safety_compliance_scope",
    "ops_safety_compliance_assess",
    "ops_load_agent_config",
    "ops_list_open_finding_fingerprints",
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_record_finding",
]
