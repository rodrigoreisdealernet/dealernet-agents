"""Tests for preventative-maintenance trigger evaluation and PM evaluator workflow.

Coverage:
- Meter trigger: due when reading >= threshold
- Meter trigger: pre_due within lead window
- Meter trigger: not due below threshold
- Meter trigger: sparse-data safety (no reading → not due)
- Rental-count trigger: due at threshold
- Rental-count trigger: pre_due within lead window
- Time-interval trigger: due when elapsed >= interval_days
- Time-interval trigger: pre_due within lead window
- Time-interval trigger: uses asset creation date when no prior maintenance
- Idempotency: duplicate fingerprint → work order skipped
- Category policy applied when no asset override (fingerprint includes policy_id)
- Time-interval fingerprint derived from evaluation_timestamp, not wall clock
- PMEvaluatorWorkflow: creates work orders for due policies
- PMEvaluatorWorkflow: empty policy list returns zero summary
- Behavioral: activities query the data store (fail if stubs remain)
"""
from __future__ import annotations

import asyncio
import datetime
from unittest.mock import MagicMock, patch

import pytest
from temporal.src.activities import ops_pm
from temporal.src.activities import rental_operations as rental_activities
from temporal.src.models.rental import PMEvaluatorInput, PMTriggerType
from temporal.src.workflows.ops.pm_evaluator import PMEvaluatorWorkflow
from temporalio.testing import ActivityEnvironment

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ASSET_ID = "asset-pm-001"
_POLICY_ID = "policy-pm-001"
_TENANT_ID = "tenant-pm-test"

_NOW = datetime.datetime(2026, 6, 10, 12, 0, 0, tzinfo=datetime.UTC)
_NOW_ISO = _NOW.isoformat()

_ASSET_CREATED = datetime.datetime(2026, 1, 1, 0, 0, 0, tzinfo=datetime.UTC)
_ASSET_CREATED_ISO = _ASSET_CREATED.isoformat()


def _meter_policy(threshold: float, lead_window_days: int = 0) -> dict:
    return {
        "policy_id": _POLICY_ID,
        "asset_id": _ASSET_ID,
        "trigger_type": PMTriggerType.METER,
        "threshold": threshold,
        "interval_days": None,
        "lead_window_days": lead_window_days,
        "label": "500-hour oil change",
    }


def _count_policy(threshold: float, lead_window_days: int = 0) -> dict:
    return {
        "policy_id": _POLICY_ID,
        "asset_id": _ASSET_ID,
        "trigger_type": PMTriggerType.RENTAL_COUNT,
        "threshold": threshold,
        "interval_days": None,
        "lead_window_days": lead_window_days,
        "label": "every 10 rentals",
    }


def _time_policy(interval_days: int, lead_window_days: int = 0) -> dict:
    return {
        "policy_id": _POLICY_ID,
        "asset_id": _ASSET_ID,
        "trigger_type": PMTriggerType.TIME_INTERVAL,
        "threshold": None,
        "interval_days": interval_days,
        "lead_window_days": lead_window_days,
        "label": "90-day service",
    }


def _asset_ctx(
    meter: float | None = None,
    count: int = 0,
    last_maint: str | None = None,
    created: str = _ASSET_CREATED_ISO,
) -> dict:
    return {
        "latest_meter_value": meter,
        "rental_completion_count": count,
        "last_maintenance_at": last_maint,
        "asset_created_at": created,
    }


@pytest.fixture
def activity_env() -> ActivityEnvironment:
    return ActivityEnvironment()


# ---------------------------------------------------------------------------
# Meter trigger tests
# ---------------------------------------------------------------------------

class TestMeterTrigger:
    def test_due_at_threshold(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0),
            _asset_ctx(meter=500.0),
            _NOW_ISO,
        )
        assert result["is_due"] is True
        assert result["is_pre_due"] is False
        assert "500" in result["fingerprint"]

    def test_due_above_threshold(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0),
            _asset_ctx(meter=620.0),
            _NOW_ISO,
        )
        assert result["is_due"] is True

    def test_not_due_below_threshold(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0),
            _asset_ctx(meter=300.0),
            _NOW_ISO,
        )
        assert result["is_due"] is False
        assert result["is_pre_due"] is False

    def test_pre_due_within_lead_window(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0, lead_window_days=50),
            _asset_ctx(meter=460.0),
            _NOW_ISO,
        )
        assert result["is_due"] is False
        assert result["is_pre_due"] is True

    def test_sparse_data_no_reading_is_not_due(self, activity_env):
        """Absence of a meter reading must NOT create a false positive."""
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0),
            _asset_ctx(meter=None),
            _NOW_ISO,
        )
        assert result["is_due"] is False
        assert result["is_pre_due"] is False
        assert "no meter reading" in (result["reason"] or "")

    def test_no_threshold_configured(self, activity_env):
        policy = _meter_policy(500.0)
        policy["threshold"] = None
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            policy,
            _asset_ctx(meter=600.0),
            _NOW_ISO,
        )
        assert result["is_due"] is False
        assert "no threshold" in (result["reason"] or "")


# ---------------------------------------------------------------------------
# Rental-count trigger tests
# ---------------------------------------------------------------------------

class TestRentalCountTrigger:
    def test_due_at_threshold(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _count_policy(10.0),
            _asset_ctx(count=10),
            _NOW_ISO,
        )
        assert result["is_due"] is True
        assert result["is_pre_due"] is False

    def test_due_above_threshold(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _count_policy(10.0),
            _asset_ctx(count=13),
            _NOW_ISO,
        )
        assert result["is_due"] is True

    def test_not_due_below_threshold(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _count_policy(10.0),
            _asset_ctx(count=7),
            _NOW_ISO,
        )
        assert result["is_due"] is False
        assert result["is_pre_due"] is False

    def test_pre_due_within_lead_window(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _count_policy(10.0, lead_window_days=3),
            _asset_ctx(count=8),
            _NOW_ISO,
        )
        assert result["is_due"] is False
        assert result["is_pre_due"] is True

    def test_zero_rentals_not_due(self, activity_env):
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _count_policy(10.0),
            _asset_ctx(count=0),
            _NOW_ISO,
        )
        assert result["is_due"] is False

    def test_fingerprint_advances_at_second_threshold_band(self, activity_env):
        """Second 10-rental band should produce a different fingerprint."""
        r1 = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _count_policy(10.0),
            _asset_ctx(count=10),
            _NOW_ISO,
        )
        r2 = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _count_policy(10.0),
            _asset_ctx(count=20),
            _NOW_ISO,
        )
        assert r1["fingerprint"] != r2["fingerprint"]


# ---------------------------------------------------------------------------
# Time-interval trigger tests
# ---------------------------------------------------------------------------

class TestTimeIntervalTrigger:
    def _eval(self, activity_env, interval_days, last_maint, lead_window_days=0):
        return activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _time_policy(interval_days, lead_window_days),
            _asset_ctx(last_maint=last_maint, created=_ASSET_CREATED_ISO),
            _NOW_ISO,
        )

    def test_due_when_elapsed_equals_interval(self, activity_env):
        # 160 days ago, interval = 160 days → due
        baseline = _NOW - datetime.timedelta(days=160)
        result = self._eval(activity_env, 160, baseline.isoformat())
        assert result["is_due"] is True
        assert result["is_pre_due"] is False

    def test_due_when_elapsed_exceeds_interval(self, activity_env):
        baseline = _NOW - datetime.timedelta(days=200)
        result = self._eval(activity_env, 90, baseline.isoformat())
        assert result["is_due"] is True

    def test_not_due_when_elapsed_less_than_interval(self, activity_env):
        baseline = _NOW - datetime.timedelta(days=30)
        result = self._eval(activity_env, 90, baseline.isoformat())
        assert result["is_due"] is False
        assert result["is_pre_due"] is False

    def test_pre_due_within_lead_window(self, activity_env):
        # 85 days elapsed, interval=90, lead=10 → in lead window
        baseline = _NOW - datetime.timedelta(days=85)
        result = self._eval(activity_env, 90, baseline.isoformat(), lead_window_days=10)
        assert result["is_due"] is False
        assert result["is_pre_due"] is True

    def test_uses_asset_created_when_no_prior_maintenance(self, activity_env):
        # _ASSET_CREATED is 2026-01-01; _NOW is 2026-06-10 → 160 days elapsed
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _time_policy(90),
            _asset_ctx(last_maint=None, created=_ASSET_CREATED_ISO),
            _NOW_ISO,
        )
        assert result["is_due"] is True  # 160 > 90

    def test_no_interval_configured(self, activity_env):
        policy = _time_policy(90)
        policy["interval_days"] = None
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            policy,
            _asset_ctx(),
            _NOW_ISO,
        )
        assert result["is_due"] is False
        assert "no interval_days" in (result["reason"] or "")


# ---------------------------------------------------------------------------
# Idempotency tests
# ---------------------------------------------------------------------------

class TestPMIdempotency:
    def test_same_policy_same_reading_same_fingerprint(self, activity_env):
        """Repeated evaluation with identical inputs must produce the same fingerprint."""
        r1 = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0),
            _asset_ctx(meter=510.0),
            _NOW_ISO,
        )
        r2 = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0),
            _asset_ctx(meter=560.0),
            _NOW_ISO,
        )
        # Both are in the same threshold band (first crossing of 500)
        assert r1["fingerprint"] == r2["fingerprint"]

    def test_meter_fingerprint_advances_at_second_band(self, activity_env):
        """Meter at 1000h and 500h (threshold=500) must yield different fingerprints.

        This test fails with the old constant-fingerprint implementation that
        ignores the current meter value when building the key.
        """
        r_first = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0),
            _asset_ctx(meter=510.0),
            _NOW_ISO,
        )
        r_second = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _meter_policy(500.0),
            _asset_ctx(meter=1010.0),
            _NOW_ISO,
        )
        assert r_first["fingerprint"] != r_second["fingerprint"], (
            "Meter fingerprint must advance when the asset crosses the next "
            "threshold band; check _meter_fingerprint uses floor(meter/threshold)*threshold"
        )

    def test_work_order_id_stable_for_same_fingerprint(self, activity_env):
        mock_client = MagicMock()
        mock_client.upsert.return_value = {"id": "wo-stable", "status": "open"}
        fingerprint = "pm:asset-1:policy-1:meter:500"
        evaluation = {
            "policy_id": "policy-1",
            "asset_id": "asset-1",
            "trigger_type": PMTriggerType.METER,
            "is_due": True,
            "is_pre_due": False,
            "fingerprint": fingerprint,
            "reason": "meter 510 >= threshold 500",
            "tenant_id": _TENANT_ID,
        }
        with patch("temporal.src.activities.ops_pm._get_ops_persistence_client", return_value=mock_client):
            r1 = activity_env.run(ops_pm.pm_upsert_work_order, evaluation, "run-1")
            r2 = activity_env.run(ops_pm.pm_upsert_work_order, evaluation, "run-2")
        assert r1["work_order_id"] == r2["work_order_id"]

    def test_different_policies_different_fingerprints(self, activity_env):
        """Distinct policy IDs must produce distinct fingerprints for the same asset."""
        policy_a = _meter_policy(500.0)
        policy_b = {**_meter_policy(500.0), "policy_id": "policy-pm-002"}
        r_a = activity_env.run(
            ops_pm.pm_evaluate_trigger, policy_a, _asset_ctx(meter=510.0), _NOW_ISO
        )
        r_b = activity_env.run(
            ops_pm.pm_evaluate_trigger, policy_b, _asset_ctx(meter=510.0), _NOW_ISO
        )
        assert r_a["fingerprint"] != r_b["fingerprint"]


# ---------------------------------------------------------------------------
# PMEvaluatorWorkflow tests
# ---------------------------------------------------------------------------

class TestPMEvaluatorWorkflow:
    """Workflow-level tests using fake activity dispatchers (no Temporal server)."""

    def _build_harness(
        self,
        *,
        policies: list[dict],
        evaluations_by_idx: dict[int, dict] | None = None,
        existing_fingerprints: list[str] | None = None,
    ):
        """Build a fake ``workflow.execute_activity`` dispatcher."""
        state: dict = {
            "work_orders": [],
            "finalized": None,
        }
        evaluations_by_idx = evaluations_by_idx or {}
        existing = set(existing_fingerprints or [])

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            args[0] if args else None

            if fn_name == "pm_scope_enabled_policies":
                return policies
            if fn_name == "pm_list_open_wo_fingerprints":
                return list(existing)
            if fn_name == "pm_evaluate_trigger":
                policy = args[0] if args else {}
                idx = policies.index(policy) if policy in policies else 0
                return evaluations_by_idx.get(
                    idx,
                    {
                        "policy_id": policy.get("policy_id", ""),
                        "asset_id": policy.get("asset_id", ""),
                        "trigger_type": policy.get("trigger_type", ""),
                        "is_due": False,
                        "is_pre_due": False,
                        "fingerprint": f"fp:{idx}",
                        "reason": None,
                    },
                )
            if fn_name == "pm_upsert_work_order":
                evaluation = args[0] if args else {}
                wo = {"work_order_id": f"wo-{len(state['work_orders'])}", **evaluation}
                state["work_orders"].append(wo)
                return wo
            raise AssertionError(f"Unexpected activity: {fn_name}")

        async def fake_gather(*coros):
            return [await c for c in coros]

        return state, fake_execute_activity, fake_gather

    def _run_workflow(self, inp: PMEvaluatorInput, fake_execute_activity, fake_gather):
        wf = PMEvaluatorWorkflow()
        with (
            patch("temporalio.workflow.execute_activity", side_effect=fake_execute_activity),
            patch("asyncio.gather", side_effect=fake_gather),
            patch(
                "temporalio.workflow.now",
                return_value=_NOW,
            ),
        ):
            return asyncio.new_event_loop().run_until_complete(wf.run(inp))

    def test_empty_policies_returns_zero_summary(self):
        state, fake_exec, fake_gather = self._build_harness(policies=[])
        result = self._run_workflow(
            PMEvaluatorInput(tenant_id=_TENANT_ID),
            fake_exec,
            fake_gather,
        )
        assert result["total_policies_scoped"] == 0
        assert result["work_orders_created"] == 0
        assert result["status"] == "succeeded"

    def test_due_policy_creates_work_order(self):
        policy = _meter_policy(500.0)
        evaluation = {
            "policy_id": _POLICY_ID,
            "asset_id": _ASSET_ID,
            "trigger_type": PMTriggerType.METER,
            "is_due": True,
            "is_pre_due": False,
            "fingerprint": "fp:0",
            "reason": "meter 510 >= threshold 500",
        }
        state, fake_exec, fake_gather = self._build_harness(
            policies=[policy],
            evaluations_by_idx={0: evaluation},
        )
        result = self._run_workflow(
            PMEvaluatorInput(tenant_id=_TENANT_ID),
            fake_exec,
            fake_gather,
        )
        assert result["work_orders_created"] == 1
        assert result["due_count"] == 1
        assert len(state["work_orders"]) == 1

    def test_duplicate_fingerprint_skipped(self):
        policy = _meter_policy(500.0)
        evaluation = {
            "policy_id": _POLICY_ID,
            "asset_id": _ASSET_ID,
            "trigger_type": PMTriggerType.METER,
            "is_due": True,
            "is_pre_due": False,
            "fingerprint": "fp:already-open",
            "reason": "meter 510 >= threshold 500",
        }
        state, fake_exec, fake_gather = self._build_harness(
            policies=[policy],
            evaluations_by_idx={0: evaluation},
            existing_fingerprints=["fp:already-open"],  # already open
        )
        result = self._run_workflow(
            PMEvaluatorInput(tenant_id=_TENANT_ID),
            fake_exec,
            fake_gather,
        )
        assert result["work_orders_created"] == 0
        assert result["work_orders_skipped_duplicate"] == 1
        assert len(state["work_orders"]) == 0

    def test_pre_due_policy_does_not_create_work_order(self):
        policy = _meter_policy(500.0, lead_window_days=50)
        evaluation = {
            "policy_id": _POLICY_ID,
            "asset_id": _ASSET_ID,
            "trigger_type": PMTriggerType.METER,
            "is_due": False,
            "is_pre_due": True,
            "fingerprint": "fp:pre",
            "reason": "meter 460 within lead window",
        }
        state, fake_exec, fake_gather = self._build_harness(
            policies=[policy],
            evaluations_by_idx={0: evaluation},
        )
        result = self._run_workflow(
            PMEvaluatorInput(tenant_id=_TENANT_ID),
            fake_exec,
            fake_gather,
        )
        assert result["work_orders_created"] == 0
        assert result["pre_due_count"] == 1
        assert len(state["work_orders"]) == 0

    def test_multiple_policies_some_due_some_not(self):
        policies = [_meter_policy(500.0), _count_policy(10.0), _time_policy(90)]
        evaluations = {
            0: {"policy_id": "p0", "asset_id": _ASSET_ID, "trigger_type": PMTriggerType.METER,
                "is_due": True, "is_pre_due": False, "fingerprint": "fp:0", "reason": None},
            1: {"policy_id": "p1", "asset_id": _ASSET_ID, "trigger_type": PMTriggerType.RENTAL_COUNT,
                "is_due": False, "is_pre_due": False, "fingerprint": "fp:1", "reason": None},
            2: {"policy_id": "p2", "asset_id": _ASSET_ID, "trigger_type": PMTriggerType.TIME_INTERVAL,
                "is_due": True, "is_pre_due": False, "fingerprint": "fp:2", "reason": None},
        }
        state, fake_exec, fake_gather = self._build_harness(
            policies=policies, evaluations_by_idx=evaluations
        )
        result = self._run_workflow(
            PMEvaluatorInput(tenant_id=_TENANT_ID),
            fake_exec,
            fake_gather,
        )
        assert result["total_policies_scoped"] == 3
        assert result["due_count"] == 2
        assert result["work_orders_created"] == 2


# ---------------------------------------------------------------------------
# Time-interval fingerprint stability tests
# ---------------------------------------------------------------------------

class TestTimeIntervalFingerprintStability:
    """Verify fingerprint is derived from evaluation_timestamp, not wall clock.

    If the implementation uses datetime.now() instead of eval_now these tests
    will fail because both calls happen within milliseconds of each other on
    the wall clock yet represent different logical times.
    """

    def test_fingerprint_differs_across_interval_windows(self, activity_env):
        """Two eval timestamps in different interval windows must yield different fingerprints.

        baseline = _ASSET_CREATED (2026-01-01)
        - eval at baseline + 80 days: elapsed=80, window=0 (80//90)
        - eval at baseline + 180 days (_NOW): elapsed=160, window=1 (160//90)
        → different fingerprints.

        With a buggy wall-clock implementation, both calls run at approximately
        the real current time, producing the same window and the same fingerprint.
        """
        early_eval = (_ASSET_CREATED + datetime.timedelta(days=80)).isoformat()

        r_early = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _time_policy(90),
            _asset_ctx(last_maint=None, created=_ASSET_CREATED_ISO),
            early_eval,
        )
        r_now = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _time_policy(90),
            _asset_ctx(last_maint=None, created=_ASSET_CREATED_ISO),
            _NOW_ISO,
        )

        assert r_early["fingerprint"] != r_now["fingerprint"], (
            "Fingerprints must differ across interval windows; "
            "check that _time_interval_fingerprint uses eval_now not datetime.now()"
        )

    def test_fingerprint_stable_within_same_window(self, activity_env):
        """Two eval timestamps inside the same window must yield the same fingerprint."""
        # Both 95 and 100 days elapsed fall in window 1 (90–180 days)
        eval_95 = (_ASSET_CREATED + datetime.timedelta(days=95)).isoformat()
        eval_100 = (_ASSET_CREATED + datetime.timedelta(days=100)).isoformat()

        r1 = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _time_policy(90),
            _asset_ctx(last_maint=None, created=_ASSET_CREATED_ISO),
            eval_95,
        )
        r2 = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            _time_policy(90),
            _asset_ctx(last_maint=None, created=_ASSET_CREATED_ISO),
            eval_100,
        )

        assert r1["fingerprint"] == r2["fingerprint"]


# ---------------------------------------------------------------------------
# Behavioral tests: activities must query the data store
# ---------------------------------------------------------------------------

class TestPMActivitiesDataStoreIntegration:
    """These tests fail if any of the three key activities remain stubs.

    Each test patches _get_ops_persistence_client and asserts the mock was
    called with the expected resource name and arguments.  A stub that returns
    [] or a hard-coded result without touching the client will cause these
    assertions to fail.
    """

    def test_pm_scope_enabled_policies_queries_policy_view(self, activity_env):
        """pm_scope_enabled_policies must SELECT from v_pm_policy_effective."""
        mock_client = MagicMock()
        # Return one tenant asset and one policy so the activity doesn't short-circuit.
        mock_client.select.side_effect = lambda resource, **kw: {
            "rental_current_entity_state": [
                {
                    "entity_id": _ASSET_ID,
                    "data": {"tenant_id": _TENANT_ID},
                    "created_at": _ASSET_CREATED_ISO,
                }
            ],
            "v_pm_policy_effective": [
                {
                    "policy_id": _POLICY_ID,
                    "asset_id": _ASSET_ID,
                    "trigger_type": PMTriggerType.METER,
                    "threshold": 500.0,
                    "interval_days": None,
                    "lead_window_days": 0,
                    "label": "test",
                }
            ],
            "v_asset_latest_meter": [],
            "v_asset_rental_completion_count": [],
            "fact_types": [],
        }.get(resource, [])

        with patch("temporal.src.activities.ops_pm._get_ops_persistence_client", return_value=mock_client):
            result = activity_env.run(ops_pm.pm_scope_enabled_policies, _TENANT_ID)

        # The client must have been called; a stub that ignores the client would not call select.
        assert mock_client.select.called, (
            "pm_scope_enabled_policies did not call select on the data store — "
            "the stub implementation must be replaced with a real DB query"
        )
        queried_resources = {c.args[0] for c in mock_client.select.call_args_list}
        assert "v_pm_policy_effective" in queried_resources, (
            "pm_scope_enabled_policies must query v_pm_policy_effective"
        )
        # Result should contain the policy returned by the mock
        assert len(result) == 1
        assert result[0]["policy_id"] == _POLICY_ID
        assert result[0]["tenant_id"] == _TENANT_ID

    def test_pm_list_open_wo_fingerprints_queries_work_orders_table(self, activity_env):
        """pm_list_open_wo_fingerprints must SELECT from pm_work_orders."""
        mock_client = MagicMock()
        mock_client.select.return_value = [{"fingerprint": "fp:existing"}]

        with patch("temporal.src.activities.ops_pm._get_ops_persistence_client", return_value=mock_client):
            result = activity_env.run(ops_pm.pm_list_open_wo_fingerprints, _TENANT_ID)

        mock_client.select.assert_called_once_with(
            "pm_work_orders",
            columns="fingerprint",
            filters={"tenant_id": _TENANT_ID, "status": "open"},
        )
        assert result == ["fp:existing"]

    def test_pm_upsert_work_order_writes_to_pm_work_orders(self, activity_env):
        """pm_upsert_work_order must UPSERT into pm_work_orders."""
        mock_client = MagicMock()
        mock_client.upsert.return_value = {
            "id": "wo-uuid",
            "status": "open",
            "fingerprint": "fp:test",
        }
        evaluation = {
            "policy_id": _POLICY_ID,
            "asset_id": _ASSET_ID,
            "trigger_type": PMTriggerType.METER,
            "is_due": True,
            "is_pre_due": False,
            "fingerprint": "fp:test",
            "reason": "meter >= threshold",
            "tenant_id": _TENANT_ID,
        }

        with patch("temporal.src.activities.ops_pm._get_ops_persistence_client", return_value=mock_client):
            result = activity_env.run(ops_pm.pm_upsert_work_order, evaluation, "run-1")

        # upsert must be called with pm_work_orders
        mock_client.upsert.assert_called_once()
        upsert_args, upsert_kwargs = mock_client.upsert.call_args
        assert upsert_args[0] == "pm_work_orders", (
            "pm_upsert_work_order must write to pm_work_orders table — "
            "the stub implementation must be replaced with a real DB upsert"
        )
        payload = upsert_args[1]
        assert payload["fingerprint"] == "fp:test"
        assert payload["tenant_id"] == _TENANT_ID
        assert payload["maintenance_type"] == "preventive"
        assert payload["status"] == "open"
        assert upsert_kwargs.get("on_conflict") == "tenant_id,fingerprint"

        # Result carries a deterministic work_order_id
        assert result["work_order_id"] is not None
        assert result["fingerprint"] == "fp:test"
        assert result["maintenance_type"] == "preventive"

    def test_pm_upsert_work_order_raises_without_tenant_id(self, activity_env):
        """pm_upsert_work_order must raise ValueError when tenant_id is missing."""
        evaluation = {
            "policy_id": _POLICY_ID,
            "asset_id": _ASSET_ID,
            "trigger_type": PMTriggerType.METER,
            "fingerprint": "fp:no-tenant",
            "reason": None,
            # tenant_id intentionally omitted
        }
        with pytest.raises(ValueError, match="tenant_id is required"):
            activity_env.run(ops_pm.pm_upsert_work_order, evaluation, "run-1")

    def test_pm_evaluate_trigger_passes_tenant_id_through(self, activity_env):
        """pm_evaluate_trigger must carry tenant_id from policy into the result dict."""
        policy = {**_meter_policy(500.0), "tenant_id": _TENANT_ID}
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            policy,
            _asset_ctx(meter=510.0),
            _NOW_ISO,
        )
        assert result["tenant_id"] == _TENANT_ID

    def test_pm_record_rental_completion_writes_tsp(self, activity_env):
        """pm_record_rental_completion must upsert a time_series_points row."""
        mock_client = MagicMock()
        mock_client.select.return_value = [{"id": "fact-type-uuid"}]
        mock_client.upsert.return_value = {"id": "tsp-row-uuid"}

        with patch("temporal.src.activities.ops_pm._get_ops_persistence_client", return_value=mock_client):
            result = activity_env.run(
                ops_pm.pm_record_rental_completion,
                _ASSET_ID,
                "contract-line-001",
            )

        assert result is True
        mock_client.select.assert_called_once_with(
            "fact_types",
            columns="id",
            filters={"key": "asset_rental_completion"},
            limit=1,
        )
        mock_client.upsert.assert_called_once()
        upsert_args, upsert_kwargs = mock_client.upsert.call_args
        assert upsert_args[0] == "time_series_points", (
            "pm_record_rental_completion must write to time_series_points"
        )
        payload = upsert_args[1]
        assert payload["entity_id"] == _ASSET_ID
        assert payload["fact_type_id"] == "fact-type-uuid"
        # source_id is the cross-path dedup key used by both this activity
        # (Temporal path) and the DB trigger (direct RPC path).
        assert payload["source_id"] == "contract-line-001", (
            "pm_record_rental_completion must set source_id=contract_line_id "
            "to share a deduplication key with the entity_versions DB trigger"
        )
        assert payload["data_payload"] == {"count": 1}, (
            "time_series_points uses data_payload (jsonb), not numeric_value"
        )
        assert upsert_kwargs.get("on_conflict") == "entity_id,source_id"

    def test_pm_record_rental_completion_idempotent(self, activity_env):
        """Calling with the same inputs must produce the same TSP source_id (retry safety)."""
        mock_client = MagicMock()
        mock_client.select.return_value = [{"id": "fact-type-uuid"}]
        mock_client.upsert.return_value = {"id": "tsp-row-uuid"}

        with patch("temporal.src.activities.ops_pm._get_ops_persistence_client", return_value=mock_client):
            activity_env.run(ops_pm.pm_record_rental_completion, _ASSET_ID, "cl-001")
            activity_env.run(ops_pm.pm_record_rental_completion, _ASSET_ID, "cl-001")

        # Both calls must produce the same source_id so the DB unique index
        # (entity_id, source_id) ensures only one row is written.
        calls = mock_client.upsert.call_args_list
        src_first = calls[0][0][1]["source_id"]
        src_second = calls[1][0][1]["source_id"]
        assert src_first == src_second, (
            "pm_record_rental_completion must derive a stable source_id from "
            "contract_line_id so retries do not create duplicate rows"
        )
        assert src_first == "cl-001"

    def test_pm_record_rental_completion_returns_false_when_fact_type_missing(self, activity_env):
        """Returns False gracefully when asset_rental_completion fact type not found."""
        mock_client = MagicMock()
        mock_client.select.return_value = []  # fact type not found

        with patch("temporal.src.activities.ops_pm._get_ops_persistence_client", return_value=mock_client):
            result = activity_env.run(
                ops_pm.pm_record_rental_completion, _ASSET_ID, "cl-001"
            )

        assert result is False
        mock_client.upsert.assert_not_called()


# ---------------------------------------------------------------------------
# record_asset_downtime behavioral tests
# ---------------------------------------------------------------------------

class TestRecordAssetDowntime:
    """Behavioral tests for record_asset_downtime.

    These tests fail if the activity remains a stub that does not write to the
    data store.  They also verify that a completed maintenance event produces a
    TSP row that resets the time-interval baseline for the asset.
    """

    _MAINT_ID = "maint-record-001"

    def test_writes_asset_downtime_tsp_row(self, activity_env):
        """record_asset_downtime must upsert an asset_downtime time_series_points row."""
        mock_client = MagicMock()
        mock_client.select.return_value = [{"id": "fact-type-downtime-uuid"}]
        mock_client.upsert.return_value = {"id": "tsp-downtime-uuid"}

        with patch(
            "temporal.src.activities.rental_operations._get_rental_operations_persistence_client",
            return_value=mock_client,
        ):
            result = activity_env.run(
                rental_activities.record_asset_downtime,
                _ASSET_ID,
                self._MAINT_ID,
                120.0,
            )

        assert result is True, (
            "record_asset_downtime returned False — either the activity is still stubbed "
            "or the 'asset_downtime' fact type was not found"
        )
        mock_client.select.assert_called_once_with(
            "fact_types",
            columns="id",
            filters={"key": "asset_downtime"},
            limit=1,
        )
        mock_client.upsert.assert_called_once()
        upsert_args, upsert_kwargs = mock_client.upsert.call_args
        assert upsert_args[0] == "time_series_points", (
            "record_asset_downtime must write to time_series_points"
        )
        payload = upsert_args[1]
        assert payload["entity_id"] == _ASSET_ID
        assert payload["fact_type_id"] == "fact-type-downtime-uuid"
        assert payload["data_payload"]["downtime_minutes"] == 120.0
        assert payload["data_payload"]["maintenance_record_id"] == self._MAINT_ID
        # source_id = maintenance_record_id ensures idempotency across retries
        assert payload["source_id"] == self._MAINT_ID
        assert upsert_kwargs.get("on_conflict") == "entity_id,source_id"

    def test_idempotent_across_retries(self, activity_env):
        """Retrying with the same inputs must produce the same source_id."""
        mock_client = MagicMock()
        mock_client.select.return_value = [{"id": "fact-type-downtime-uuid"}]
        mock_client.upsert.return_value = {"id": "tsp-downtime-uuid"}

        with patch(
            "temporal.src.activities.rental_operations._get_rental_operations_persistence_client",
            return_value=mock_client,
        ):
            activity_env.run(
                rental_activities.record_asset_downtime, _ASSET_ID, self._MAINT_ID, 90.0
            )
            activity_env.run(
                rental_activities.record_asset_downtime, _ASSET_ID, self._MAINT_ID, 90.0
            )

        calls = mock_client.upsert.call_args_list
        src_first = calls[0][0][1]["source_id"]
        src_second = calls[1][0][1]["source_id"]
        assert src_first == src_second == self._MAINT_ID

    def test_returns_false_when_fact_type_missing(self, activity_env):
        """Returns False gracefully when asset_downtime fact type not found in DB."""
        mock_client = MagicMock()
        mock_client.select.return_value = []

        with patch(
            "temporal.src.activities.rental_operations._get_rental_operations_persistence_client",
            return_value=mock_client,
        ):
            result = activity_env.run(
                rental_activities.record_asset_downtime,
                _ASSET_ID,
                self._MAINT_ID,
                60.0,
            )

        assert result is False
        mock_client.upsert.assert_not_called()

    def test_downtime_write_clears_time_interval_due(self, activity_env):
        """A completed maintenance write should reset the PM evaluator baseline.

        Simulates the end-to-end path: before maintenance, the time-interval
        policy is due (160 days elapsed, interval=90).  After record_asset_downtime
        runs, the evaluator must see last_maintenance_at from the written TSP
        row and compute elapsed time from that new baseline.

        This test wires the two activities together:
        1. record_asset_downtime writes a TSP row → last_maintenance_at is now
        2. pm_evaluate_trigger re-evaluates with last_maint = now → not due
        """
        import datetime as dt

        now = _NOW
        # Before maintenance: 160 days elapsed > 90-day interval → due
        old_baseline = now - dt.timedelta(days=160)
        policy = _time_policy(90)

        before = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            policy,
            _asset_ctx(last_maint=old_baseline.isoformat(), created=_ASSET_CREATED_ISO),
            now.isoformat(),
        )
        assert before["is_due"] is True, "asset should be due before maintenance"

        # After maintenance: last_maintenance_at = now → 0 days elapsed → not due
        after = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            policy,
            _asset_ctx(last_maint=now.isoformat(), created=_ASSET_CREATED_ISO),
            now.isoformat(),
        )
        assert after["is_due"] is False, (
            "time-interval policy should not be due immediately after maintenance — "
            "record_asset_downtime must update the baseline timestamp"
        )
        assert after["is_pre_due"] is False


# ---------------------------------------------------------------------------
# pm_scope_enabled_policies: maintenance-source baseline filter
# ---------------------------------------------------------------------------

class TestPMScopeInspectionDowntimeExclusion:
    """pm_scope_enabled_policies must use only maintenance-sourced downtime for baseline.

    A recent inspection-sourced downtime row must NOT advance the time-interval
    baseline; the evaluator must still resolve the older maintenance timestamp.
    """

    def _make_scope_mock(
        self,
        *,
        maintenance_observed_at: str,
        inspection_only: bool = False,
    ) -> MagicMock:
        """Return a mock client wired for pm_scope_enabled_policies.

        When ``inspection_only`` is True the time_series_points select returns
        only inspection-sourced rows (metadata->source = 'inspection'), so
        pm_scope_enabled_policies should return last_maintenance_at = None.
        Otherwise it returns a maintenance row.
        """
        mock_client = MagicMock()

        tsp_row = {"entity_id": _ASSET_ID, "observed_at": maintenance_observed_at}

        def _select(resource, **kw):
            if resource == "rental_current_entity_state":
                return [
                    {
                        "entity_id": _ASSET_ID,
                        "data": {"tenant_id": _TENANT_ID},
                        "created_at": _ASSET_CREATED_ISO,
                    }
                ]
            if resource == "v_pm_policy_effective":
                return [
                    {
                        "policy_id": _POLICY_ID,
                        "asset_id": _ASSET_ID,
                        "trigger_type": PMTriggerType.TIME_INTERVAL,
                        "threshold": None,
                        "interval_days": 90,
                        "lead_window_days": 0,
                        "label": "90-day service",
                    }
                ]
            if resource == "fact_types":
                return [{"id": "ft-downtime-uuid"}]
            if resource == "time_series_points":
                filters = kw.get("filters", {})
                source_filter = filters.get("metadata->>source")
                if source_filter == "maintenance" and not inspection_only:
                    return [tsp_row]
                # If the activity does NOT pass the source filter, or if the
                # mock simulates inspection-only rows, return nothing.
                return []
            return []

        mock_client.select.side_effect = _select
        return mock_client

    def test_maintenance_source_filter_passed_to_select(self, activity_env):
        """pm_scope_enabled_policies must pass metadata->>source=maintenance filter."""
        mock_client = self._make_scope_mock(maintenance_observed_at=_ASSET_CREATED_ISO)

        with patch(
            "temporal.src.activities.ops_pm._get_ops_persistence_client",
            return_value=mock_client,
        ):
            activity_env.run(ops_pm.pm_scope_enabled_policies, _TENANT_ID)

        tsp_calls = [
            c for c in mock_client.select.call_args_list if c.args[0] == "time_series_points"
        ]
        assert tsp_calls, "pm_scope_enabled_policies did not query time_series_points"
        filters_used = tsp_calls[0].kwargs.get("filters", {})
        assert filters_used.get("metadata->>source") == "maintenance", (
            "pm_scope_enabled_policies must filter time_series_points to "
            "metadata->>source = 'maintenance' to exclude inspection downtime"
        )

    def test_recent_inspection_downtime_does_not_suppress_pm_due(self, activity_env):
        """Time-interval PM must fire against the maintenance baseline, not inspection downtime.

        Scenario: last maintenance was 120 days ago (> 90-day interval → due),
        but a recent inspection happened 5 days ago.  Feeding last_maintenance_at
        from the older maintenance event, the policy should still evaluate as due.
        """
        import datetime as dt

        now = _NOW
        old_maintenance = now - dt.timedelta(days=120)
        policy = _time_policy(90)

        # Simulate pm_scope_enabled_policies correctly sourcing only maintenance rows.
        # last_maintenance_at = 120 days ago → evaluator should see due.
        result = activity_env.run(
            ops_pm.pm_evaluate_trigger,
            policy,
            _asset_ctx(last_maint=old_maintenance.isoformat(), created=_ASSET_CREATED_ISO),
            now.isoformat(),
        )
        assert result["is_due"] is True, (
            "Time-interval policy must be due when last *maintenance* was 120 days ago "
            "(interval=90), even if inspection downtime occurred more recently"
        )

    def test_inspection_only_downtime_leaves_last_maintenance_at_none(self, activity_env):
        """When all downtime rows are inspection-sourced, last_maintenance_at must be None.

        pm_scope_enabled_policies should return None for last_maintenance_at so the
        evaluator falls back to asset_created_at as the baseline.
        """
        mock_client = self._make_scope_mock(
            maintenance_observed_at=_ASSET_CREATED_ISO,
            inspection_only=True,
        )

        with patch(
            "temporal.src.activities.ops_pm._get_ops_persistence_client",
            return_value=mock_client,
        ):
            policies = activity_env.run(ops_pm.pm_scope_enabled_policies, _TENANT_ID)

        assert policies, "Expected at least one policy in result"
        last_maint = policies[0]["asset_context"]["last_maintenance_at"]
        assert last_maint is None, (
            "last_maintenance_at must be None when only inspection-sourced downtime "
            "rows exist — the PM evaluator must fall back to asset_created_at"
        )
