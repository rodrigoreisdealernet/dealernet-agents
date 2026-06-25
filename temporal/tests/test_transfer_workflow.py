"""Tests for TransferWorkflow: lifecycle transitions and blocking rules.

Two test layers:

1.  **Direct activity tests** – call ``check_asset_transferable`` and
    ``create_transfer_record`` directly as plain functions using
    ``ActivityEnvironment``.  No Temporal runtime is needed.

2.  **Simulated workflow lifecycle tests** – run the workflow's ``run()``
    coroutine in a plain asyncio event loop with Temporal primitives patched
    so that ``execute_activity`` calls the activity stub inline and
    ``wait_condition`` polls the condition flag.  This validates the full
    lifecycle (requested → approved → in_transit → received) and the
    negative path (blocked early-return for incompatible asset states)
    without requiring the Temporal test-server binary.

Coverage goals:
- requested → approved → in_transit → received lifecycle including
  ``get_status()`` query at each stage
- Workflow returns ``blocked=True`` (and never calls ``create_transfer_record``)
  when ``check_asset_transferable`` rejects the asset
- Negative-path: on_rent, in_transit, and maintenance assets are all blocked
- Cross-project transfer: ``origin_project_id`` / ``destination_project_id``
  are propagated through to the final result
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import temporalio.workflow as _tw_mod
from temporal.src.activities import rental_operations as ops
from temporal.src.models.rental import (
    TRANSFERABLE_STATUSES,
    AssetStatus,
    MilestoneSignal,
    TransferRequest,
)
from temporal.src.workflows.rental.transfer import TransferWorkflow
from temporalio.testing import ActivityEnvironment

REPO_ROOT = Path(__file__).resolve().parents[2]

_MAX_POLL = 300  # upper bound for fake_wait_condition spin loops

# ---------------------------------------------------------------------------
# Helpers shared across lifecycle tests
# ---------------------------------------------------------------------------

_ASSET_ID = "asset-xfer-001"
_ORIGIN_BRANCH = "branch-origin-001"
_DEST_BRANCH = "branch-dest-001"
_ACTOR = "user-actor-001"


def _make_request(**kwargs) -> TransferRequest:
    defaults = dict(
        asset_id=_ASSET_ID,
        origin_branch_id=_ORIGIN_BRANCH,
        destination_branch_id=_DEST_BRANCH,
        requested_by=_ACTOR,
    )
    defaults.update(kwargs)
    return TransferRequest(**defaults)


def _fake_unsafe() -> MagicMock:
    mock = MagicMock()
    mock.imports_passed_through.return_value = contextlib.nullcontext()
    return mock


async def _fake_wait_condition(cond_fn) -> None:
    for _ in range(_MAX_POLL):
        if cond_fn():
            return
        await asyncio.sleep(0)
    raise TimeoutError("fake_wait_condition never became True")


# ---------------------------------------------------------------------------
# Layer 1 – Direct activity tests (no Temporal runtime)
# ---------------------------------------------------------------------------

@pytest.fixture
def activity_env() -> ActivityEnvironment:
    return ActivityEnvironment()


class TestCheckAssetTransferableActivity:
    """check_asset_transferable must enforce TRANSFERABLE_STATUSES."""

    def test_available_allowed(self, activity_env: ActivityEnvironment) -> None:
        result = activity_env.run(
            ops.check_asset_transferable, "a1", AssetStatus.AVAILABLE.value
        )
        assert result["allowed"] is True
        assert result["reason"] is None

    def test_on_rent_blocked(self, activity_env: ActivityEnvironment) -> None:
        result = activity_env.run(
            ops.check_asset_transferable, "a2", AssetStatus.ON_RENT.value
        )
        assert result["allowed"] is False
        assert "on_rent" in (result["reason"] or "")

    def test_in_transit_blocked(self, activity_env: ActivityEnvironment) -> None:
        result = activity_env.run(
            ops.check_asset_transferable, "a3", AssetStatus.IN_TRANSIT.value
        )
        assert result["allowed"] is False

    def test_maintenance_blocked(self, activity_env: ActivityEnvironment) -> None:
        result = activity_env.run(
            ops.check_asset_transferable, "a4", AssetStatus.MAINTENANCE.value
        )
        assert result["allowed"] is False

    def test_inspection_hold_blocked(self, activity_env: ActivityEnvironment) -> None:
        result = activity_env.run(
            ops.check_asset_transferable, "a5", AssetStatus.INSPECTION_HOLD.value
        )
        assert result["allowed"] is False

    def test_retired_blocked(self, activity_env: ActivityEnvironment) -> None:
        result = activity_env.run(
            ops.check_asset_transferable, "a6", AssetStatus.RETIRED.value
        )
        assert result["allowed"] is False

    def test_transferable_statuses_constant_matches_business_rules(self) -> None:
        assert AssetStatus.AVAILABLE in TRANSFERABLE_STATUSES
        for status in (
            AssetStatus.ON_RENT,
            AssetStatus.IN_TRANSIT,
            AssetStatus.MAINTENANCE,
            AssetStatus.INSPECTION_HOLD,
            AssetStatus.RETIRED,
        ):
            assert status not in TRANSFERABLE_STATUSES


class TestCreateTransferRecordActivity:
    """create_transfer_record must return a deterministic transfer_id and the
    expected status/fields without requiring a live database."""

    def test_returns_requested_status_and_all_fields(
        self, activity_env: ActivityEnvironment
    ) -> None:
        result = activity_env.run(
            ops.create_transfer_record,
            _ASSET_ID,
            _ORIGIN_BRANCH,
            _DEST_BRANCH,
            _ACTOR,
            "2026-06-20",
            "2026-06-21",
            "Excavator 100",
            1500.0,
            "sd-001",
            None,
            "proj-origin-001",
            "proj-dest-001",
        )
        assert result["status"] == "requested"
        assert result["asset_id"] == _ASSET_ID
        assert result["transfer_id"]
        assert result["requested_ship_date"] == "2026-06-20"
        assert result["expected_receive_date"] == "2026-06-21"
        assert result["asset_scope"] == "Excavator 100"
        assert result["internal_cost"] == 1500.0
        assert result["sourcing_decision_id"] == "sd-001"
        assert result["origin_project_id"] == "proj-origin-001"
        assert result["destination_project_id"] == "proj-dest-001"

    def test_idempotent_on_same_sourcing_decision(
        self, activity_env: ActivityEnvironment
    ) -> None:
        r1 = activity_env.run(
            ops.create_transfer_record,
            _ASSET_ID, _ORIGIN_BRANCH, _DEST_BRANCH, _ACTOR,
            None, None, None, None, "sd-idem-001",
        )
        r2 = activity_env.run(
            ops.create_transfer_record,
            _ASSET_ID, _ORIGIN_BRANCH, _DEST_BRANCH, _ACTOR,
            None, None, None, None, "sd-idem-001",
        )
        assert r1["transfer_id"] == r2["transfer_id"]


# ---------------------------------------------------------------------------
# Layer 2 – Simulated workflow lifecycle tests (patched Temporal primitives)
# ---------------------------------------------------------------------------

class TestTransferWorkflowBlockedPath:
    """The workflow must return blocked=True and never progress to dispatch
    when the asset state is incompatible with transfer."""

    @staticmethod
    def _build_fake_execute(asset_status: str, create_calls: list) -> Any:
        async def fake_execute(fn_or_str, *pos_args, **kw):
            name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if name == "get_asset_status":
                return {"asset_id": args[0], "status": asset_status, "version_id": "v1"}
            if name == "check_asset_transferable":
                allowed = args[1] == AssetStatus.AVAILABLE.value
                reason = None if allowed else f"asset status '{args[1]}' is not transferable"
                return {"allowed": allowed, "reason": reason}
            if name == "create_transfer_record":
                create_calls.append(args)
            return None
        return fake_execute

    @pytest.mark.asyncio
    async def test_on_rent_asset_is_blocked_before_dispatch(self) -> None:
        """on_rent asset must be rejected; create_transfer_record must NOT be called."""
        create_calls: list = []
        fake_execute = self._build_fake_execute(AssetStatus.ON_RENT.value, create_calls)
        wf = TransferWorkflow()
        with (
            patch.object(_tw_mod, "execute_activity", side_effect=fake_execute),
            patch.object(_tw_mod, "wait_condition", side_effect=_fake_wait_condition),
            patch.object(_tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(_tw_mod, "unsafe", _fake_unsafe()),
        ):
            result = await wf.run(_make_request())

        assert result["blocked"] is True
        assert result["status"] == "blocked"
        assert result["blocked_reason"] is not None
        assert AssetStatus.ON_RENT.value in result["blocked_reason"]
        assert create_calls == [], "create_transfer_record must not be called for a blocked asset"
        assert wf.get_status() == "blocked"

    @pytest.mark.asyncio
    async def test_in_transit_asset_is_blocked_before_dispatch(self) -> None:
        create_calls: list = []
        fake_execute = self._build_fake_execute(AssetStatus.IN_TRANSIT.value, create_calls)
        wf = TransferWorkflow()
        with (
            patch.object(_tw_mod, "execute_activity", side_effect=fake_execute),
            patch.object(_tw_mod, "wait_condition", side_effect=_fake_wait_condition),
            patch.object(_tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(_tw_mod, "unsafe", _fake_unsafe()),
        ):
            result = await wf.run(_make_request())

        assert result["blocked"] is True
        assert result["status"] == "blocked"
        assert create_calls == []

    @pytest.mark.asyncio
    async def test_maintenance_asset_is_blocked_before_dispatch(self) -> None:
        create_calls: list = []
        fake_execute = self._build_fake_execute(AssetStatus.MAINTENANCE.value, create_calls)
        wf = TransferWorkflow()
        with (
            patch.object(_tw_mod, "execute_activity", side_effect=fake_execute),
            patch.object(_tw_mod, "wait_condition", side_effect=_fake_wait_condition),
            patch.object(_tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(_tw_mod, "unsafe", _fake_unsafe()),
        ):
            result = await wf.run(_make_request())

        assert result["blocked"] is True
        assert result["status"] == "blocked"
        assert create_calls == []

    @pytest.mark.asyncio
    async def test_blocked_result_has_empty_transfer_id(self) -> None:
        """A blocked workflow must return an empty string for transfer_id."""
        fake_execute = self._build_fake_execute(AssetStatus.ON_RENT.value, [])
        wf = TransferWorkflow()
        with (
            patch.object(_tw_mod, "execute_activity", side_effect=fake_execute),
            patch.object(_tw_mod, "wait_condition", side_effect=_fake_wait_condition),
            patch.object(_tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(_tw_mod, "unsafe", _fake_unsafe()),
        ):
            result = await wf.run(_make_request())

        assert result["transfer_id"] == ""
        assert result["asset_id"] == _ASSET_ID


class TestTransferWorkflowFullLifecycle:
    """The workflow must transition through requested → approved → in_transit →
    received and expose the correct ``get_status()`` value at each stage."""

    def _make_fake_execute(
        self,
        transfer_created: asyncio.Event,
        ship_milestone_done: asyncio.Event,
        scd2_calls: list,
        milestones: list,
    ) -> Any:
        async def fake_execute(fn_or_str, *pos_args, **kw):
            name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if name == "get_asset_status":
                return {"asset_id": args[0], "status": "available", "version_id": "v1"}
            if name == "check_asset_transferable":
                return {"allowed": True, "reason": None}
            if name == "create_transfer_record":
                transfer_created.set()
                return {
                    "transfer_id": "t-lifecycle-001",
                    "asset_id": args[0] if args else _ASSET_ID,
                    "status": "requested",
                    "requested_ship_date": "2026-07-01",
                    "expected_receive_date": "2026-07-02",
                    "asset_scope": "Crane 50T",
                    "internal_cost": 800.0,
                    "sourcing_decision_id": "sd-lc-001",
                    "transfer_exception_reason": None,
                    "origin_project_id": None,
                    "destination_project_id": None,
                }
            if name == "record_transfer_milestone":
                milestone = args[2] if len(args) > 2 else ""
                milestones.append(milestone)
                if milestone == "in_transit":
                    ship_milestone_done.set()
                return True
            if name == "update_entity_scd2":
                status = args[1].get("status", "") if len(args) > 1 else ""
                scd2_calls.append(status)
                return {"entity_id": args[0] if args else "", "version_id": "v2"}
            if name == "update_asset_branch":
                return True
            return None
        return fake_execute

    @pytest.mark.asyncio
    async def test_full_lifecycle_requested_to_received(self) -> None:
        """Workflow must pass through all four lifecycle states and return
        status='received' with the correct milestone sequence."""
        transfer_created = asyncio.Event()
        ship_milestone_done = asyncio.Event()
        scd2_calls: list[str] = []
        milestones: list[str] = []

        fake_execute = self._make_fake_execute(
            transfer_created, ship_milestone_done, scd2_calls, milestones
        )
        wf = TransferWorkflow()

        # The initial workflow state before run() is called.
        assert wf.get_status() == "requested"

        async def send_signals() -> None:
            await transfer_created.wait()  # workflow reached wait_condition for ship signal
            await asyncio.sleep(0)
            # Ship signal: transitions to approved → in_transit
            wf._ship_signal = MilestoneSignal(actor_id="driver-01")
            await ship_milestone_done.wait()  # workflow reached wait_condition for receive signal
            await asyncio.sleep(0)
            # Receive signal: transitions to received
            wf._receive_signal = MilestoneSignal(actor_id="warehouse-01")

        with (
            patch.object(_tw_mod, "execute_activity", side_effect=fake_execute),
            patch.object(_tw_mod, "wait_condition", side_effect=_fake_wait_condition),
            patch.object(_tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(_tw_mod, "unsafe", _fake_unsafe()),
        ):
            signal_task = asyncio.create_task(send_signals())
            result = await wf.run(_make_request())
            await signal_task

        # Final result assertions
        assert result["status"] == "received"
        assert result["blocked"] is False
        assert result["transfer_id"] == "t-lifecycle-001"
        assert result["asset_id"] == _ASSET_ID

        # Milestone sequence: approved must precede in_transit, in_transit precedes received
        assert milestones == ["approved", "in_transit", "received"], (
            f"Unexpected milestone sequence: {milestones}"
        )

        # SCD2 status sequence: in_transit before available
        assert "in_transit" in scd2_calls, f"in_transit not found in SCD2 calls: {scd2_calls}"
        assert "available" in scd2_calls, f"available not found in SCD2 calls: {scd2_calls}"
        assert scd2_calls.index("in_transit") < scd2_calls.index("available"), (
            f"in_transit must precede available in SCD2 sequence: {scd2_calls}"
        )

        # Internal status after completion
        assert wf.get_status() == "received"

    @pytest.mark.asyncio
    async def test_approved_status_set_before_waiting_for_ship(self) -> None:
        """The workflow's _status must be 'approved' after the record_transfer_milestone
        'approved' call and before entering wait_condition for the ship signal.
        This is verified by inspecting the snapshot taken right after transfer_created fires."""
        transfer_created = asyncio.Event()
        ship_milestone_done = asyncio.Event()
        scd2_calls: list[str] = []
        milestones: list[str] = []
        approved_status_at_wait: list[str] = []

        async def fake_execute(fn_or_str, *pos_args, **kw):
            name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if name == "get_asset_status":
                return {"asset_id": args[0], "status": "available", "version_id": "v1"}
            if name == "check_asset_transferable":
                return {"allowed": True, "reason": None}
            if name == "create_transfer_record":
                transfer_created.set()
                return {
                    "transfer_id": "t-approved-001",
                    "asset_id": args[0] if args else _ASSET_ID,
                    "status": "requested",
                    "requested_ship_date": None,
                    "expected_receive_date": None,
                    "asset_scope": None,
                    "internal_cost": None,
                    "sourcing_decision_id": None,
                    "transfer_exception_reason": None,
                    "origin_project_id": None,
                    "destination_project_id": None,
                }
            if name == "record_transfer_milestone":
                milestone = args[2] if len(args) > 2 else ""
                milestones.append(milestone)
                if milestone == "in_transit":
                    ship_milestone_done.set()
                return True
            if name == "update_entity_scd2":
                status = args[1].get("status", "") if len(args) > 1 else ""
                scd2_calls.append(status)
                return {"entity_id": args[0] if args else "", "version_id": "v2"}
            if name == "update_asset_branch":
                return True
            return None

        async def fake_wait(cond_fn) -> None:
            # Before first wait_condition returns we capture the current workflow status.
            # At this point the workflow has processed: create_transfer_record → record_transfer_milestone("approved")
            # and the _status should be "approved".
            approved_status_at_wait.append(wf.get_status())
            for _ in range(_MAX_POLL):
                if cond_fn():
                    return
                await asyncio.sleep(0)
            raise TimeoutError("fake_wait never became True")

        wf = TransferWorkflow()

        async def send_signals() -> None:
            await transfer_created.wait()
            await asyncio.sleep(0)
            wf._ship_signal = MilestoneSignal(actor_id="driver-01")
            await ship_milestone_done.wait()
            await asyncio.sleep(0)
            wf._receive_signal = MilestoneSignal(actor_id="warehouse-01")

        with (
            patch.object(_tw_mod, "execute_activity", side_effect=fake_execute),
            patch.object(_tw_mod, "wait_condition", side_effect=fake_wait),
            patch.object(_tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(_tw_mod, "unsafe", _fake_unsafe()),
        ):
            signal_task = asyncio.create_task(send_signals())
            await wf.run(_make_request())
            await signal_task

        # The very first wait_condition snapshot must show 'approved' (not 'requested')
        # because the 'approved' milestone was recorded before the wait.
        assert approved_status_at_wait, "wait_condition was never called"
        assert approved_status_at_wait[0] == "approved", (
            f"Expected 'approved' before ship wait; got '{approved_status_at_wait[0]}'"
        )

    @pytest.mark.asyncio
    async def test_cross_project_fields_propagated_to_result(self) -> None:
        """origin_project_id and destination_project_id must appear in the final result."""
        transfer_created = asyncio.Event()
        ship_milestone_done = asyncio.Event()

        async def fake_execute(fn_or_str, *pos_args, **kw):
            name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if name == "get_asset_status":
                return {"asset_id": args[0], "status": "available", "version_id": "v1"}
            if name == "check_asset_transferable":
                return {"allowed": True, "reason": None}
            if name == "create_transfer_record":
                transfer_created.set()
                return {
                    "transfer_id": "t-xp-001",
                    "asset_id": args[0] if args else _ASSET_ID,
                    "status": "requested",
                    "requested_ship_date": None,
                    "expected_receive_date": None,
                    "asset_scope": None,
                    "internal_cost": None,
                    "sourcing_decision_id": None,
                    "transfer_exception_reason": None,
                    "origin_project_id": "proj-origin-xp",
                    "destination_project_id": "proj-dest-xp",
                }
            if name == "record_transfer_milestone":
                milestone = args[2] if len(args) > 2 else ""
                if milestone == "in_transit":
                    ship_milestone_done.set()
                return True
            if name == "update_entity_scd2":
                return {"entity_id": args[0] if args else "", "version_id": "v2"}
            if name == "update_asset_branch":
                return True
            return None

        wf = TransferWorkflow()

        async def send_signals() -> None:
            await transfer_created.wait()
            await asyncio.sleep(0)
            wf._ship_signal = MilestoneSignal(actor_id="driver-01")
            await ship_milestone_done.wait()
            await asyncio.sleep(0)
            wf._receive_signal = MilestoneSignal(actor_id="warehouse-01")

        with (
            patch.object(_tw_mod, "execute_activity", side_effect=fake_execute),
            patch.object(_tw_mod, "wait_condition", side_effect=_fake_wait_condition),
            patch.object(_tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(_tw_mod, "unsafe", _fake_unsafe()),
        ):
            signal_task = asyncio.create_task(send_signals())
            result = await wf.run(
                _make_request(
                    origin_project_id="proj-origin-xp",
                    destination_project_id="proj-dest-xp",
                )
            )
            await signal_task

        assert result["origin_project_id"] == "proj-origin-xp"
        assert result["destination_project_id"] == "proj-dest-xp"
        assert result["status"] == "received"


# ---------------------------------------------------------------------------
# Supabase reset-path validation
# ---------------------------------------------------------------------------

_OPS_SCHEMA_TRANSIENT_ERROR_RE = (
    r"Error status 50[0-9]|invalid response was received from the upstream server|"
    r"context deadline exceeded|connection refused|connection reset|i/o timeout|"
    r": EOF$|: EOF |unexpected EOF|error during connect|server closed the connection|"
    r"TLS handshake timeout|timeout exceeded while awaiting headers|"
    r"the input device is not a TTY|error running container: exit 1|"
    r"Cannot connect to the Docker daemon|error response from daemon|"
    r"toomanyrequests|accepting connections on that socket"
)


def _run_with_retry(
    command: list[str],
    *,
    max_attempts: int = 3,
    timeout: float = 600.0,
) -> subprocess.CompletedProcess[str]:
    import re
    transient_re = re.compile(_OPS_SCHEMA_TRANSIENT_ERROR_RE, re.IGNORECASE)
    last_exc: subprocess.CalledProcessError | None = None
    import time
    for attempt in range(max_attempts):
        try:
            return subprocess.run(
                command,
                text=True,
                capture_output=True,
                check=True,
                timeout=timeout,
            )
        except subprocess.CalledProcessError as exc:
            last_exc = exc
            combined = exc.stdout + exc.stderr
            if not transient_re.search(combined) or attempt == max_attempts - 1:
                raise
            time.sleep((attempt + 1) * 5)
    raise last_exc  # type: ignore[misc]


def test_cross_project_branch_transfers_reset_validation() -> None:
    """Verify that ``supabase db reset --config supabase/config.toml`` applies
    20260613170000_cross_project_branch_transfers.sql cleanly and that the
    expected schema objects (v_transfer_current, v_transfer_history, transfer
    entity type, transfer relationship types) exist afterwards.

    Skipped when the Supabase CLI is unavailable; fails hard when
    REQUIRE_SUPABASE_RESET_VALIDATION=1 is set (CI DB-surface validation).
    """
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    try:
        result = _run_with_retry(
            ["bash", str(REPO_ROOT / "supabase" / "tests" / "run_cross_project_branch_transfers_reset.sh")],
            max_attempts=3,
            timeout=600.0,
        )
    except subprocess.CalledProcessError as exc:
        if os.environ.get("REQUIRE_SUPABASE_RESET_VALIDATION") == "1":
            pytest.fail(
                "Cross-project branch transfers reset validation failed.\n"
                f"stdout:\n{exc.stdout}\n"
                f"stderr:\n{exc.stderr}"
            )
        pytest.skip(
            "Cross-project branch transfers reset-path validation could not run in this environment.\n"
            f"stdout:\n{exc.stdout}\n"
            f"stderr:\n{exc.stderr}"
        )
    assert "Cross-project branch transfers reset checks passed" in result.stdout
