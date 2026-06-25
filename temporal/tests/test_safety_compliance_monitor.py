"""Tests for safety/compliance monitor workflow and activities."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from temporal.src.activities import ops_safety_compliance_monitor
from temporal.src.workflows.ops.safety_compliance_monitor import (
    SafetyComplianceMonitorWorkflow,
    SafetyComplianceMonitorWorkflowInput,
)
from temporalio.testing import ActivityEnvironment

_TENANT_ID = "11111111-1111-1111-1111-111111111111"
_SUBJECT_A = "22222222-2222-2222-2222-222222222222"
_SUBJECT_B = "33333333-3333-3333-3333-333333333333"


class _FakeOpsPersistence:
    def __init__(self, tables: dict[str, list[dict]]) -> None:
        self._tables = tables

    def select(self, resource, *, columns="*", filters=None, order_by=None, descending=False, limit=None):
        rows = list(self._tables.get(resource, []))
        for key, value in (filters or {}).items():
            rows = [r for r in rows if r.get(key) == value]
        if limit:
            rows = rows[:limit]
        return rows

    def insert(self, resource, payload):
        return payload

    def upsert(self, resource, payload, *, on_conflict):
        return payload

    def update(self, resource, payload, *, filters):
        return [payload]


@pytest.fixture
def activity_env() -> ActivityEnvironment:
    return ActivityEnvironment()


class TestScopeActivity:
    def test_daily_scope_surfaces_targeted_findings(self, activity_env: ActivityEnvironment) -> None:
        fake = _FakeOpsPersistence(
            {
                "driver_qualification_records": [
                    {
                        "tenant_id": _TENANT_ID,
                        "person_id": _SUBJECT_A,
                        "person_name": "Driver A",
                        "status": "expired",
                        "qualification_type": "CDL",
                        "expiry_date": "2026-01-01",
                        "cited_rule": "49 CFR 391",
                        "evidence_ref": "qual-1",
                    },
                    {
                        "tenant_id": _TENANT_ID,
                        "person_id": _SUBJECT_B,
                        "person_name": "Driver B",
                        "status": "active",
                        "qualification_type": "CDL",
                        "expiry_date": "2027-01-01",
                    },
                ],
                "hos_exception_log": [
                    {
                        "tenant_id": _TENANT_ID,
                        "person_id": _SUBJECT_B,
                        "person_name": "Driver B",
                        "severity": "critical",
                        "violation_type": "over_hours",
                        "resolved_at": None,
                        "cited_rule": "49 CFR 395",
                    }
                ],
                "operator_cert_records": [],
                "personnel_training_records": [],
                "rental_current_entity_state": [],
            }
        )

        with patch("temporal.src.activities.ops_safety_compliance_monitor._get_ops_persistence_client", return_value=fake):
            rows = activity_env.run(
                ops_safety_compliance_monitor.ops_safety_compliance_scope,
                _TENANT_ID,
                "daily",
                "2026-06-19",
                None,
                [],
            )

        assert len(rows) == 2
        finding_types = {r["finding_type"] for r in rows}
        assert "expired_qualification" in finding_types
        assert "hos_exception" in finding_types
        for row in rows:
            assert row["rule_citation"]
            assert isinstance(row["confidence"], float)
            assert row["evidence_bundle"]
            assert row["recommended_next_action"]

    def test_regulated_checkout_scopes_source_gap_when_subjects_missing(self, activity_env: ActivityEnvironment) -> None:
        fake = _FakeOpsPersistence(
            {
                "driver_qualification_records": [],
                "hos_exception_log": [],
                "operator_cert_records": [],
                "personnel_training_records": [],
                "rental_current_entity_state": [],
            }
        )
        with patch("temporal.src.activities.ops_safety_compliance_monitor._get_ops_persistence_client", return_value=fake):
            rows = activity_env.run(
                ops_safety_compliance_monitor.ops_safety_compliance_scope,
                _TENANT_ID,
                "regulated_checkout",
                "2026-06-19",
                None,
                [],
            )
        assert len(rows) == 1
        assert rows[0]["source_gap"] is True
        assert rows[0]["finding_type"] == "source_gap_checkout_subject"


class TestWorkflow:
    @pytest.mark.asyncio
    async def test_no_op_when_scope_returns_empty(self) -> None:
        wf = SafetyComplianceMonitorWorkflow()
        inp = SafetyComplianceMonitorWorkflowInput(tenant_id=_TENANT_ID, trigger="daily")
        call_seq = iter(
            [
                {"run_id": "run-noop"},
                {"bounds": {"max_findings_per_run": 50}},
                [],
                True,
            ]
        )

        async def fake_execute(fn, args=None, **kwargs):
            return next(call_seq)

        with patch("temporalio.workflow.execute_activity", side_effect=fake_execute):
            result = await wf.run(inp)
        assert result["no_op"] is True
        assert result["status"] == "no_op"

    @pytest.mark.asyncio
    async def test_dedupe_skips_existing_fingerprint(self) -> None:
        wf = SafetyComplianceMonitorWorkflow()
        inp = SafetyComplianceMonitorWorkflowInput(tenant_id=_TENANT_ID, trigger="daily")
        scoped = [
            {
                "tenant_id": _TENANT_ID,
                "subject_key": f"person:{_SUBJECT_A}",
                "subject_id": _SUBJECT_A,
                "finding_type": "hos_exception",
                "priority": "critical",
                "fingerprint": f"safety-compliance:person:{_SUBJECT_A}",
                "rule_citation": "49 CFR 395",
                "confidence": 0.9,
                "evidence_bundle": ["x"],
                "recommended_next_action": "review",
            }
        ]
        call_seq = iter(
            [
                {"run_id": "run-dedup"},
                {"bounds": {"max_findings_per_run": 50}},
                scoped,
                [f"safety-compliance:person:{_SUBJECT_A}"],
                scoped[0],
                True,
            ]
        )

        async def fake_execute(fn, args=None, **kwargs):
            return next(call_seq)

        with patch("temporalio.workflow.execute_activity", side_effect=fake_execute):
            result = await wf.run(inp)
        assert result["deduped_findings"] == 1
        assert result["recorded_findings"] == 0

    @pytest.mark.asyncio
    async def test_supersede_collapses_to_single_subject_thread(self) -> None:
        wf = SafetyComplianceMonitorWorkflow()
        inp = SafetyComplianceMonitorWorkflowInput(tenant_id=_TENANT_ID, trigger="daily")

        scoped = [
            {
                "tenant_id": _TENANT_ID,
                "subject_key": f"person:{_SUBJECT_A}",
                "subject_id": _SUBJECT_A,
                "finding_type": "expiring_operator_certification",
                "priority": "high",
                "fingerprint": f"safety-compliance:person:{_SUBJECT_A}",
                "rule_citation": "OSHA",
                "confidence": 0.8,
                "evidence_bundle": ["x"],
                "recommended_next_action": "renew",
            },
            {
                "tenant_id": _TENANT_ID,
                "subject_key": f"person:{_SUBJECT_A}",
                "subject_id": _SUBJECT_A,
                "finding_type": "hos_exception",
                "priority": "critical",
                "fingerprint": f"safety-compliance:person:{_SUBJECT_A}",
                "rule_citation": "49 CFR 395",
                "confidence": 0.9,
                "evidence_bundle": ["y"],
                "recommended_next_action": "hold dispatch",
            },
        ]

        recorded: list[dict] = []

        async def fake_execute(fn, args=None, **kwargs):
            name = getattr(fn, "__name__", str(fn))
            if "create_workflow_run" in name:
                return {"run_id": "run-supersede"}
            if "load_agent_config" in name:
                return {"bounds": {"max_findings_per_run": 50}}
            if "scope" in name:
                return scoped
            if "list_open" in name:
                return []
            if "assess" in name:
                return (args or [{}])[0]
            if "record_finding" in name:
                recorded.append((args or [{}])[0])
                return {"finding_id": "f-1"}
            if "finalize" in name:
                return True
            return {}

        with patch("temporalio.workflow.execute_activity", side_effect=fake_execute):
            result = await wf.run(inp)

        assert result["superseded_findings"] == 1
        assert result["recorded_findings"] == 1
        assert len(recorded) == 1
        assert recorded[0]["finding_type"] == "hos_exception"

    @pytest.mark.asyncio
    async def test_records_new_finding_when_fingerprint_is_fresh(self) -> None:
        wf = SafetyComplianceMonitorWorkflow()
        inp = SafetyComplianceMonitorWorkflowInput(tenant_id=_TENANT_ID, trigger="daily")
        scoped_item = {
            "tenant_id": _TENANT_ID,
            "subject_key": f"person:{_SUBJECT_B}",
            "subject_id": _SUBJECT_B,
            "finding_type": "overdue_training",
            "priority": "high",
            "fingerprint": f"safety-compliance:person:{_SUBJECT_B}",
            "rule_citation": "Internal training policy",
            "confidence": 0.82,
            "evidence_bundle": ["training overdue"],
            "recommended_next_action": "Complete training",
        }
        recorded: list[dict] = []

        async def fake_execute(fn, args=None, **kwargs):
            name = getattr(fn, "__name__", str(fn))
            if "create_workflow_run" in name:
                return {"run_id": "run-record"}
            if "load_agent_config" in name:
                return {"bounds": {"max_findings_per_run": 50}}
            if "scope" in name:
                return [scoped_item]
            if "list_open" in name:
                return []
            if "assess" in name:
                return (args or [{}])[0]
            if "record_finding" in name:
                recorded.append((args or [{}])[0])
                return {"finding_id": "f-2"}
            if "finalize" in name:
                return True
            return {}

        with patch("temporalio.workflow.execute_activity", side_effect=fake_execute):
            result = await wf.run(inp)

        assert result["recorded_findings"] == 1
        assert result["deduped_findings"] == 0
        assert len(recorded) == 1
