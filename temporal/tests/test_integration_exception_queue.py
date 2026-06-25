"""Tests for the integration and master-data exception queue workflow, activities,
and agent.

Coverage:
- Queue ranking: critical > high > medium > low
- Exception type classification: portal_exception, logistics_exception, master_data_drift
- No-op state: empty scoped exceptions returns status='no_op' without recording findings
- Freshness / stale detection: _is_stale / _is_stale_days returns True for old or absent timestamps
- Duplicate-collapse / dedup: sibling signals with the same connector+scope collapse into
  one canonical thread; existing fingerprints are skipped on re-run
- Recommendation rendering: assessed threads carry recommended_action + evidence
- Operating-model tag threading: t5/t6/t7 tags injected by agent wrapper
- Review signal: informational only, no data or status change
- _exception_finding_for_storage: maps exception fields onto generic finding schema
- IntegrationExceptionThreadV1: model validation
"""
from __future__ import annotations

import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from temporal.src.activities import ops_integration_exception
from temporal.src.agents.integration_exception_assistant import (
    OM_TAG_LOGISTICS_EXCEPTION,
    OM_TAG_MASTER_DATA_DRIFT,
    OM_TAG_PORTAL_EXCEPTION,
    IntegrationExceptionThreadV1,
    integration_exception_thread_v1_schema,
    run_integration_exception_assistant,
)
from temporal.src.workflows.ops.integration_exception_queue import (
    IntegrationExceptionQueueWorkflow,
    IntegrationExceptionQueueWorkflowInput,
    ReviewExceptionThreadSignal,
)
from temporalio.testing import ActivityEnvironment

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TENANT_ID = "tenant-integration-test"
_EXCEPTION_ID = "exc-portal-001"
_CONNECTOR_KEY = "portal_sync"

_NOW = datetime.datetime(2026, 6, 15, 12, 0, 0, tzinfo=datetime.UTC)
_OLD_HOURS = datetime.datetime(2026, 6, 15, 2, 0, 0, tzinfo=datetime.UTC)
_OLD_DAYS = datetime.datetime(2026, 4, 1, 0, 0, 0, tzinfo=datetime.UTC)


def _default_config(**overrides) -> dict:
    base = {
        "auto_apply": False,
        "thresholds": {},
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 1},
        "system_prompt": "x",
        "user_prompt_template": "x",
        "tools": [],
    }
    base.update(overrides)
    return base


def _make_exception(
    exception_id: str = _EXCEPTION_ID,
    exception_type: str = "portal_exception",
    priority: str = "high",
    source_connector: str = _CONNECTOR_KEY,
) -> dict:
    return {
        "tenant_id": _TENANT_ID,
        "exception_id": exception_id,
        "exception_type": exception_type,
        "source_connector": source_connector,
        "scope_key": "order_sync",
        "entity_type": "rental_order",
        "affected_entity_id": "entity-001",
        "affected_workflow_id": "wf-001",
        "failure_status": "retryable_failure",
        "attempt_count": 3,
        "http_status": 503,
        "error_message": "Gateway timeout",
        "error_samples": ["Gateway timeout"],
        "duplicate_signal_count": 0,
        "last_updated_at": _NOW.isoformat(),
        "is_stale_hint": False,
        "rental_data": {"entities": [], "relationships": [], "facts": [], "time_series": [], "telematics": []},
    }


def _make_assessment(
    exception_id: str = _EXCEPTION_ID,
    exception_type: str = "portal_exception",
    priority: str = "high",
    source_connector: str = _CONNECTOR_KEY,
    is_stale: bool = False,
) -> dict:
    return {
        "exception_id": exception_id,
        "exception_type": exception_type,
        "priority": priority,
        "title": "Portal sync failure",
        "summary": "Customer portal order-sync is failing with 503 errors.",
        "affected_workflows": ["order_sync", "availability_check"],
        "likely_root_cause": "Downstream portal service unavailable.",
        "recommended_action": "Check portal service health dashboard and contact Wynne support.",
        "evidence": ["503 Gateway Timeout on order_sync endpoint", "3 retries exhausted"],
        "duplicate_signal_count": 0,
        "source_connector": source_connector,
        "tenant_id": _TENANT_ID,
        "freshness_note": "Data from last 8 hours.",
        "confidence": 0.82,
        "rationale": "High retry count and HTTP 503 indicate external service degradation.",
        "is_stale_data": is_stale,
        "stale_signals": ["Delivery log updated 9 hours ago"] if is_stale else [],
        "operating_model_tags": [],
    }


# ---------------------------------------------------------------------------
# Unit: freshness / stale detection
# ---------------------------------------------------------------------------

class TestIsStale:
    def test_none_timestamp_is_stale(self) -> None:
        assert ops_integration_exception._is_stale(None)

    def test_empty_string_is_stale(self) -> None:
        assert ops_integration_exception._is_stale("")

    def test_old_timestamp_is_stale(self) -> None:
        old = (_NOW - datetime.timedelta(hours=10)).isoformat()
        assert ops_integration_exception._is_stale(old, threshold_hours=8)

    def test_fresh_timestamp_is_not_stale(self) -> None:
        fresh = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=2)).isoformat()
        assert not ops_integration_exception._is_stale(fresh, threshold_hours=8)

    def test_invalid_string_is_stale(self) -> None:
        assert ops_integration_exception._is_stale("not-a-date")


class TestIsStale_Days:
    def test_none_timestamp_is_stale(self) -> None:
        assert ops_integration_exception._is_stale_days(None)

    def test_old_timestamp_is_stale(self) -> None:
        old = (_NOW - datetime.timedelta(days=40)).isoformat()
        assert ops_integration_exception._is_stale_days(old, threshold_days=30)

    def test_recent_timestamp_is_not_stale(self) -> None:
        fresh = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=10)).isoformat()
        assert not ops_integration_exception._is_stale_days(fresh, threshold_days=30)


# ---------------------------------------------------------------------------
# Unit: exception type classification
# ---------------------------------------------------------------------------

class TestClassifyExceptionType:
    def test_portal_connector_classified_as_portal(self) -> None:
        assert ops_integration_exception._classify_exception_type("portal_sync") == "portal_exception"

    def test_customer_portal_connector_classified_as_portal(self) -> None:
        assert ops_integration_exception._classify_exception_type("customer_portal_v2") == "portal_exception"

    def test_descartes_classified_as_logistics(self) -> None:
        assert ops_integration_exception._classify_exception_type("descartes") == "logistics_exception"

    def test_samsara_classified_as_logistics(self) -> None:
        assert ops_integration_exception._classify_exception_type("samsara_telematics") == "logistics_exception"

    def test_logistics_classified_as_logistics(self) -> None:
        assert ops_integration_exception._classify_exception_type("logistics_mobile") == "logistics_exception"

    def test_unknown_connector_falls_back_to_master_data(self) -> None:
        assert ops_integration_exception._classify_exception_type("erp_billing") == "master_data_drift"

    def test_portal_takes_priority_over_logistics(self) -> None:
        # If a connector key contains both portal and logistics terms, portal wins.
        assert ops_integration_exception._classify_exception_type("portal_dispatch_sync") == "portal_exception"


# ---------------------------------------------------------------------------
# Unit: _exception_finding_for_storage mapping
# ---------------------------------------------------------------------------

class TestExceptionFindingForStorage:
    def test_maps_exception_id_to_contract_id(self) -> None:
        exc = _make_assessment(exception_id="exc-abc")
        stored = ops_integration_exception._exception_finding_for_storage(exc)
        assert stored["contract_id"] == "exc-abc"

    def test_maps_source_connector_to_line_item_id(self) -> None:
        exc = _make_assessment(source_connector="descartes")
        stored = ops_integration_exception._exception_finding_for_storage(exc)
        assert stored["line_item_id"] == "descartes"

    def test_finding_type_is_exception_type(self) -> None:
        exc = _make_assessment(exception_type="logistics_exception")
        stored = ops_integration_exception._exception_finding_for_storage(exc)
        assert stored["finding_type"] == "logistics_exception"

    def test_severity_maps_from_priority(self) -> None:
        for priority, expected_severity in [
            ("critical", "critical"),
            ("high", "high"),
            ("medium", "medium"),
            ("low", "low"),
        ]:
            exc = _make_assessment(priority=priority)
            stored = ops_integration_exception._exception_finding_for_storage(exc)
            assert stored["severity"] == expected_severity, f"priority={priority}"

    def test_expected_contains_stale_signals(self) -> None:
        exc = _make_assessment(is_stale=True)
        stored = ops_integration_exception._exception_finding_for_storage(exc)
        assert stored["expected"]["is_stale_data"] is True
        assert stored["expected"]["stale_signals"] == ["Delivery log updated 9 hours ago"]

    def test_expected_contains_operating_model_tags(self) -> None:
        exc = _make_assessment(exception_type="portal_exception")
        exc["operating_model_tags"] = [OM_TAG_PORTAL_EXCEPTION]
        stored = ops_integration_exception._exception_finding_for_storage(exc)
        assert OM_TAG_PORTAL_EXCEPTION in stored["expected"]["operating_model_tags"]

    def test_expected_contains_affected_workflows_and_root_cause(self) -> None:
        exc = _make_assessment()
        stored = ops_integration_exception._exception_finding_for_storage(exc)
        assert stored["expected"]["affected_workflows"] == ["order_sync", "availability_check"]
        assert stored["expected"]["likely_root_cause"] == "Downstream portal service unavailable."


# ---------------------------------------------------------------------------
# Unit: IntegrationExceptionThreadV1 model validation
# ---------------------------------------------------------------------------

class TestIntegrationExceptionThreadV1:
    def test_valid_portal_exception(self) -> None:
        thread = IntegrationExceptionThreadV1(
            exception_id=_EXCEPTION_ID,
            exception_type="portal_exception",
            priority="high",
            likely_root_cause="Portal service degraded.",
            recommended_action="Check portal health dashboard.",
            rationale="3 retries failed with 503.",
        )
        assert thread.exception_type == "portal_exception"
        assert thread.priority == "high"
        assert thread.is_stale_data is False
        assert thread.operating_model_tags == []

    def test_valid_logistics_exception(self) -> None:
        thread = IntegrationExceptionThreadV1(
            exception_id="exc-logistics-001",
            exception_type="logistics_exception",
            priority="critical",
            likely_root_cause="Descartes route sync quarantined.",
            recommended_action="Review quarantine queue in Descartes admin.",
            rationale="Quarantine flag set, route delivery blocked.",
        )
        assert thread.exception_type == "logistics_exception"

    def test_valid_master_data_drift(self) -> None:
        thread = IntegrationExceptionThreadV1(
            exception_id="exc-drift-001",
            exception_type="master_data_drift",
            priority="medium",
            likely_root_cause="Asset records not updated in 45 days.",
            recommended_action="Audit asset master data and trigger refresh.",
            rationale="Stale records may block availability checks.",
        )
        assert thread.exception_type == "master_data_drift"

    def test_invalid_exception_type_raises(self) -> None:
        with pytest.raises(ValueError):
            IntegrationExceptionThreadV1(
                exception_id=_EXCEPTION_ID,
                exception_type="unknown_type",
                priority="high",
                likely_root_cause="x",
                recommended_action="x",
                rationale="x",
            )

    def test_invalid_priority_raises(self) -> None:
        with pytest.raises(ValueError):
            IntegrationExceptionThreadV1(
                exception_id=_EXCEPTION_ID,
                exception_type="portal_exception",
                priority="urgent",
                likely_root_cause="x",
                recommended_action="x",
                rationale="x",
            )

    def test_schema_is_json_serialisable(self) -> None:
        schema = integration_exception_thread_v1_schema()
        assert isinstance(schema, dict)
        assert schema.get("type") == "object"

    def test_all_exception_types_are_valid(self) -> None:
        for et in ("portal_exception", "logistics_exception", "master_data_drift"):
            thread = IntegrationExceptionThreadV1(
                exception_id=f"exc-{et}",
                exception_type=et,
                priority="medium",
                likely_root_cause="x",
                recommended_action="x",
                rationale="x",
            )
            assert thread.exception_type == et


# ---------------------------------------------------------------------------
# Unit: operating-model tag injection in agent wrapper
# ---------------------------------------------------------------------------

class TestOperatingModelTags:
    @pytest.mark.asyncio
    async def test_portal_exception_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = IntegrationExceptionThreadV1(
            exception_id=_EXCEPTION_ID,
            exception_type="portal_exception",
            priority="high",
            likely_root_cause="Portal service degraded.",
            recommended_action="Check portal health dashboard.",
            rationale="3 retries failed with 503.",
        )
        with patch(
            "temporal.src.agents.integration_exception_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_integration_exception_assistant(
                {"exception_id": _EXCEPTION_ID, "exception_type": "portal_exception"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_PORTAL_EXCEPTION in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_logistics_exception_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = IntegrationExceptionThreadV1(
            exception_id="exc-log-001",
            exception_type="logistics_exception",
            priority="critical",
            likely_root_cause="Descartes route sync failed.",
            recommended_action="Review Descartes sync quarantine queue.",
            rationale="Quarantine flag set.",
        )
        with patch(
            "temporal.src.agents.integration_exception_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_integration_exception_assistant(
                {"exception_id": "exc-log-001", "exception_type": "logistics_exception"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_LOGISTICS_EXCEPTION in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_master_data_drift_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = IntegrationExceptionThreadV1(
            exception_id="exc-drift-001",
            exception_type="master_data_drift",
            priority="medium",
            likely_root_cause="Asset master data stale.",
            recommended_action="Trigger master data refresh.",
            rationale="No updates in 45 days.",
        )
        with patch(
            "temporal.src.agents.integration_exception_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_integration_exception_assistant(
                {"exception_id": "exc-drift-001", "exception_type": "master_data_drift"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_MASTER_DATA_DRIFT in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_existing_tag_not_duplicated(self) -> None:
        mock_result = MagicMock()
        mock_result.response = IntegrationExceptionThreadV1(
            exception_id=_EXCEPTION_ID,
            exception_type="portal_exception",
            priority="high",
            likely_root_cause="Portal down.",
            recommended_action="Check portal.",
            rationale="Errors.",
            operating_model_tags=[OM_TAG_PORTAL_EXCEPTION],
        )
        with patch(
            "temporal.src.agents.integration_exception_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_integration_exception_assistant(
                {"exception_id": _EXCEPTION_ID, "exception_type": "portal_exception"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert result["operating_model_tags"].count(OM_TAG_PORTAL_EXCEPTION) == 1


# ---------------------------------------------------------------------------
# Workflow helpers
# ---------------------------------------------------------------------------

def _build_workflow_harness(
    *,
    config: dict,
    scoped_exceptions: list[dict],
    assessments: list[dict],
    existing_fingerprints: list[str] | None = None,
):
    state: dict = {
        "recorded_findings": [],
        "finalized": None,
    }
    existing = existing_fingerprints or []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            return {"run_id": "run-integration-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1] if len(args) > 1 else {}
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_integration_exception_scope":
            return scoped_exceptions
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_integration_exception_assess":
            exc_payload = args[0]
            exc_id = str(exc_payload.get("exception_id") or "")
            return next(
                (a for a in assessments if str(a.get("exception_id") or "") == exc_id),
                _make_assessment(exception_id=exc_id),
            )
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0] if args else {})
            return {"id": "finding-1"}
        return None

    return state, fake_execute_activity


async def _run_workflow_with_mocks(
    wf: IntegrationExceptionQueueWorkflow,
    inp: IntegrationExceptionQueueWorkflowInput,
    fake_execute,
) -> dict:
    with (
        patch("temporalio.workflow.execute_activity", side_effect=fake_execute),
        patch("temporalio.workflow.now", return_value=_NOW),
    ):
        return await wf.run(inp)


# ---------------------------------------------------------------------------
# Workflow: no-op state
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflow_no_op_when_no_scoped_exceptions() -> None:
    """Workflow returns status='no_op' when there are no new signals."""
    config = _default_config()
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_exceptions=[],
        assessments=[],
    )
    wf = IntegrationExceptionQueueWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        IntegrationExceptionQueueWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert result["status"] == "no_op"
    assert result["no_op"] is True
    assert state["recorded_findings"] == []


# ---------------------------------------------------------------------------
# Workflow: records findings for scoped exceptions
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflow_records_threads_when_scoped() -> None:
    """Workflow records findings for each assessed exception thread."""
    config = _default_config()
    exceptions = [
        _make_exception(),
        _make_exception(exception_id="exc-log-001", exception_type="logistics_exception", source_connector="descartes"),
    ]
    assessments = [
        _make_assessment(exception_id=_EXCEPTION_ID, priority="high"),
        _make_assessment(exception_id="exc-log-001", exception_type="logistics_exception", priority="critical", source_connector="descartes"),
    ]
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_exceptions=exceptions,
        assessments=assessments,
    )
    wf = IntegrationExceptionQueueWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        IntegrationExceptionQueueWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert result["status"] == "succeeded"
    assert result["recorded_threads"] == 2
    assert result["no_op"] is False


# ---------------------------------------------------------------------------
# Workflow: deduplication against existing open findings
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflow_deduplicates_existing_fingerprints() -> None:
    """Exception threads whose fingerprints already exist are counted as deduped."""
    config = _default_config()
    exceptions = [_make_exception()]
    assessments = [_make_assessment(exception_id=_EXCEPTION_ID, priority="high")]
    fingerprint = f"integration-exception:portal_exception:{_CONNECTOR_KEY}:{_EXCEPTION_ID}"
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_exceptions=exceptions,
        assessments=assessments,
        existing_fingerprints=[fingerprint],
    )
    wf = IntegrationExceptionQueueWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        IntegrationExceptionQueueWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert result["deduped_threads"] == 1
    assert result["recorded_threads"] == 0


# ---------------------------------------------------------------------------
# Workflow: priority ranking
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflow_ranks_critical_first() -> None:
    """Critical exception threads must be recorded before lower-priority ones."""
    config = _default_config()
    exceptions = [
        _make_exception(exception_id="exc-low"),
        _make_exception(exception_id="exc-crit", exception_type="logistics_exception", source_connector="descartes"),
    ]
    assessments = [
        _make_assessment(exception_id="exc-low", priority="low"),
        _make_assessment(exception_id="exc-crit", exception_type="logistics_exception", priority="critical", source_connector="descartes"),
    ]
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_exceptions=exceptions,
        assessments=assessments,
    )
    wf = IntegrationExceptionQueueWorkflow()
    await _run_workflow_with_mocks(
        wf,
        IntegrationExceptionQueueWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert len(state["recorded_findings"]) == 2
    first = state["recorded_findings"][0]
    assert str(first.get("exception_id") or "") == "exc-crit"


# ---------------------------------------------------------------------------
# Workflow signal: review_exception_thread
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_review_signal_is_informational_only() -> None:
    """Review signal stores decision without triggering any finding mutation."""
    wf = IntegrationExceptionQueueWorkflow()
    sig = ReviewExceptionThreadSignal(
        exception_id=_EXCEPTION_ID,
        exception_type="portal_exception",
        reviewer_id="admin-1",
        decision="routed",
        fingerprint=f"integration-exception:portal_exception:{_CONNECTOR_KEY}:{_EXCEPTION_ID}",
        note="Escalated to Wynne support team.",
    )
    await wf.review_exception_thread(sig)
    key = f"integration-exception:portal_exception:{_CONNECTOR_KEY}:{_EXCEPTION_ID}"
    assert key in wf._reviews
    review = wf._reviews[key]
    assert review["reviewer_id"] == "admin-1"
    assert review["decision"] == "routed"
    assert review["reviewed"] is True
    assert review["note"] == "Escalated to Wynne support team."


@pytest.mark.asyncio
async def test_review_signal_without_fingerprint_uses_default_key() -> None:
    """Review signal without fingerprint falls back to exception_id:exception_type key."""
    wf = IntegrationExceptionQueueWorkflow()
    sig = ReviewExceptionThreadSignal(
        exception_id=_EXCEPTION_ID,
        exception_type="master_data_drift",
        reviewer_id="admin-2",
        decision="needs_more_info",
    )
    await wf.review_exception_thread(sig)
    key = f"{_EXCEPTION_ID}:master_data_drift"
    assert key in wf._reviews
    assert wf._reviews[key]["reviewer_id"] == "admin-2"


# ---------------------------------------------------------------------------
# Activity: ops_integration_exception_scope with mock persistence
# ---------------------------------------------------------------------------

class _FakeOpsPersistence:
    def __init__(self, tables: dict) -> None:
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
        return payload


def _make_delivery_log_row(
    id: str = "dl-001",
    connector_key: str = "portal_sync",
    status: str = "retryable_failure",
    updated_at: str | None = None,
    tenant_id: str = _TENANT_ID,
) -> dict:
    return {
        "id": id,
        "integration_id": "int-001",
        "tenant_id": tenant_id,
        "connector_key": connector_key,
        "exchange_key": "order_exchange",
        "direction": "outbound",
        "scope_key": "order_sync",
        "entity_type": "rental_order",
        "entity_id": "entity-001",
        "workflow_id": "wf-001",
        "status": status,
        "attempt_count": 3,
        "http_status": 503,
        "error_message": "Gateway timeout",
        "last_error": "Gateway timeout",
        "received_at": (_NOW - datetime.timedelta(hours=1)).isoformat(),
        "delivered_at": None,
        "created_at": (_NOW - datetime.timedelta(hours=2)).isoformat(),
        "updated_at": updated_at or _NOW.isoformat(),
    }


def _make_descartes_row(
    id: str = "ds-001",
    sync_status: str = "retryable_failure",
    scope: str = "route",
    updated_at: str | None = None,
    tenant_id: str = _TENANT_ID,
) -> dict:
    return {
        "id": id,
        "tenant_id": tenant_id,
        "provider_key": "descartes",
        "scope": scope,
        "contract_line_id": "line-001",
        "route_id": "route-001",
        "source_event_id": "event-001",
        "sync_status": sync_status,
        "retry_count": 2,
        "is_retryable": True,
        "error_code": "ERR_ROUTE_NOT_FOUND",
        "error_message": "Route not found in Descartes",
        "quarantine_reason": None,
        "occurred_at": (_NOW - datetime.timedelta(hours=1)).isoformat(),
        "updated_at": updated_at or _NOW.isoformat(),
    }


def _make_entity_row(
    entity_id: str = "entity-asset-001",
    entity_type: str = "asset",
    updated_at: str | None = None,
    tenant_id: str = _TENANT_ID,
) -> dict:
    return {
        "entity_id": entity_id,
        "entity_type": entity_type,
        "name": f"Asset {entity_id}",
        "data": {"tenant_id": tenant_id, "name": f"Asset {entity_id}"},
        "updated_at": updated_at or _OLD_DAYS.isoformat(),
    }


class TestScopeActivity:
    def test_portal_failure_is_scoped(self) -> None:
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": [_make_delivery_log_row(connector_key="portal_sync")],
            "descartes_sync_delivery": [],
            "rental_current_entity_state": [],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert len(result) == 1
        assert result[0]["exception_type"] == "portal_exception"
        assert result[0]["source_connector"] == "portal_sync"

    def test_successful_delivery_not_scoped(self) -> None:
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": [_make_delivery_log_row(status="succeeded")],
            "descartes_sync_delivery": [],
            "rental_current_entity_state": [],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert result == []

    def test_descartes_failure_is_scoped_as_logistics(self) -> None:
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": [],
            "descartes_sync_delivery": [_make_descartes_row()],
            "rental_current_entity_state": [],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert len(result) == 1
        assert result[0]["exception_type"] == "logistics_exception"
        assert result[0]["source_connector"] == "descartes"

    def test_stale_master_data_entity_is_scoped(self) -> None:
        stale_ts = (_NOW - datetime.timedelta(days=45)).isoformat()
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": [],
            "descartes_sync_delivery": [],
            "rental_current_entity_state": [_make_entity_row(updated_at=stale_ts)],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert len(result) == 1
        assert result[0]["exception_type"] == "master_data_drift"

    def test_fresh_master_data_entity_not_scoped(self) -> None:
        fresh_ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=5)).isoformat()
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": [],
            "descartes_sync_delivery": [],
            "rental_current_entity_state": [_make_entity_row(updated_at=fresh_ts)],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert result == []

    def test_non_master_data_entity_type_not_scoped(self) -> None:
        stale_ts = (_NOW - datetime.timedelta(days=45)).isoformat()
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": [],
            "descartes_sync_delivery": [],
            "rental_current_entity_state": [_make_entity_row(entity_type="rental_contract", updated_at=stale_ts)],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert result == []

    def test_duplicate_delivery_failures_collapse_into_one_thread(self) -> None:
        """Two failures with the same connector+scope collapse into one canonical thread."""
        rows = [
            _make_delivery_log_row(id="dl-001", connector_key="portal_sync"),
            _make_delivery_log_row(id="dl-002", connector_key="portal_sync"),
        ]
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": rows,
            "descartes_sync_delivery": [],
            "rental_current_entity_state": [],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert len(result) == 1
        assert result[0]["duplicate_signal_count"] == 1

    def test_different_connectors_produce_separate_threads(self) -> None:
        rows = [
            _make_delivery_log_row(id="dl-001", connector_key="portal_sync"),
            _make_delivery_log_row(id="dl-002", connector_key="descartes"),
        ]
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": rows,
            "descartes_sync_delivery": [],
            "rental_current_entity_state": [],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert len(result) == 2

    def test_wrong_tenant_id_filtered_out(self) -> None:
        row = _make_delivery_log_row(tenant_id="other-tenant")
        fake_db = _FakeOpsPersistence({
            "integration_delivery_log": [row],
            "descartes_sync_delivery": [],
            "rental_current_entity_state": [],
        })
        with patch.object(ops_integration_exception.ops_revrec, "_get_ops_persistence_client", return_value=fake_db):
            env = ActivityEnvironment()
            result = env.run(ops_integration_exception.ops_integration_exception_scope, _TENANT_ID, None)
        assert result == []


# ---------------------------------------------------------------------------
# Activity: ops_integration_exception_assess (smoke test)
# ---------------------------------------------------------------------------

class TestAssessActivity:
    @pytest.mark.asyncio
    async def test_assess_carries_through_exception_fields(self) -> None:
        """assess activity carries through exception_id and exception_type."""
        assessment = _make_assessment(exception_id=_EXCEPTION_ID, exception_type="portal_exception")

        with patch(
            "temporal.src.activities.ops_integration_exception.run_integration_exception_assistant",
            new=AsyncMock(return_value=assessment),
        ):
            env = ActivityEnvironment()
            result = await env.run(
                ops_integration_exception.ops_integration_exception_assess,
                _make_exception(),
                _default_config(),
            )
        assert result["exception_id"] == _EXCEPTION_ID
        assert result["exception_type"] == "portal_exception"
        assert result["tenant_id"] == _TENANT_ID

    @pytest.mark.asyncio
    async def test_assess_sets_tenant_id_from_payload(self) -> None:
        assessment = _make_assessment()

        with patch(
            "temporal.src.activities.ops_integration_exception.run_integration_exception_assistant",
            new=AsyncMock(return_value=assessment),
        ):
            env = ActivityEnvironment()
            result = await env.run(
                ops_integration_exception.ops_integration_exception_assess,
                _make_exception(),
                _default_config(),
            )
        assert result["tenant_id"] == _TENANT_ID


# ---------------------------------------------------------------------------
# Integration: all three signal types traceable through the queue
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_portal_logistics_and_master_data_signals_all_recorded() -> None:
    """Portal, logistics, and master-data signals all flow through and are recorded."""
    config = _default_config()
    exceptions = [
        _make_exception(exception_id="exc-portal", exception_type="portal_exception", source_connector="portal_sync"),
        _make_exception(exception_id="exc-logistics", exception_type="logistics_exception", source_connector="descartes"),
        _make_exception(exception_id="exc-drift", exception_type="master_data_drift", source_connector="master_data"),
    ]
    assessments = [
        _make_assessment(exception_id="exc-portal", exception_type="portal_exception", source_connector="portal_sync"),
        _make_assessment(exception_id="exc-logistics", exception_type="logistics_exception", source_connector="descartes"),
        _make_assessment(exception_id="exc-drift", exception_type="master_data_drift", source_connector="master_data"),
    ]
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_exceptions=exceptions,
        assessments=assessments,
    )
    wf = IntegrationExceptionQueueWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        IntegrationExceptionQueueWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert result["recorded_threads"] == 3
    types_recorded = {str(f.get("exception_type") or "") for f in state["recorded_findings"]}
    assert "portal_exception" in types_recorded
    assert "logistics_exception" in types_recorded
    assert "master_data_drift" in types_recorded
