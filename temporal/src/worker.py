from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib import error, request

from temporalio import service
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleSpec,
    ScheduleUpdate,
)
from temporalio.runtime import PrometheusConfig, Runtime, TelemetryConfig
from temporalio.worker import Worker

from .activities import accounting as accounting_activities
from .activities import coupa as coupa_activities
from .activities import descartes_sync as descartes_activities
from .activities import (
    mulesoft,
    notifications,
    ops_account_health,
    ops_billing_update,
    ops_branch_brief,
    ops_collections,
    ops_contract_ocr,
    ops_credit,
    ops_dispatch_snapshot,
    ops_disposition,
    ops_fleet,
    ops_integration_exception,
    ops_llm_usage,
    ops_parts_inventory,
    ops_pm,
    ops_revrec,
    ops_safety_compliance_monitor,
    ops_shop_queue,
    ops_technician_queue,
    ops_territory_brief,
    ops_vehicle_aging,
    rental_operations,
    supabase_core,
)
from .activities import rental as rental_activities
from .activities import samsara as samsara_activities
from .config import settings
from .models.rental import PMEvaluatorInput
from .workflows.accounting import AccountingPostingWorkflow
from .workflows.example.approval_workflow import ApprovalWorkflow
from .workflows.integrations import (
    CoupaSyncWorkflow,
    CoupaSyncWorkflowInput,
    DescartesSyncWorkflow,
    DescartesSyncWorkflowInput,
    MuleSoftInboundCallbackWorkflow,
    MuleSoftOutboundWorkflow,
    SamsaraSyncWorkflow,
    SamsaraSyncWorkflowInput,
)
from .workflows.ops import AssetUpdateWorkflow
from .workflows.ops.account_health_queue import AccountHealthQueueWorkflow, AccountHealthQueueWorkflowInput
from .workflows.ops.billing_update import BillingUpdateApprovalWorkflow
from .workflows.ops.branch_morning_brief import BranchMorningBriefWorkflow, BranchMorningBriefWorkflowInput
from .workflows.ops.collections_prioritizer import (
    CollectionsPrioritizerWorkflow,
    CollectionsPrioritizerWorkflowInput,
)
from .workflows.ops.contract_ocr import ContractAnalysisWorkflow, ContractOcrRevalidationWorkflow
from .workflows.ops.credit import CreditRiskWorkflow, CreditRiskWorkflowInput
from .workflows.ops.credit_lien_control import CreditLienControlWorkflow
from .workflows.ops.disposition_queue import DispositionQueueWorkflow, DispositionQueueWorkflowInput
from .workflows.ops.fleet import FleetUtilizationWorkflow, FleetUtilizationWorkflowInput
from .workflows.ops.integration_exception_queue import (
    IntegrationExceptionQueueWorkflow,
    IntegrationExceptionQueueWorkflowInput,
)
from .workflows.ops.pm_evaluator import PMEvaluatorWorkflow
from .workflows.ops.parts_inventory import PartsInventoryWorkflow, PartsInventoryWorkflowInput
from .workflows.ops.revrec import RevenueRecognitionWorkflow, RevenueRecognitionWorkflowInput
from .workflows.ops.safety_compliance_monitor import SafetyComplianceMonitorWorkflow
from .workflows.ops.shop_morning_queue import ShopMorningQueueWorkflow, ShopMorningQueueWorkflowInput
from .workflows.ops.technician_morning_queue import TechnicianMorningQueueWorkflow, TechnicianMorningQueueWorkflowInput
from .workflows.ops.territory_brief import TerritoryAccountBriefWorkflow
from .workflows.ops.vehicle_aging import VehicleAgingWorkflow, VehicleAgingWorkflowInput
from .workflows.rental import (
    InspectionWorkflow,
    InvoiceWorkflow,
    MaintenanceCostingWorkflow,
    MaintenanceInvoiceWorkflow,
    MaintenanceWorkflow,
    TransferWorkflow,
)
from .workflows.rental.rental_workflow import RentalOrderWorkflow

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_REVREC_AGENT_KEY = "revrec-analyst"
_REVREC_DEFAULT_CRON = "0 2 * * *"

_PM_AGENT_KEY = "pm-evaluator"
_PM_DEFAULT_CRON = "0 */6 * * *"

_VEHICLE_AGING_AGENT_KEY = "vehicle-aging-analyst"
_VEHICLE_AGING_DEFAULT_CRON = "0 6 * * 1-5"

_COLLECTIONS_AGENT_KEY = "collections-prioritizer"
_COLLECTIONS_DEFAULT_CRON = "0 6 * * 1-5"

_COLLECTIONS_ACTIVITIES = (
    ops_collections.ops_load_agent_config,
    ops_collections.ops_scope_collections,
    ops_collections.ops_collections_assess,
    ops_collections.ops_list_open_finding_fingerprints,
    ops_collections.ops_create_workflow_run,
    ops_collections.ops_finalize_workflow_run,
    ops_collections.ops_record_finding,
    ops_collections.ops_record_finding_disposition,
)

_PARTS_INVENTORY_AGENT_KEY = "parts-inventory-advisor"
_PARTS_INVENTORY_DEFAULT_CRON = "0 6 * * 1"

_PARTS_INVENTORY_ACTIVITIES = (
    ops_parts_inventory.ops_load_agent_config,
    ops_parts_inventory.ops_scope_parts_replenish,
    ops_parts_inventory.ops_scope_parts_dead_stock,
    ops_parts_inventory.ops_parts_inventory_assess,
    ops_parts_inventory.ops_list_open_finding_fingerprints,
    ops_parts_inventory.ops_create_workflow_run,
    ops_parts_inventory.ops_finalize_workflow_run,
    ops_parts_inventory.ops_record_finding,
    ops_parts_inventory.ops_record_finding_disposition,
)

# Prometheus metrics are exposed by the Temporal SDK Runtime on this port.
# Keep in sync with temporalWorker.metrics.port in chart values.
_METRICS_BIND_ADDRESS = "0.0.0.0:9000"


def _schedule_id_for_tenant(tenant_id: str, agent_key: str = _REVREC_AGENT_KEY) -> str:
    return f"ops:{tenant_id}:{agent_key}"


def _bool_from_config(value: Any, *, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return bool(value)


def _extract_schedule_fields(config_row: Mapping[str, Any], default_cron: str = _REVREC_DEFAULT_CRON) -> tuple[bool, str]:
    raw_schedule = config_row.get("schedule")
    schedule = raw_schedule if isinstance(raw_schedule, Mapping) else {}
    # Both connector-level (config_row.enabled) and schedule-level (schedule.enabled)
    # can disable the schedule. A schedule is only enabled if both are True (or absent).
    top_level_enabled = _bool_from_config(config_row.get("enabled"), default=True)
    schedule_level_enabled = _bool_from_config(schedule.get("enabled"), default=True)
    enabled = top_level_enabled and schedule_level_enabled
    cron_raw = schedule.get("cron")
    cron = str(cron_raw).strip() if isinstance(cron_raw, str) else ""
    if not cron:
        cron = default_cron
    return enabled, cron


def _build_revrec_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            RevenueRecognitionWorkflow.run,
            RevenueRecognitionWorkflowInput(tenant_id=tenant_id),
            id=f"ops-revrec-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


def _is_not_found_error(exc: BaseException) -> bool:
    return isinstance(exc, service.RPCError) and exc.status == service.RPCStatusCode.NOT_FOUND


def _fetch_agent_config_rows(agent_key: str) -> list[dict[str, Any]]:
    """Fetch ``ops_agent_config_current`` rows for *agent_key* via PostgREST.

    Returns an empty list if the table is not yet provisioned (404), which is a
    normal pre-bootstrap state.  Raises ``RuntimeError`` on any other HTTP error.
    """
    base_url = settings.supabase_url.rstrip("/")
    url = (
        f"{base_url}/rest/v1/ops_agent_config_current"
        f"?select=tenant_id,enabled,schedule&agent_key=eq.{agent_key}"
    )
    req = request.Request(
        url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": "Bearer " + settings.supabase_service_role_key,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        if exc.code == 404:
            logger.warning(
                "ops_agent_config not provisioned yet (404) — skipping schedule reconcile",
                extra={"url": url, "agent_key": agent_key},
            )
            return []
        logger.exception("Failed to fetch agent config rows", extra={"url": url, "status": exc.code})
        raise RuntimeError(f"Failed to fetch agent config rows ({exc.code})") from exc
    except error.URLError as exc:
        logger.exception("Failed to reach Supabase for agent config rows", extra={"url": url})
        raise RuntimeError("Failed to reach Supabase for agent config schedule reconciliation") from exc

    if not isinstance(payload, list):
        raise ValueError("ops_agent_config_current response must be a JSON list")
    return [row for row in payload if isinstance(row, dict)]


def _fetch_revrec_schedule_rows() -> list[dict[str, Any]]:
    base_url = settings.supabase_url.rstrip("/")
    url = (
        f"{base_url}/rest/v1/ops_agent_config_current"
        f"?select=tenant_id,enabled,schedule&agent_key=eq.{_REVREC_AGENT_KEY}"
    )
    req = request.Request(
        url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": "Bearer " + settings.supabase_service_role_key,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        # The ops_agent_config table may not be provisioned yet (the DB bootstrap
        # runs AFTER a successful deploy). A 404 is a normal pre-bootstrap state,
        # not fatal — return no rows so the worker still starts. Otherwise the
        # worker crashes → deploy fails → bootstrap never runs → table never
        # created → deadlock.
        if exc.code == 404:
            logger.warning(
                "ops_agent_config not provisioned yet (404) — skipping revrec schedule reconcile",
                extra={"url": url},
            )
            return []
        logger.exception("Failed to fetch revrec config rows", extra={"url": url, "status": exc.code})
        raise RuntimeError(f"Failed to fetch revrec config rows ({exc.code})") from exc
    except error.URLError as exc:
        logger.exception("Failed to reach Supabase for revrec config rows", extra={"url": url})
        raise RuntimeError("Failed to reach Supabase for revrec schedule reconciliation") from exc

    if not isinstance(payload, list):
        raise ValueError("ops_agent_config_current response must be a JSON list")
    return [row for row in payload if isinstance(row, dict)]


async def _reconcile_tenant_revrec_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row)
    schedule_id = _schedule_id_for_tenant(tenant_id)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled revrec schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_revrec_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created revrec schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated revrec schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_revrec_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_revrec_schedule_rows)
    for row in rows:
        await _reconcile_tenant_revrec_schedule(client, row)


# ---------------------------------------------------------------------------
# PM evaluator schedule reconciliation
# ---------------------------------------------------------------------------

def _fetch_pm_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_PM_AGENT_KEY)


def _build_pm_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            PMEvaluatorWorkflow.run,
            PMEvaluatorInput(tenant_id=tenant_id),
            id=f"ops-pm-evaluator-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_pm_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_PM_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _PM_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled PM schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_pm_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created PM evaluator schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated PM evaluator schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_pm_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_pm_schedule_rows)
    for row in rows:
        await _reconcile_tenant_pm_schedule(client, row)


# ---------------------------------------------------------------------------
# Vehicle stock-aging analyst schedule reconciliation
# ---------------------------------------------------------------------------

def _fetch_vehicle_aging_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_VEHICLE_AGING_AGENT_KEY)


def _build_vehicle_aging_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            VehicleAgingWorkflow.run,
            VehicleAgingWorkflowInput(tenant_id=tenant_id),
            id=f"ops-vehicle-aging-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_vehicle_aging_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_VEHICLE_AGING_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _VEHICLE_AGING_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    # vehicle-aging ships schedule.enabled=false: reconcile deletes any stray
    # schedule so the recurring run stays off until explicitly enabled.
    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info(
                "Deleted disabled vehicle-aging schedule",
                extra={"tenant_id": tenant_id, "schedule_id": schedule_id},
            )
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_vehicle_aging_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created vehicle-aging schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated vehicle-aging schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_vehicle_aging_schedules(
    client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None
) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_vehicle_aging_schedule_rows)
    for row in rows:
        await _reconcile_tenant_vehicle_aging_schedule(client, row)


# ---------------------------------------------------------------------------
# Collections prioritizer schedule reconciliation
# ---------------------------------------------------------------------------

def _fetch_collections_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_COLLECTIONS_AGENT_KEY)


def _build_collections_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            CollectionsPrioritizerWorkflow.run,
            CollectionsPrioritizerWorkflowInput(tenant_id=tenant_id),
            id=f"ops-collections-prioritizer-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_collections_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_COLLECTIONS_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _COLLECTIONS_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info(
                "Deleted disabled collections-prioritizer schedule",
                extra={"tenant_id": tenant_id, "schedule_id": schedule_id},
            )
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_collections_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created collections-prioritizer schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated collections-prioritizer schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_collections_schedules(
    client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None
) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_collections_schedule_rows)
    for row in rows:
        await _reconcile_tenant_collections_schedule(client, row)


# ---------------------------------------------------------------------------
# Parts inventory advisor schedule reconciliation
# ---------------------------------------------------------------------------

def _fetch_parts_inventory_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_PARTS_INVENTORY_AGENT_KEY)


def _build_parts_inventory_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            PartsInventoryWorkflow.run,
            PartsInventoryWorkflowInput(tenant_id=tenant_id),
            id=f"ops-parts-inventory-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_parts_inventory_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_PARTS_INVENTORY_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _PARTS_INVENTORY_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info(
                "Deleted disabled parts-inventory schedule",
                extra={"tenant_id": tenant_id, "schedule_id": schedule_id},
            )
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_parts_inventory_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created parts-inventory schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated parts-inventory schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_parts_inventory_schedules(
    client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None
) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_parts_inventory_schedule_rows)
    for row in rows:
        await _reconcile_tenant_parts_inventory_schedule(client, row)


# ---------------------------------------------------------------------------
# Samsara integration schedule reconciliation
# ---------------------------------------------------------------------------

_SAMSARA_INTEGRATION_KEY = "samsara"
_SAMSARA_DEFAULT_CRON = "0 */6 * * *"


def _samsara_schedule_id(tenant_id: str) -> str:
    return f"integration:{tenant_id}:samsara"


def _build_samsara_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            SamsaraSyncWorkflow.run,
            SamsaraSyncWorkflowInput(tenant_id=tenant_id),
            # Use the same stable workflow ID as manual incremental syncs so that
            # Temporal's ALREADY_EXISTS check prevents scheduled and manual runs
            # from racing on the per-scope cursor in integration_sync_state.
            id=f"samsara-sync-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


def _fetch_samsara_config_rows() -> list[dict[str, Any]]:
    """Fetch ``integration_config`` rows for Samsara via PostgREST.

    Returns an empty list if the table is not yet provisioned (404), which is a
    normal pre-bootstrap state.  Raises ``RuntimeError`` on any other HTTP error.
    """
    base_url = settings.supabase_url.rstrip("/")
    url = (
        f"{base_url}/rest/v1/integration_config"
        f"?select=tenant_id,enabled,schedule&connector_key=eq.{_SAMSARA_INTEGRATION_KEY}"
    )
    req = request.Request(
        url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": "Bearer " + settings.supabase_service_role_key,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        if exc.code == 404:
            logger.warning(
                "integration_config not provisioned yet (404) — skipping samsara schedule reconcile",
                extra={"url": url},
            )
            return []
        logger.exception("Failed to fetch samsara config rows", extra={"url": url, "status": exc.code})
        raise RuntimeError(f"Failed to fetch samsara config rows ({exc.code})") from exc
    except error.URLError as exc:
        logger.exception("Failed to reach Supabase for samsara config rows", extra={"url": url})
        raise RuntimeError("Failed to reach Supabase for samsara schedule reconciliation") from exc

    if not isinstance(payload, list):
        raise ValueError("integration_config response must be a JSON list")
    return [row for row in payload if isinstance(row, dict)]


async def _reconcile_tenant_samsara_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        logger.warning("Skipping samsara schedule reconcile: config row has no tenant_id")
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_SAMSARA_DEFAULT_CRON)
    schedule_id = _samsara_schedule_id(tenant_id)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled samsara schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_samsara_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created samsara schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated samsara schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_samsara_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_samsara_config_rows)
    for row in rows:
        await _reconcile_tenant_samsara_schedule(client, row)


# ---------------------------------------------------------------------------
# Coupa integration schedule reconciliation
# ---------------------------------------------------------------------------

_COUPA_INTEGRATION_KEY = "coupa"
_COUPA_DEFAULT_CRON = "0 */6 * * *"


def _coupa_schedule_id(tenant_id: str) -> str:
    return f"integration:{tenant_id}:coupa"


def _build_coupa_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            CoupaSyncWorkflow.run,
            CoupaSyncWorkflowInput(tenant_id=tenant_id),
            # Use the same stable workflow ID as manual incremental syncs so that
            # Temporal's ALREADY_EXISTS check prevents scheduled and manual runs
            # from racing on the per-scope cursor in integration_sync_state.
            id=f"coupa-sync-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


def _fetch_coupa_config_rows() -> list[dict[str, Any]]:
    """Fetch ``integration_config`` rows for Coupa via PostgREST.

    Returns an empty list if the table is not yet provisioned (404), which is a
    normal pre-bootstrap state.  Raises ``RuntimeError`` on any other HTTP error.
    """
    base_url = settings.supabase_url.rstrip("/")
    url = (
        f"{base_url}/rest/v1/integration_config"
        f"?select=tenant_id,enabled,schedule&connector_key=eq.{_COUPA_INTEGRATION_KEY}"
    )
    req = request.Request(
        url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": "Bearer " + settings.supabase_service_role_key,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        if exc.code == 404:
            logger.warning(
                "integration_config not provisioned yet (404) — skipping coupa schedule reconcile",
                extra={"url": url},
            )
            return []
        logger.exception("Failed to fetch coupa config rows", extra={"url": url, "status": exc.code})
        raise RuntimeError(f"Failed to fetch coupa config rows ({exc.code})") from exc
    except error.URLError as exc:
        logger.exception("Failed to reach Supabase for coupa config rows", extra={"url": url})
        raise RuntimeError("Failed to reach Supabase for coupa schedule reconciliation") from exc

    if not isinstance(payload, list):
        raise ValueError("integration_config response must be a JSON list")
    return [row for row in payload if isinstance(row, dict)]


async def _reconcile_tenant_coupa_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        logger.warning("Skipping coupa schedule reconcile: config row has no tenant_id")
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_COUPA_DEFAULT_CRON)
    schedule_id = _coupa_schedule_id(tenant_id)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled coupa schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_coupa_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created coupa schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated coupa schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_coupa_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_coupa_config_rows)
    for row in rows:
        await _reconcile_tenant_coupa_schedule(client, row)


# ---------------------------------------------------------------------------
# Descartes integration schedule reconciliation
# ---------------------------------------------------------------------------

_DESCARTES_INTEGRATION_KEY = "descartes"
_DESCARTES_DEFAULT_CRON = "0 */6 * * *"


def _descartes_schedule_id(tenant_id: str) -> str:
    return f"integration:{tenant_id}:descartes"


def _build_descartes_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            DescartesSyncWorkflow.run,
            DescartesSyncWorkflowInput(tenant_id=tenant_id),
            id=f"descartes-sync-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


def _fetch_descartes_config_rows() -> list[dict[str, Any]]:
    """Fetch ``integration_config`` rows for Descartes via PostgREST.

    Returns an empty list if the table is not yet provisioned (404), which is a
    normal pre-bootstrap state.  Raises ``RuntimeError`` on any other HTTP error.
    """
    base_url = settings.supabase_url.rstrip("/")
    url = (
        f"{base_url}/rest/v1/integration_config"
        f"?select=tenant_id,enabled,schedule&connector_key=eq.{_DESCARTES_INTEGRATION_KEY}"
    )
    req = request.Request(
        url,
        headers={
            "apikey": settings.supabase_service_role_key,
            "Authorization": "Bearer " + settings.supabase_service_role_key,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        if exc.code == 404:
            logger.warning(
                "integration_config not provisioned yet (404) — skipping descartes schedule reconcile",
                extra={"url": url},
            )
            return []
        logger.exception("Failed to fetch descartes config rows", extra={"url": url, "status": exc.code})
        raise RuntimeError(f"Failed to fetch descartes config rows ({exc.code})") from exc
    except error.URLError as exc:
        logger.exception("Failed to reach Supabase for descartes config rows", extra={"url": url})
        raise RuntimeError("Failed to reach Supabase for descartes schedule reconciliation") from exc

    if not isinstance(payload, list):
        raise ValueError("integration_config response must be a JSON list")
    return [row for row in payload if isinstance(row, dict)]


async def _reconcile_tenant_descartes_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        logger.warning("Skipping descartes schedule reconcile: config row has no tenant_id")
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_DESCARTES_DEFAULT_CRON)
    schedule_id = _descartes_schedule_id(tenant_id)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled descartes schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_descartes_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created descartes schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated descartes schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_descartes_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_descartes_config_rows)
    for row in rows:
        await _reconcile_tenant_descartes_schedule(client, row)


# ---------------------------------------------------------------------------
# Fleet utilization schedule reconciliation
# ---------------------------------------------------------------------------

_FLEET_AGENT_KEY = "fleet-auditor"
_FLEET_DEFAULT_CRON = "0 3 * * 1"  # weekly, Monday 03:00


def _fetch_fleet_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_FLEET_AGENT_KEY)


def _build_fleet_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            FleetUtilizationWorkflow.run,
            FleetUtilizationWorkflowInput(tenant_id=tenant_id),
            id=f"ops-fleet-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_fleet_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_FLEET_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _FLEET_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled fleet schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_fleet_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created fleet schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated fleet schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_fleet_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_fleet_schedule_rows)
    for row in rows:
        await _reconcile_tenant_fleet_schedule(client, row)


# ---------------------------------------------------------------------------
# Credit analyst schedule reconciliation
# ---------------------------------------------------------------------------

_CREDIT_AGENT_KEY = "credit-analyst"
_CREDIT_DEFAULT_CRON = "0 3 * * *"  # nightly 03:00


def _fetch_credit_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_CREDIT_AGENT_KEY)


def _build_credit_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            CreditRiskWorkflow.run,
            CreditRiskWorkflowInput(tenant_id=tenant_id),
            id=f"ops-credit-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_credit_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_CREDIT_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _CREDIT_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled credit schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_credit_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created credit schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated credit schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_credit_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_credit_schedule_rows)
    for row in rows:
        await _reconcile_tenant_credit_schedule(client, row)


# ---------------------------------------------------------------------------
# Shop morning queue schedule reconciliation
# ---------------------------------------------------------------------------

_SHOP_MORNING_QUEUE_AGENT_KEY = "shop-morning-queue"
_SHOP_MORNING_QUEUE_DEFAULT_CRON = "0 7 * * *"  # daily 07:00


def _fetch_shop_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_SHOP_MORNING_QUEUE_AGENT_KEY)


def _build_shop_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            ShopMorningQueueWorkflow.run,
            ShopMorningQueueWorkflowInput(tenant_id=tenant_id),
            id=f"ops-shop-morning-queue-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_shop_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_SHOP_MORNING_QUEUE_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _SHOP_MORNING_QUEUE_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled shop schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_shop_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created shop schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated shop schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_shop_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_shop_schedule_rows)
    for row in rows:
        await _reconcile_tenant_shop_schedule(client, row)


# ---------------------------------------------------------------------------
# Technician morning queue schedule reconciliation
# ---------------------------------------------------------------------------

_TECHNICIAN_MORNING_QUEUE_AGENT_KEY = "technician-morning-queue"
_TECHNICIAN_MORNING_QUEUE_DEFAULT_CRON = "0 7 * * *"  # daily 07:00


def _fetch_technician_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_TECHNICIAN_MORNING_QUEUE_AGENT_KEY)


def _build_technician_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            TechnicianMorningQueueWorkflow.run,
            TechnicianMorningQueueWorkflowInput(tenant_id=tenant_id),
            id=f"ops-technician-morning-queue-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_technician_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_TECHNICIAN_MORNING_QUEUE_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _TECHNICIAN_MORNING_QUEUE_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled technician schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_technician_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created technician schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated technician schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_technician_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_technician_schedule_rows)
    for row in rows:
        await _reconcile_tenant_technician_schedule(client, row)


# ---------------------------------------------------------------------------
# Branch morning brief schedule reconciliation
# ---------------------------------------------------------------------------

_BRANCH_MORNING_BRIEF_AGENT_KEY = "branch-morning-brief"
_BRANCH_MORNING_BRIEF_DEFAULT_CRON = "0 7 * * *"  # daily 07:00


def _fetch_branch_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_BRANCH_MORNING_BRIEF_AGENT_KEY)


def _build_branch_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            BranchMorningBriefWorkflow.run,
            BranchMorningBriefWorkflowInput(tenant_id=tenant_id),
            id=f"ops-branch-morning-brief-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_branch_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_BRANCH_MORNING_BRIEF_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _BRANCH_MORNING_BRIEF_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled branch schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_branch_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created branch schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated branch schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_branch_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_branch_schedule_rows)
    for row in rows:
        await _reconcile_tenant_branch_schedule(client, row)


# ---------------------------------------------------------------------------
# Account health queue schedule reconciliation
# ---------------------------------------------------------------------------

_ACCOUNT_HEALTH_AGENT_KEY = "account-health-queue"
_ACCOUNT_HEALTH_DEFAULT_CRON = "0 4 * * *"  # nightly 04:00


def _fetch_account_health_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_ACCOUNT_HEALTH_AGENT_KEY)


def _build_account_health_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            AccountHealthQueueWorkflow.run,
            AccountHealthQueueWorkflowInput(tenant_id=tenant_id),
            id=f"ops-account-health-queue-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_account_health_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_ACCOUNT_HEALTH_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _ACCOUNT_HEALTH_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled account-health schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_account_health_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created account-health schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated account-health schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_account_health_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_account_health_schedule_rows)
    for row in rows:
        await _reconcile_tenant_account_health_schedule(client, row)


# ---------------------------------------------------------------------------
# Integration exception queue schedule reconciliation
# ---------------------------------------------------------------------------

_INTEGRATION_EXCEPTION_AGENT_KEY = "integration-exception-queue"
_INTEGRATION_EXCEPTION_DEFAULT_CRON = "0 5 * * *"  # nightly 05:00


def _fetch_integration_exception_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_INTEGRATION_EXCEPTION_AGENT_KEY)


def _build_integration_exception_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            IntegrationExceptionQueueWorkflow.run,
            IntegrationExceptionQueueWorkflowInput(tenant_id=tenant_id),
            id=f"ops-integration-exception-queue-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_integration_exception_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_INTEGRATION_EXCEPTION_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _INTEGRATION_EXCEPTION_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled integration-exception schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_integration_exception_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created integration-exception schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated integration-exception schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_integration_exception_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_integration_exception_schedule_rows)
    for row in rows:
        await _reconcile_tenant_integration_exception_schedule(client, row)


# ---------------------------------------------------------------------------
# Disposition recommendation queue schedule reconciliation
# ---------------------------------------------------------------------------

_DISPOSITION_AGENT_KEY = "disposition-queue"
_DISPOSITION_DEFAULT_CRON = "0 4 1 * *"  # monthly, 1st at 04:00


def _fetch_disposition_schedule_rows() -> list[dict[str, Any]]:
    return _fetch_agent_config_rows(_DISPOSITION_AGENT_KEY)


def _build_disposition_schedule(tenant_id: str, cron: str) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            DispositionQueueWorkflow.run,
            DispositionQueueWorkflowInput(tenant_id=tenant_id),
            id=f"ops-disposition-queue-{tenant_id}",
            task_queue=settings.temporal_task_queue,
        ),
        spec=ScheduleSpec(cron_expressions=[cron]),
    )


async def _reconcile_tenant_disposition_schedule(client: Client, config_row: Mapping[str, Any]) -> None:
    tenant_id = str(config_row.get("tenant_id") or "").strip()
    if not tenant_id:
        return

    enabled, cron = _extract_schedule_fields(config_row, default_cron=_DISPOSITION_DEFAULT_CRON)
    schedule_id = _schedule_id_for_tenant(tenant_id, _DISPOSITION_AGENT_KEY)
    schedule_handle = client.get_schedule_handle(schedule_id)

    if not enabled:
        try:
            await schedule_handle.delete()
            logger.info("Deleted disabled disposition schedule", extra={"tenant_id": tenant_id, "schedule_id": schedule_id})
        except BaseException as exc:
            if not _is_not_found_error(exc):
                raise
        return

    desired_schedule = _build_disposition_schedule(tenant_id, cron)
    try:
        await schedule_handle.describe()
    except BaseException as exc:
        if not _is_not_found_error(exc):
            raise
        await client.create_schedule(schedule_id, desired_schedule)
        logger.info(
            "Created disposition schedule from config",
            extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
        )
        return

    await schedule_handle.update(
        lambda _: ScheduleUpdate(schedule=desired_schedule),
    )
    logger.info(
        "Updated disposition schedule from config",
        extra={"tenant_id": tenant_id, "schedule_id": schedule_id, "cron": cron},
    )


async def reconcile_disposition_schedules(client: Client, config_rows: Sequence[Mapping[str, Any]] | None = None) -> None:
    rows = list(config_rows) if config_rows is not None else await asyncio.to_thread(_fetch_disposition_schedule_rows)
    for row in rows:
        await _reconcile_tenant_disposition_schedule(client, row)


async def main() -> None:
    runtime = Runtime(
        telemetry=TelemetryConfig(
            metrics=PrometheusConfig(bind_address=_METRICS_BIND_ADDRESS)
        )
    )
    logger.info(
        "Connecting to Temporal",
        extra={
            "address": settings.temporal_address,
            "namespace": settings.temporal_namespace,
            "metrics_bind": _METRICS_BIND_ADDRESS,
        },
    )
    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
        runtime=runtime,
    )
    # Schedule reconciliation is best-effort: the worker's core job is running
    # workflows/activities, which must never be blocked by an ops-config issue.
    try:
        await reconcile_revrec_schedules(client)
    except Exception:  # noqa: BLE001 - never let schedule reconcile crash the worker
        logger.exception("revrec schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_pm_schedules(client)
    except Exception:  # noqa: BLE001 - never let PM schedule reconcile crash the worker
        logger.exception("PM schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_vehicle_aging_schedules(client)
    except Exception:  # noqa: BLE001 - never let vehicle-aging schedule reconcile crash the worker
        logger.exception("vehicle-aging schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_collections_schedules(client)
    except Exception:  # noqa: BLE001 - never let collections schedule reconcile crash the worker
        logger.exception("collections schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_parts_inventory_schedules(client)
    except Exception:  # noqa: BLE001 - never let parts-inventory schedule reconcile crash the worker
        logger.exception("parts-inventory schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_samsara_schedules(client)
    except Exception:  # noqa: BLE001 - never let samsara schedule reconcile crash the worker
        logger.exception("Samsara schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_coupa_schedules(client)
    except Exception:  # noqa: BLE001 - never let coupa schedule reconcile crash the worker
        logger.exception("Coupa schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_descartes_schedules(client)
    except Exception:  # noqa: BLE001 - never let descartes schedule reconcile crash the worker
        logger.exception("Descartes schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_fleet_schedules(client)
    except Exception:  # noqa: BLE001 - never let fleet schedule reconcile crash the worker
        logger.exception("Fleet schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_credit_schedules(client)
    except Exception:  # noqa: BLE001 - never let credit schedule reconcile crash the worker
        logger.exception("Credit schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_shop_schedules(client)
    except Exception:  # noqa: BLE001 - never let shop schedule reconcile crash the worker
        logger.exception("Shop schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_technician_schedules(client)
    except Exception:  # noqa: BLE001 - never let technician schedule reconcile crash the worker
        logger.exception("Technician schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_branch_schedules(client)
    except Exception:  # noqa: BLE001 - never let branch schedule reconcile crash the worker
        logger.exception("Branch schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_account_health_schedules(client)
    except Exception:  # noqa: BLE001 - never let account-health schedule reconcile crash the worker
        logger.exception("Account-health schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_integration_exception_schedules(client)
    except Exception:  # noqa: BLE001 - never let integration-exception schedule reconcile crash the worker
        logger.exception("Integration-exception schedule reconcile failed at startup; continuing to start worker")

    try:
        await reconcile_disposition_schedules(client)
    except Exception:  # noqa: BLE001 - never let disposition schedule reconcile crash the worker
        logger.exception("Disposition schedule reconcile failed at startup; continuing to start worker")

    activity_executor = ThreadPoolExecutor(max_workers=20)
    worker = Worker(
        client,
        task_queue=settings.temporal_task_queue,
        workflows=[
            ApprovalWorkflow,
            RentalOrderWorkflow,
            AssetUpdateWorkflow,
            AccountHealthQueueWorkflow,
            MuleSoftOutboundWorkflow,
            MuleSoftInboundCallbackWorkflow,
            SamsaraSyncWorkflow,
            CoupaSyncWorkflow,
            DescartesSyncWorkflow,
            RevenueRecognitionWorkflow,
            VehicleAgingWorkflow,
            CollectionsPrioritizerWorkflow,
            PartsInventoryWorkflow,
            ContractAnalysisWorkflow,
            ContractOcrRevalidationWorkflow,
            FleetUtilizationWorkflow,
            CreditRiskWorkflow,
            CreditLienControlWorkflow,
            BillingUpdateApprovalWorkflow,
            PMEvaluatorWorkflow,
            ShopMorningQueueWorkflow,
            SafetyComplianceMonitorWorkflow,
            TechnicianMorningQueueWorkflow,
            BranchMorningBriefWorkflow,
            IntegrationExceptionQueueWorkflow,
            TerritoryAccountBriefWorkflow,
            DispositionQueueWorkflow,
            TransferWorkflow,
            InspectionWorkflow,
            MaintenanceWorkflow,
            InvoiceWorkflow,
            MaintenanceCostingWorkflow,
            MaintenanceInvoiceWorkflow,
            AccountingPostingWorkflow,
        ],
        activities=[
            supabase_core.create_entity,
            supabase_core.update_entity_scd2,
            supabase_core.get_entity,
            supabase_core.append_event,
            supabase_core.create_relationship,
            mulesoft.mulesoft_prepare_outbound_delivery,
            mulesoft.mulesoft_send_outbound_delivery,
            mulesoft.mulesoft_process_inbound_callback,
            samsara_activities.samsara_load_sync_config,
            samsara_activities.samsara_fetch_scope_page,
            samsara_activities.samsara_persist_telemetry_batch,
            samsara_activities.samsara_advance_sync_cursor,
            coupa_activities.coupa_load_sync_config,
            coupa_activities.coupa_fetch_scope_page,
            coupa_activities.coupa_persist_procurement_batch,
            coupa_activities.coupa_advance_sync_cursor,
            descartes_activities.descartes_load_sync_config,
            descartes_activities.descartes_fetch_scope_page,
            descartes_activities.descartes_persist_scope_batch,
            descartes_activities.descartes_advance_sync_cursor,
            notifications.send_email,
            notifications.send_notification,
            rental_activities.create_rental_order,
            rental_activities.transition_order_status,
            rental_activities.assign_asset_to_order_line,
            rental_activities.convert_order_to_contract,
            rental_activities.transition_contract_status,
            rental_activities.get_asset_availability,
            rental_activities.checkout_contract_line,
            rental_activities.return_contract_line,
            rental_operations.get_asset_status,
            rental_operations.check_asset_transferable,
            rental_operations.check_asset_maintenance_openable,
            rental_operations.create_transfer_record,
            rental_operations.record_transfer_milestone,
            rental_operations.update_asset_branch,
            rental_operations.create_inspection_record,
            rental_operations.resolve_post_inspection_status,
            rental_operations.create_maintenance_record,
            rental_operations.complete_maintenance_record,
            rental_operations.resolve_asset_maintenance_completion_status,
            rental_operations.record_maintenance_completion_event,
            rental_operations.record_asset_downtime,
            rental_operations.create_invoice_record,
            rental_operations.derive_invoiceable_line_items,
            rental_operations.evaluate_invoice_readiness,
            rental_operations.compute_invoice_totals,
            rental_operations.finalise_invoice,
            rental_operations.add_maintenance_cost_line,
            rental_operations.compute_maintenance_work_order_totals,
            rental_operations.check_maintenance_invoice_exists,
            rental_operations.create_maintenance_invoice,
            ops_revrec.ops_load_agent_config,
            ops_revrec.ops_scope_revrec_contracts,
            ops_revrec.ops_list_open_finding_fingerprints,
            ops_revrec.ops_create_workflow_run,
            ops_revrec.ops_finalize_workflow_run,
            ops_revrec.ops_revrec_analyze,
            ops_revrec.ops_record_finding,
            ops_revrec.ops_record_finding_disposition,
            ops_revrec.ops_draft_invoice_adjustment,
            ops_vehicle_aging.ops_load_agent_config,
            ops_vehicle_aging.ops_scope_vehicle_aging,
            ops_vehicle_aging.ops_vehicle_aging_assess,
            ops_vehicle_aging.ops_list_open_finding_fingerprints,
            ops_vehicle_aging.ops_vehicle_aging_expire_out_of_scope_findings,
            ops_vehicle_aging.ops_create_workflow_run,
            ops_vehicle_aging.ops_finalize_workflow_run,
            ops_vehicle_aging.ops_record_finding,
            ops_vehicle_aging.ops_record_finding_disposition,
            *_COLLECTIONS_ACTIVITIES,
            *_PARTS_INVENTORY_ACTIVITIES,
            ops_contract_ocr.ops_contract_ocr_revalidate_pages,
            ops_contract_ocr.ops_contract_analyze_contract,
            ops_fleet.ops_load_agent_config,
            ops_fleet.ops_scope_fleet_assets,
            ops_fleet.ops_fleet_assess,
            ops_fleet.ops_list_open_finding_fingerprints,
            ops_fleet.ops_create_workflow_run,
            ops_fleet.ops_finalize_workflow_run,
            ops_fleet.ops_record_finding,
            ops_fleet.ops_record_finding_disposition,
            ops_fleet.ops_draft_disposition_handoff,
            ops_fleet.ops_requires_transfer_approval,
            ops_fleet.ops_transfer_request_payload,
            ops_credit.ops_load_agent_config,
            ops_credit.ops_scope_credit_accounts,
            ops_credit.ops_credit_assess,
            ops_llm_usage.persist_llm_usage_event,
            ops_credit.ops_list_open_finding_fingerprints,
            ops_credit.ops_list_existing_findings,
            ops_credit.ops_create_workflow_run,
            ops_credit.ops_finalize_workflow_run,
            ops_credit.ops_record_finding,
            ops_credit.ops_record_finding_disposition,
            ops_credit.ops_apply_credit_change,
            ops_credit.ops_scope_credit_applications,
            ops_credit.ops_application_assess,
            ops_credit.ops_scope_lien_deadlines,
            ops_credit.ops_lien_deadline_assess,
            ops_credit.ops_scope_lien_waivers,
            ops_credit.ops_lien_waiver_assess,
            ops_billing_update.ops_load_pending_billing_update_requests,
            ops_billing_update.ops_mark_billing_update_under_review,
            ops_billing_update.ops_record_billing_update_decision,
            ops_billing_update.ops_apply_billing_update,
            accounting_activities.post_invoice_issued,
            accounting_activities.post_invoice_void,
            accounting_activities.post_payment_applied,
            accounting_activities.post_payment_refund,
            accounting_activities.post_fee_charged,
            accounting_activities.post_credit_applied,
            accounting_activities.post_reversal_entry,
            ops_pm.pm_scope_enabled_policies,
            ops_pm.pm_evaluate_trigger,
            ops_pm.pm_list_open_wo_fingerprints,
            ops_pm.pm_upsert_work_order,
            ops_pm.pm_record_rental_completion,
            ops_shop_queue.ops_shop_queue_scope,
            ops_shop_queue.ops_shop_queue_assess,
            ops_shop_queue.ops_load_agent_config,
            ops_shop_queue.ops_list_open_finding_fingerprints,
            ops_shop_queue.ops_create_workflow_run,
            ops_shop_queue.ops_finalize_workflow_run,
            ops_shop_queue.ops_record_finding,
            ops_shop_queue.ops_record_finding_disposition,
            ops_safety_compliance_monitor.ops_safety_compliance_scope,
            ops_safety_compliance_monitor.ops_safety_compliance_assess,
            ops_safety_compliance_monitor.ops_load_agent_config,
            ops_safety_compliance_monitor.ops_list_open_finding_fingerprints,
            ops_safety_compliance_monitor.ops_create_workflow_run,
            ops_safety_compliance_monitor.ops_finalize_workflow_run,
            ops_safety_compliance_monitor.ops_record_finding,
            ops_technician_queue.ops_technician_queue_scope,
            ops_technician_queue.ops_technician_queue_assess,
            ops_technician_queue.ops_load_agent_config,
            ops_technician_queue.ops_list_open_finding_fingerprints,
            ops_technician_queue.ops_create_workflow_run,
            ops_technician_queue.ops_finalize_workflow_run,
            ops_technician_queue.ops_record_finding,
            ops_technician_queue.ops_record_finding_disposition,
            ops_branch_brief.ops_branch_brief_scope,
            ops_branch_brief.ops_branch_brief_assess,
            ops_branch_brief.ops_load_agent_config,
            ops_branch_brief.ops_list_open_finding_fingerprints,
            ops_branch_brief.ops_create_workflow_run,
            ops_branch_brief.ops_finalize_workflow_run,
            ops_branch_brief.ops_record_finding,
            ops_branch_brief.ops_record_finding_disposition,
            ops_account_health.ops_account_health_scope,
            ops_account_health.ops_account_health_assess,
            ops_account_health.ops_load_agent_config,
            ops_account_health.ops_list_open_finding_fingerprints,
            ops_account_health.ops_create_workflow_run,
            ops_account_health.ops_finalize_workflow_run,
            ops_account_health.ops_record_finding,
            ops_account_health.ops_record_finding_disposition,
            ops_integration_exception.ops_integration_exception_scope,
            ops_integration_exception.ops_integration_exception_assess,
            ops_integration_exception.ops_load_agent_config,
            ops_integration_exception.ops_list_open_finding_fingerprints,
            ops_integration_exception.ops_create_workflow_run,
            ops_integration_exception.ops_finalize_workflow_run,
            ops_integration_exception.ops_record_finding,
            ops_integration_exception.ops_record_finding_disposition,
            ops_territory_brief.ops_territory_brief_scope,
            ops_territory_brief.ops_territory_brief_assess,
            ops_territory_brief.ops_load_agent_config,
            ops_territory_brief.ops_list_open_finding_fingerprints,
            ops_territory_brief.ops_create_workflow_run,
            ops_territory_brief.ops_finalize_workflow_run,
            ops_territory_brief.ops_record_finding,
            ops_territory_brief.ops_record_finding_disposition,
            ops_dispatch_snapshot.ops_dispatch_snapshot_scope,
            ops_dispatch_snapshot.ops_load_agent_config,
            ops_dispatch_snapshot.ops_list_open_finding_fingerprints,
            ops_dispatch_snapshot.ops_create_workflow_run,
            ops_dispatch_snapshot.ops_finalize_workflow_run,
            ops_dispatch_snapshot.ops_record_finding,
            ops_dispatch_snapshot.ops_record_finding_disposition,
            ops_disposition.ops_disposition_scope,
            ops_disposition.ops_disposition_assess,
            ops_disposition.ops_disposition_list_existing_findings,
            ops_disposition.ops_disposition_retire_stale_findings,
            ops_disposition.ops_load_agent_config,
            ops_disposition.ops_list_open_finding_fingerprints,
            ops_disposition.ops_create_workflow_run,
            ops_disposition.ops_finalize_workflow_run,
            ops_disposition.ops_record_finding,
            ops_disposition.ops_record_finding_disposition,
            ops_disposition.ops_record_finding_review,
        ],
        activity_executor=activity_executor,
    )

    logger.info("Worker started", extra={"task_queue": settings.temporal_task_queue})
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
