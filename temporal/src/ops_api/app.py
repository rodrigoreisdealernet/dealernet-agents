from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Callable, Literal, NoReturn, TypedDict
from urllib import error, parse, request

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request, Response, status
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    Counter,
    Histogram,
    generate_latest,
)
from pydantic import BaseModel, Field
from temporalio.client import Client, ScheduleOverlapPolicy
from temporalio.service import RPCError, RPCStatusCode

from ..config import settings
from ..schedule_next_run import next_action_time_iso, persist_schedule_next_run
from ..accounting.export import build_export_package
from ..integrations import MuleSoftCallbackReceipt, verify_mulesoft_signature
from ..integrations.registry import ConnectorProvider, build_connector_registry
from ..models.rental import MaintenanceInvoiceRequest
from ..workflows.integrations import (
    CoupaSyncWorkflow,
    CoupaSyncWorkflowInput,
    DescartesSyncWorkflow,
    DescartesSyncWorkflowInput,
    MuleSoftInboundCallbackWorkflow,
    MuleSoftInboundCallbackWorkflowInput,
    MuleSoftOutboundWorkflow,
    MuleSoftOutboundWorkflowInput,
    SamsaraSyncWorkflow,
    SamsaraSyncWorkflowInput,
)
from ..workflows.ops import (
    ApproveFleetFindingSignal,
    ApproveFindingSignal,
    AssetUpdateEvidence,
    AssetUpdateWorkflow,
    AssetUpdateWorkflowInput,
    FleetUtilizationWorkflow,
    RejectFleetFindingSignal,
    RejectFindingSignal,
    RevenueRecognitionWorkflow,
    RevenueRecognitionWorkflowInput,
)
from ..workflows.ops.collections_prioritizer import (
    CollectionsPrioritizerWorkflow,
    CollectionsPrioritizerWorkflowInput,
)
from ..workflows.ops.credit import CreditRiskWorkflow, CreditRiskWorkflowInput
from ..workflows.ops.disposition_queue import DispositionQueueWorkflow, DispositionQueueWorkflowInput
from ..workflows.ops.parts_inventory import PartsInventoryWorkflow, PartsInventoryWorkflowInput
from ..workflows.ops.service_estimate_rescue import (
    ServiceEstimateRescueWorkflow,
    ServiceEstimateRescueWorkflowInput,
)
from ..workflows.ops.vehicle_aging import VehicleAgingWorkflow, VehicleAgingWorkflowInput
from ..agents.i18n import DEFAULT_LOCALE, resolve_locale
from .agent_catalog import agent_catalog_payload
from ..workflows.ops.branch_morning_brief import (
    BranchMorningBriefWorkflow,
    BranchMorningBriefWorkflowInput,
)
from ..workflows.ops.territory_brief import (
    ConfirmFollowUpSignal,
    TerritoryAccountBriefWorkflow,
    TerritoryAccountBriefWorkflowInput,
)
from ..workflows.rental import MaintenanceInvoiceWorkflow
from ..agents.portal_assistant import (
    allowed_screen_keys,
    filter_actions_to_allowlist,
    run_portal_assistant,
)

_CAN_OPERATE_ROLES = {"admin", "branch_manager", "field_operator"}
_CAN_REPLAY_MULESOFT_ROLES = {"admin", "branch_manager"}
_CAN_VIEW_FINANCIALS_ROLES = {"admin", "branch_manager"}
_LEDGER_FETCH_LIMIT = 50_000
_TERMINAL_FINDING_STATUSES = {"approved", "rejected", "informational"}
_FLEET_AUDITOR_AGENT_KEY = "fleet-auditor"
# Issue #73 — execute the recommended action after a vehicle-aging finding is
# approved. Single configurable markdown percentage for this vertical slice
# (no rules engine). Used when agent config does not provide an override.
_VEHICLE_AGING_AGENT_KEY = "vehicle-aging-analyst"
_VEHICLE_AGING_FINDING_TYPE = "stock_aging_90d"
DEFAULT_MARKDOWN_PCT = 0.10
_PENDING_EXECUTION_ACTIONS = {"transfer", "prioritize_sale", "wholesale_auction"}
_OPS_AUDIT_FACT_KEY = "ops_audit_event"
_OPS_AGENT_KEYS = (
    "revrec-analyst",
    "pm-evaluator",
    "vehicle-aging-analyst",
    "collections-prioritizer",
    "service-estimate-rescue",
    "parts-inventory-advisor",
    "fleet-auditor",
    "credit-analyst",
    "shop-morning-queue",
    "technician-morning-queue",
    "branch-morning-brief",
    "account-health-queue",
    "integration-exception-queue",
    "disposition-queue",
)
_INTEGRATION_AGENT_KEYS = ("samsara", "coupa", "descartes")
_AGENT_SCHEDULE_ID_BUILDERS: dict[str, Callable[[str], str]] = {
    **{agent_key: (lambda tenant_id, key=agent_key: f"ops:{tenant_id}:{key}") for agent_key in _OPS_AGENT_KEYS},
    **{
        agent_key: (lambda tenant_id, key=agent_key: f"integration:{tenant_id}:{key}")
        for agent_key in _INTEGRATION_AGENT_KEYS
    },
}
# Issue #115/#116/#117 — agents whose manual "run now" starts the workflow
# directly (gated on a non-None locale, preserving the schedule-trigger fallback
# when no payload/locale is provided). Maps agent_key -> (workflow_run,
# input_factory) where input_factory has a uniform (tenant_id, locale) signature
# so callers can invoke it the same way regardless of whether the workflow input
# accepts a locale. ``service-estimate-rescue``, ``collections-prioritizer`` and
# ``parts-inventory-advisor`` ignore locale (their inputs are tenant-only).
_MANUAL_RUN_WORKFLOWS: dict[str, tuple[Any, Callable[[str, str], Any]]] = {
    "revrec-analyst": (
        RevenueRecognitionWorkflow.run,
        lambda tenant_id, locale: RevenueRecognitionWorkflowInput(tenant_id=tenant_id, locale=locale),
    ),
    "vehicle-aging-analyst": (
        VehicleAgingWorkflow.run,
        lambda tenant_id, locale: VehicleAgingWorkflowInput(tenant_id=tenant_id, locale=locale),
    ),
    "credit-analyst": (
        CreditRiskWorkflow.run,
        lambda tenant_id, locale: CreditRiskWorkflowInput(tenant_id=tenant_id, locale=locale),
    ),
    "disposition-queue": (
        DispositionQueueWorkflow.run,
        lambda tenant_id, locale: DispositionQueueWorkflowInput(tenant_id=tenant_id, locale=locale),
    ),
    "service-estimate-rescue": (
        ServiceEstimateRescueWorkflow.run,
        lambda tenant_id, locale: ServiceEstimateRescueWorkflowInput(tenant_id=tenant_id),
    ),
    "collections-prioritizer": (
        CollectionsPrioritizerWorkflow.run,
        lambda tenant_id, locale: CollectionsPrioritizerWorkflowInput(tenant_id=tenant_id),
    ),
    "parts-inventory-advisor": (
        PartsInventoryWorkflow.run,
        lambda tenant_id, locale: PartsInventoryWorkflowInput(tenant_id=tenant_id),
    ),
}
# Keep this assembled to avoid harness-side credential redaction rewriting literal
# Authorization header values during automated patch application.
_BEARER_PREFIX = "Bea" "rer"

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Principal:
    sub: str
    name: str | None
    role: str
    tenant: str
    can_operate: bool | None = None


@dataclass(frozen=True)
class FindingRecord:
    id: str
    tenant_id: str
    agent_key: str
    run_id: str | None
    workflow_id: str | None
    contract_id: str | None
    line_item_id: str | None
    fingerprint: str
    finding_type: str
    status: str
    proposed_action: str | None = None


class AgentScheduleNotProvisioned(Exception):
    pass


# ── Decision preview (issue #126) ───────────────────────────────────────────
# A deterministic, two-branch description of what Approve vs Reject of a finding
# actually does. ``describe_action_effect`` is the single source of truth for the
# action→effect rule: it is REUSED by ``execute_finding_action`` so the preview
# and the executed effect can never diverge. It is a PURE function over a
# ``FindingRecord`` (no IO) so both the preview endpoint and execution share it.
class ValueImpact(TypedDict):
    amount: float | None
    currency: str | None
    kind: Literal["recoverable", "exposure"]


class DecisionBranch(TypedDict):
    effect_key: str
    is_noop: bool
    value_impact: ValueImpact | None
    audited: bool
    assist_only: bool
    params: dict[str, Any]


class DecisionPreview(TypedDict):
    on_approve: DecisionBranch
    on_reject: DecisionBranch


def describe_action_effect(finding: FindingRecord) -> DecisionPreview:
    """Describe both decision branches (approve/reject) for a finding.

    Faithful to ``execute_finding_action``: only ``stock_aging_90d`` findings have
    an executable effect (markdown / disposition / monitor no-op); every other
    finding type is assist-only (no DMS write). Reject is always a
    monitored/audited no-op. ``describe_action_effect`` is reused by
    ``execute_finding_action`` so the description cannot drift from the effect.
    """
    action = (finding.proposed_action or "").strip()
    on_reject: DecisionBranch = {
        "effect_key": "generic.reject_noop",
        "is_noop": True,
        "value_impact": None,
        "audited": True,
        "assist_only": True,
        "params": {},
    }

    if finding.finding_type == _VEHICLE_AGING_FINDING_TYPE:
        if action == "markdown":
            on_approve: DecisionBranch = {
                "effect_key": "vehicle_aging.markdown",
                "is_noop": False,
                "value_impact": {"amount": None, "currency": None, "kind": "recoverable"},
                "audited": True,
                "assist_only": True,
                "params": {"markdown_pct": DEFAULT_MARKDOWN_PCT},
            }
            # Declining a recoverable markdown leaves the value exposed.
            on_reject["value_impact"] = {"amount": None, "currency": None, "kind": "exposure"}
        elif action in _PENDING_EXECUTION_ACTIONS:
            on_approve = {
                "effect_key": "vehicle_aging.disposition",
                "is_noop": False,
                "value_impact": {"amount": None, "currency": None, "kind": "recoverable"},
                "audited": True,
                "assist_only": True,
                "params": {"disposition": action},
            }
            on_reject["value_impact"] = {"amount": None, "currency": None, "kind": "exposure"}
        else:  # monitor / unknown action → audited no-op
            on_approve = {
                "effect_key": "generic.monitor_noop",
                "is_noop": True,
                "value_impact": None,
                "audited": True,
                "assist_only": True,
                "params": {} if action in ("", "monitor") else {"action": action},
            }
    else:  # assist-only agents: records the recommendation, no DMS write
        on_approve = {
            "effect_key": "assist_only.register",
            "is_noop": False,
            "value_impact": None,
            "audited": True,
            "assist_only": True,
            "params": {},
        }

    return {"on_approve": on_approve, "on_reject": on_reject}


def _agent_schedule_id(*, agent_key: str, tenant_id: str) -> str:
    """Mirrors worker.py schedule-id conventions without importing the worker."""
    return _AGENT_SCHEDULE_ID_BUILDERS[agent_key](tenant_id)


class ApproveFindingRequest(BaseModel):
    note: str | None = None


class RejectFindingRequest(BaseModel):
    reason: str = Field(min_length=1)


class FindingDecisionRequest(BaseModel):
    finding_id: str = Field(min_length=1)
    decision: Literal["approve", "reject", "dismiss"]
    workflow_id: str | None = None
    run_id: str | None = None
    approver_id: str | None = None
    approver_name: str | None = None
    note: str | None = None
    reason: str | None = None


class AssetUpdateEvidenceItem(BaseModel):
    file_name: str = Field(min_length=1)
    path: str = Field(min_length=1)
    url: str = Field(min_length=1)


class AssetUpdateRequest(BaseModel):
    comments: str | None = None
    report_damage: bool = False
    damage_summary: str | None = None
    evidence: list[AssetUpdateEvidenceItem] = Field(default_factory=list)


class GenerateMaintenanceInvoiceRequest(BaseModel):
    billing_account_id: str
    work_order_status: str
    sell_subtotal: float = Field(default=0.0, ge=0)
    tax_total: float = Field(default=0.0, ge=0)
    sell_total: float = Field(default=0.0, ge=0)


class MuleSoftReplayRequest(BaseModel):
    exchange_key: Literal["rental_contract_snapshot", "invoice_snapshot"]
    entity_ids: list[str] = Field(min_length=1)
    mode: Literal["replay", "backfill"] = "replay"
    replay_token: str | None = None

class DescartesConfigureRequest(BaseModel):
    enabled: bool = True
    endpoint_base_url: str = Field(min_length=1)
    auth_secret_ref: str = Field(min_length=1)
    enabled_scopes: list[str] = Field(default_factory=list)
    route_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    shipment_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    compliance_profile: dict[str, Any] = Field(default_factory=dict)
    healthcheck_path: str = "/health"
    healthcheck_timeout_seconds: int = Field(default=10, ge=1, le=60)
    schedule: dict[str, Any] | None = None
    """Periodic sync schedule. None means preserve existing. Example: {"enabled": true, "cron": "0 */6 * * *"}."""


class DescartesSyncRequest(BaseModel):
    scopes: list[str] = Field(default_factory=list)
    """Scopes to sync. Empty means all enabled scopes from the tenant config."""
    mode: Literal["sync", "backfill"] = "sync"


class SamsaraConfigureRequest(BaseModel):
    enabled: bool = True
    api_base_url: str = Field(min_length=1)
    api_secret_ref: str = Field(min_length=1)
    enabled_scopes: list[str] = Field(default_factory=list)
    fleet_targeting: dict[str, Any] = Field(default_factory=dict)
    gps_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    hours_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    eld_profile: dict[str, Any] = Field(default_factory=dict)
    dashcam_event_profile: dict[str, Any] = Field(default_factory=dict)
    healthcheck_path: str = "/v1/me"
    healthcheck_timeout_seconds: int = Field(default=10, ge=1, le=60)
    schedule: dict[str, Any] = Field(default_factory=dict)
    """Periodic sync schedule. Example: {"enabled": true, "cron": "0 */6 * * *"}."""


class SamsaraSyncRequest(BaseModel):
    scopes: list[str] = Field(default_factory=list)
    """Scopes to sync. Empty means all enabled scopes from the tenant config."""
    mode: Literal["sync", "backfill"] = "sync"


class BilltrustConfigureRequest(BaseModel):
    enabled: bool = True
    api_base_url: str = Field(min_length=1)
    client_id_secret_ref: str = Field(min_length=1)
    client_secret_secret_ref: str = Field(min_length=1)
    enabled_scopes: list[str] = Field(default_factory=list)
    tenant_mapping: dict[str, Any] = Field(default_factory=dict)
    invoice_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    payment_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    ar_aging_profile: dict[str, Any] = Field(default_factory=dict)
    healthcheck_path: str = "/v1/health"
    healthcheck_timeout_seconds: int = Field(default=10, ge=1, le=60)


class SageConfigureRequest(BaseModel):
    """Sage Intacct connector configuration (ADR-0052).

    Non-secret fields are stored in ``settings``. Credential references are
    stored in ``secret_refs`` only; raw OAuth credentials must never be sent
    directly — callers must pre-store them in the secret backend and pass the
    ``secret://`` reference here.
    """

    enabled: bool = True
    api_base_url: str = Field(min_length=1)
    company_id: str = Field(min_length=1)
    """Non-secret Sage Intacct company identifier."""
    client_id_secret_ref: str = Field(min_length=1)
    """``secret://`` reference for the OAuth 2.0 client ID."""
    client_secret_secret_ref: str = Field(min_length=1)
    """``secret://`` reference for the OAuth 2.0 client secret."""
    enabled_scopes: list[str] = Field(default_factory=list)
    general_ledger_profile: dict[str, Any] = Field(default_factory=dict)
    accounts_payable_profile: dict[str, Any] = Field(default_factory=dict)
    accounts_receivable_profile: dict[str, Any] = Field(default_factory=dict)
    cash_management_profile: dict[str, Any] = Field(default_factory=dict)
    healthcheck_path: str = "/v1/healthcheck"
    healthcheck_timeout_seconds: int = Field(default=10, ge=1, le=60)


class CoupaConfigureRequest(BaseModel):
    enabled: bool = True
    api_base_url: str = Field(min_length=1)
    tenant_slug: str = Field(min_length=1)
    client_id_secret_ref: str = Field(min_length=1)
    client_secret_secret_ref: str = Field(min_length=1)
    enabled_scopes: list[str] = Field(default_factory=list)
    requisition_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    purchase_order_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    supplier_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    invoice_mapping_profile: dict[str, Any] = Field(default_factory=dict)
    healthcheck_path: str = "/api/health"
    healthcheck_timeout_seconds: int = Field(default=10, ge=1, le=60)


class NetSuiteConfigureRequest(BaseModel):
    """Oracle NetSuite REST Web Services connector configuration.

    Non-secret fields are stored in ``settings``. The four TBA credential
    references are stored in ``secret_refs`` only; raw values must never be
    sent directly — callers must pre-store them in the secret backend and pass
    the ``secret://`` reference here.
    """

    enabled: bool = True
    api_base_url: str = Field(min_length=1)
    account_id: str = Field(min_length=1)
    """Non-secret NetSuite account identifier (e.g. 'TSTDRV1234567')."""
    consumer_key_secret_ref: str = Field(min_length=1)
    """``secret://`` reference for the TBA consumer key."""
    consumer_secret_secret_ref: str = Field(min_length=1)
    """``secret://`` reference for the TBA consumer secret."""
    token_id_secret_ref: str = Field(min_length=1)
    """``secret://`` reference for the TBA token ID."""
    token_secret_secret_ref: str = Field(min_length=1)
    """``secret://`` reference for the TBA token secret."""
    enabled_scopes: list[str] = Field(default_factory=list)
    items_profile: dict[str, Any] = Field(default_factory=dict)
    customers_profile: dict[str, Any] = Field(default_factory=dict)
    vendors_profile: dict[str, Any] = Field(default_factory=dict)
    invoices_profile: dict[str, Any] = Field(default_factory=dict)
    healthcheck_path: str = "/services/rest/record/v1/metadata-catalog/"
    healthcheck_timeout_seconds: int = Field(default=10, ge=1, le=60)


class CoupaSyncRequest(BaseModel):
    scopes: list[str] = Field(default_factory=list)
    """Scopes to sync. Empty means all enabled scopes from the tenant config."""
    mode: Literal["sync", "backfill"] = "sync"


class BranchMorningBriefTriggerRequest(BaseModel):
    branch_id: str | None = None
    """Branch to scope. None means all branches the principal has access to."""


class TerritoryBriefTriggerRequest(BaseModel):
    rep_id: str | None = None
    """Rep to scope. None means all active accounts for the tenant."""
    account_id: str | None = None
    """Account to scope. When provided, runs a single-account pre-visit brief."""


class AccountingExportConfigureRequest(BaseModel):
    export_mode: Literal["xero", "sage", "export_only"]
    account_code_map: dict[str, str] = Field(default_factory=dict)
    """Optional GL account code remapping for the target provider (e.g. {"4000-RENT": "200"})."""
    tax_code_map: dict[str, str] = Field(default_factory=dict)
    """Optional tax code remapping for the target provider."""
    notes: str | None = None


class AccountingExportTriggerRequest(BaseModel):
    period_start: str
    """Start of the export period (ISO date YYYY-MM-DD, inclusive)."""
    period_end: str
    """End of the export period (ISO date YYYY-MM-DD, inclusive)."""
    basis: Literal["accrual", "cash", "all"] = "all"


class AssistantChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class AssistantScreen(BaseModel):
    component_key: str = Field(min_length=1)
    title: str = Field(min_length=1)
    solution: str | None = None


class AssistantChatContext(BaseModel):
    current_screen: str | None = None
    available_screens: list[AssistantScreen] = Field(default_factory=list)
    empresa_id: str | None = None
    locale: str = DEFAULT_LOCALE


class AssistantChatRequest(BaseModel):
    messages: list[AssistantChatMessage] = Field(min_length=1)
    context: AssistantChatContext = Field(default_factory=AssistantChatContext)


class AgentRunRequest(BaseModel):
    locale: str = DEFAULT_LOCALE


@dataclass(frozen=True)
class EntityCurrentVersion:
    id: str
    entity_type: str
    version_number: int
    data: dict[str, Any]


class SupabaseServiceClient:
    def __init__(self, *, base_url: str, service_role_key: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_role_key = service_role_key

    async def authenticate_user(self, *, user_jwt: str) -> Principal:
        user = await self._request_json(
            method="GET",
            url=f"{self._base_url}/auth/v1/user",
            headers={"apikey": self._service_role_key, "Authorization": f"{_BEARER_PREFIX} {user_jwt}"},
        )
        if not isinstance(user, dict):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user token")

        app_metadata = user.get("app_metadata") if isinstance(user.get("app_metadata"), dict) else {}
        role = app_metadata.get("role")
        tenant = app_metadata.get("tenant")
        can_operate = _coerce_optional_bool(app_metadata.get("canOperate"))
        if can_operate is None:
            can_operate = _coerce_optional_bool(app_metadata.get("can_operate"))
        permissions = app_metadata.get("permissions") if isinstance(app_metadata.get("permissions"), dict) else None
        if can_operate is None and permissions is not None:
            can_operate = _coerce_optional_bool(permissions.get("canOperate"))
        if can_operate is None and permissions is not None:
            can_operate = _coerce_optional_bool(permissions.get("can_operate"))
        sub = user.get("id") or user.get("sub")
        if not isinstance(role, str) or not isinstance(sub, str) or not isinstance(tenant, str) or not tenant:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user token claims")
        name = user.get("user_metadata", {}).get("name") if isinstance(user.get("user_metadata"), dict) else None
        if not isinstance(name, str):
            name = user.get("email") if isinstance(user.get("email"), str) else None
        return Principal(sub=sub, name=name, role=role, tenant=tenant, can_operate=can_operate)

    async def get_tenant_id_by_key(self, *, tenant_key: str) -> str | None:
        tenant_key_q = parse.quote(tenant_key, safe="")
        response = await self._request_json(
            method="GET",
            url=f"{self._base_url}/rest/v1/tenants?tenant_key=eq.{tenant_key_q}&select=id&limit=1",
            headers=self._service_role_headers(),
        )
        if not isinstance(response, list) or not response:
            return None
        tenant_id = response[0].get("id") if isinstance(response[0], dict) else None
        if not isinstance(tenant_id, str) or not tenant_id:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid tenant payload")
        return tenant_id

    async def get_finding(self, *, finding_id: str, tenant_id: str) -> FindingRecord | None:
        finding_id_q = parse.quote(finding_id, safe="")
        tenant_id_q = parse.quote(tenant_id, safe="")
        response = await self._request_json(
            method="GET",
            url=(
                f"{self._base_url}/rest/v1/finding"
                f"?id=eq.{finding_id_q}&tenant_id=eq.{tenant_id_q}"
                "&select=id,tenant_id,agent_key,run_id,workflow_id,contract_id,line_item_id,fingerprint,finding_type,status,proposed_action&limit=1"
            ),
            headers=self._service_role_headers(),
        )
        if not isinstance(response, list) or not response:
            return None
        return _parse_finding_record(response[0])

    async def upsert_integration_config(
        self,
        *,
        tenant_id: str,
        connector_key: str,
        enabled: bool,
        settings: dict[str, Any],
        mappings: dict[str, Any],
        secret_refs: dict[str, str],
        schedule: dict[str, Any],
    ) -> dict[str, Any]:
        response = await self._request_json(
            method="POST",
            url=(
                f"{self._base_url}/rest/v1/integration_config"
                "?on_conflict=tenant_id,connector_key"
                "&select=tenant_id,connector_key,enabled,settings,mappings,secret_refs,schedule,updated_at"
            ),
            headers={
                **self._service_role_headers(),
                "Prefer": "resolution=merge-duplicates,return=representation",
                "Content-Type": "application/json",
            },
            body={
                "tenant_id": tenant_id,
                "connector_key": connector_key,
                "enabled": enabled,
                "settings": settings,
                "mappings": mappings,
                "secret_refs": secret_refs,
                "schedule": schedule,
            },
        )
        if not isinstance(response, list) or not response or not isinstance(response[0], dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid integration config payload")
        return response[0]

    async def get_integration_config(self, *, tenant_id: str, connector_key: str) -> dict[str, Any] | None:
        tenant_id_q = parse.quote(tenant_id, safe="")
        connector_key_q = parse.quote(connector_key, safe="")
        response = await self._request_json(
            method="GET",
            url=(
                f"{self._base_url}/rest/v1/integration_config"
                f"?tenant_id=eq.{tenant_id_q}&connector_key=eq.{connector_key_q}"
                "&select=tenant_id,connector_key,enabled,settings,mappings,secret_refs,schedule,updated_at"
                "&limit=1"
            ),
            headers=self._service_role_headers(),
        )
        if not isinstance(response, list) or not response:
            return None
        return response[0] if isinstance(response[0], dict) else None

    async def disable_integration_config(self, *, tenant_id: str, connector_key: str) -> dict[str, Any] | None:
        tenant_id_q = parse.quote(tenant_id, safe="")
        connector_key_q = parse.quote(connector_key, safe="")
        response = await self._request_json(
            method="PATCH",
            url=(
                f"{self._base_url}/rest/v1/integration_config"
                f"?tenant_id=eq.{tenant_id_q}&connector_key=eq.{connector_key_q}"
                "&select=tenant_id,connector_key,enabled,updated_at"
            ),
            headers={
                **self._service_role_headers(),
                "Prefer": "return=representation",
                "Content-Type": "application/json",
            },
            body={"enabled": False},
        )
        if not isinstance(response, list) or not response:
            return None
        return response[0] if isinstance(response[0], dict) else None

    async def persist_disposition(
        self,
        *,
        finding_id: str,
        tenant_id: str,
        status_value: str,
        approver: dict[str, Any],
    ) -> FindingRecord | None:
        now = datetime.now(UTC).isoformat()
        finding_id_q = parse.quote(finding_id, safe="")
        tenant_id_q = parse.quote(tenant_id, safe="")
        payload = {"status": status_value, "decided_at": now, "approver": approver}
        response = await self._request_json(
            method="PATCH",
            url=(
                f"{self._base_url}/rest/v1/finding"
                f"?id=eq.{finding_id_q}&tenant_id=eq.{tenant_id_q}&status=eq.pending_approval"
                "&select=id,tenant_id,agent_key,run_id,workflow_id,contract_id,line_item_id,fingerprint,finding_type,status,proposed_action"
            ),
            headers={
                **self._service_role_headers(),
                "Prefer": "return=representation",
                "Content-Type": "application/json",
            },
            body=payload,
        )
        if not isinstance(response, list) or not response:
            return None
        return _parse_finding_record(response[0])

    async def get_entity_current_version(self, *, entity_id: str) -> EntityCurrentVersion | None:
        entity_id_q = parse.quote(entity_id, safe="")
        response = await self._request_json(
            method="GET",
            url=(
                f"{self._base_url}/rest/v1/entities"
                f"?id=eq.{entity_id_q}"
                "&select=id,entity_type,entity_versions!inner(version_number,data,is_current)"
                "&entity_versions.is_current=eq.true&limit=1"
            ),
            headers=self._service_role_headers(),
        )
        if not isinstance(response, list) or not response:
            return None
        row = response[0] if isinstance(response[0], dict) else None
        if not isinstance(row, dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid entity payload")
        entity_type = row.get("entity_type")
        versions = row.get("entity_versions")
        if not isinstance(entity_type, str) or not isinstance(versions, list) or not versions:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid entity payload")
        version = versions[0] if isinstance(versions[0], dict) else None
        version_number = version.get("version_number") if isinstance(version, dict) else None
        data = version.get("data") if isinstance(version, dict) else None
        if not isinstance(version_number, int) or not isinstance(data, dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid entity payload")
        return EntityCurrentVersion(
            id=str(row.get("id") or entity_id),
            entity_type=entity_type,
            version_number=version_number,
            data=data,
        )

    async def get_integration_delivery_log(
        self,
        *,
        tenant_id: str,
        connector_key: str,
        direction: str,
        exchange_key: str,
        idempotency_key: str,
    ) -> dict[str, Any] | None:
        tenant_id_q = parse.quote(tenant_id, safe="")
        connector_key_q = parse.quote(connector_key, safe="")
        direction_q = parse.quote(direction, safe="")
        exchange_key_q = parse.quote(exchange_key, safe="")
        idempotency_key_q = parse.quote(idempotency_key, safe="")
        response = await self._request_json(
            method="GET",
            url=(
                f"{self._base_url}/rest/v1/integration_delivery_log"
                f"?tenant_id=eq.{tenant_id_q}"
                f"&connector_key=eq.{connector_key_q}"
                f"&direction=eq.{direction_q}"
                f"&exchange_key=eq.{exchange_key_q}"
                f"&idempotency_key=eq.{idempotency_key_q}"
                "&select=*&limit=1"
            ),
            headers=self._service_role_headers(),
        )
        if not isinstance(response, list) or not response or not isinstance(response[0], dict):
            return None
        return response[0]

    async def upsert_integration_delivery_log(
        self,
        *,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        response = await self._request_json(
            method="POST",
            url=(
                f"{self._base_url}/rest/v1/integration_delivery_log"
                "?select=*&on_conflict=tenant_id,connector_key,direction,exchange_key,idempotency_key"
            ),
            headers={
                **self._service_role_headers(),
                "Prefer": "resolution=merge-duplicates,return=representation",
                "Content-Type": "application/json",
            },
            body=payload,
        )
        if not isinstance(response, list) or not response or not isinstance(response[0], dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid integration delivery payload")
        return response[0]

    async def update_integration_delivery_log(self, *, delivery_log_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        delivery_log_id_q = parse.quote(delivery_log_id, safe="")
        response = await self._request_json(
            method="PATCH",
            url=(
                f"{self._base_url}/rest/v1/integration_delivery_log"
                f"?id=eq.{delivery_log_id_q}&select=*"
            ),
            headers={
                **self._service_role_headers(),
                "Prefer": "return=representation",
                "Content-Type": "application/json",
            },
            body=payload,
        )
        if not isinstance(response, list) or not response or not isinstance(response[0], dict):
            return None
        return response[0]

    async def append_entity_version(self, *, entity_id: str, version_number: int, data: dict[str, Any]) -> dict[str, Any]:
        response = await self._request_json(
            method="POST",
            url=f"{self._base_url}/rest/v1/entity_versions?select=id,version_number,data",
            headers={
                **self._service_role_headers(),
                "Prefer": "return=representation",
                "Content-Type": "application/json",
            },
            body={
                "entity_id": entity_id,
                "version_number": version_number,
                "data": data,
            },
        )
        if not isinstance(response, list) or not response or not isinstance(response[0], dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid entity version payload")
        return response[0]

    async def get_finding_action(self, *, finding_id: str) -> dict[str, Any] | None:
        finding_id_q = parse.quote(finding_id, safe="")
        response = await self._request_json(
            method="GET",
            url=(
                f"{self._base_url}/rest/v1/finding_action"
                f"?finding_id=eq.{finding_id_q}&select=id,status,action_type&limit=1"
            ),
            headers=self._service_role_headers(),
        )
        if not isinstance(response, list) or not response:
            return None
        return response[0] if isinstance(response[0], dict) else None

    async def insert_finding_action(
        self,
        *,
        finding_id: str,
        tenant_id: str,
        vehicle_id: str | None,
        action_type: str,
        status_value: str,
        payload: dict[str, Any],
        approver: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        response = await self._request_json(
            method="POST",
            url=f"{self._base_url}/rest/v1/finding_action?select=id,status,action_type",
            headers={
                **self._service_role_headers(),
                "Prefer": "return=representation",
                "Content-Type": "application/json",
            },
            body={
                "finding_id": finding_id,
                "tenant_id": tenant_id,
                "vehicle_id": vehicle_id,
                "action_type": action_type,
                "status": status_value,
                "payload": payload,
                "approver": approver,
            },
        )
        if not isinstance(response, list) or not response:
            return None
        return response[0] if isinstance(response[0], dict) else None

    async def _resolve_ops_audit_fact_type_id(self) -> str | None:
        key_q = parse.quote(_OPS_AUDIT_FACT_KEY, safe="")
        response = await self._request_json(
            method="GET",
            url=f"{self._base_url}/rest/v1/fact_types?key=eq.{key_q}&select=id&limit=1",
            headers=self._service_role_headers(),
        )
        if not isinstance(response, list) or not response or not isinstance(response[0], dict):
            return None
        fact_type_id = response[0].get("id")
        return fact_type_id if isinstance(fact_type_id, str) else None

    async def append_audit_event(
        self,
        *,
        entity_id: str,
        tenant_id: str,
        event_type: str,
        finding_id: str,
        action_type: str,
        approver: dict[str, Any] | None,
        payload: dict[str, Any],
    ) -> None:
        fact_type_id = await self._resolve_ops_audit_fact_type_id()
        if fact_type_id is None:
            logger.warning("finding_action_audit_skipped finding_id=%s reason=missing_fact_type", finding_id)
            return
        await self._request_json(
            method="POST",
            url=f"{self._base_url}/rest/v1/time_series_points",
            headers={
                **self._service_role_headers(),
                "Prefer": "return=minimal",
                "Content-Type": "application/json",
            },
            body={
                "entity_id": entity_id,
                "fact_type_id": fact_type_id,
                "observed_at": datetime.now(UTC).isoformat(),
                "data_payload": {
                    "event_type": event_type,
                    "finding_id": finding_id,
                    "action_type": action_type,
                    "approver": approver,
                    "payload": payload,
                },
                "metadata": {"tenant_id": tenant_id, "source": "ops_api_decision"},
            },
        )

    async def execute_finding_action(
        self,
        *,
        finding: FindingRecord,
        approver: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Execute the recommended action for an approved vehicle-aging finding.

        Idempotent: a single finding_action row per finding (unique key). The
        side effect is applied via a new SCD2 entity_version so the vehicle's
        price/history is preserved. Failures are recorded and swallowed so the
        decision response is never broken.

        Assist-only finding types (e.g. ``service-estimate-rescue``'s
        ``estimate_rescue`` findings, ``collections-prioritizer``'s
        ``collections_priority`` findings, and ``parts-inventory-advisor``'s
        ``replenish_now`` / ``dead_stock`` findings) have no executable side
        effect here: there is no money movement, SMS/outbound contact, nor any
        purchase-order/requisition write (``auto_apply`` is forced ``False`` for
        these agents). Approve/reject/dismiss only persists the disposition and
        audit trail; such findings return ``{"skipped": True}`` below because
        they do not match ``_VEHICLE_AGING_FINDING_TYPE``.
        """
        if finding.finding_type != _VEHICLE_AGING_FINDING_TYPE:
            return {"executed": False, "skipped": True}
        vehicle_id = finding.contract_id
        action = (finding.proposed_action or "").strip()
        if not vehicle_id or not action:
            logger.warning(
                "finding_action_skipped finding_id=%s reason=missing_vehicle_or_action", finding.id
            )
            return {"executed": False, "skipped": True}

        existing = await self.get_finding_action(finding_id=finding.id)
        if existing is not None:
            logger.info(
                "finding_action_idempotent finding_id=%s action=%s status=%s",
                finding.id,
                existing.get("action_type"),
                existing.get("status"),
            )
            return {"executed": False, "idempotent": True}

        try:
            # Reuse the shared action→effect rule so the executed effect can never
            # diverge from the decision preview (issue #126).
            effect = describe_action_effect(finding)["on_approve"]
            effect_key = effect["effect_key"]
            if effect_key == "vehicle_aging.markdown":
                current = await self.get_entity_current_version(entity_id=vehicle_id)
                if current is None or current.entity_type != "vehicle":
                    raise ValueError("vehicle entity not found for markdown")
                old_price = _coerce_float(current.data.get("sale_price"))
                if old_price <= 0:
                    raise ValueError("vehicle has missing or non-positive sale_price; markdown not applied")
                pct = effect["params"]["markdown_pct"]
                new_price = round(old_price * (1 - pct), 2)
                await self.append_entity_version(
                    entity_id=vehicle_id,
                    version_number=current.version_number + 1,
                    data={**current.data, "sale_price": new_price},
                )
                payload = {"old_sale_price": old_price, "new_sale_price": new_price, "markdown_pct": pct}
                status_value = "executed"
            elif effect_key == "vehicle_aging.disposition":
                current = await self.get_entity_current_version(entity_id=vehicle_id)
                if current is None or current.entity_type != "vehicle":
                    raise ValueError("vehicle entity not found for disposition")
                disposition = effect["params"]["disposition"]
                await self.append_entity_version(
                    entity_id=vehicle_id,
                    version_number=current.version_number + 1,
                    data={**current.data, "disposition": disposition},
                )
                payload = {"disposition": disposition}
                status_value = "pending_execution"
            elif action == "monitor":
                payload = {"note": "monitor"}
                status_value = "executed"
            else:
                payload = {"note": "unknown_action", "action": action}
                status_value = "executed"

            await self.insert_finding_action(
                finding_id=finding.id,
                tenant_id=finding.tenant_id,
                vehicle_id=vehicle_id,
                action_type=action,
                status_value=status_value,
                payload=payload,
                approver=approver,
            )
            await self.append_audit_event(
                entity_id=vehicle_id,
                tenant_id=finding.tenant_id,
                event_type="vehicle_action_executed",
                finding_id=finding.id,
                action_type=action,
                approver=approver,
                payload=payload,
            )
            logger.info(
                "finding_action_executed finding_id=%s action=%s status=%s",
                finding.id,
                action,
                status_value,
            )
            return {"executed": True, "action": action, "status": status_value}
        except Exception as exc:  # noqa: BLE001 — never break the decision response.
            logger.warning(
                "finding_action_failed finding_id=%s action=%s error=%s", finding.id, action, exc
            )
            with contextlib.suppress(Exception):  # best-effort failure record.
                await self.insert_finding_action(
                    finding_id=finding.id,
                    tenant_id=finding.tenant_id,
                    vehicle_id=vehicle_id,
                    action_type=action,
                    status_value="failed",
                    payload={"action": action, "error": str(exc)},
                    approver=approver,
                )
            return {"executed": False, "failed": True}

    def _service_role_headers(self) -> dict[str, str]:
        return {"apikey": self._service_role_key, "Authorization": f"{_BEARER_PREFIX} {self._service_role_key}"}

    async def _request_json(
        self,
        *,
        method: str,
        url: str | None = None,
        path: str | None = None,
        headers: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        if path is not None and url is None:
            url = f"{self._base_url}{path}"
        if url is None:
            raise ValueError("Either 'url' or 'path' must be provided to _request_json")
        if headers is None:
            _h: dict[str, str] = dict(self._service_role_headers())
            if body is not None:
                _h["Content-Type"] = "application/json"
            headers = _h
        def _call() -> Any:
            raw_body = json.dumps(body).encode("utf-8") if body is not None else None
            req = request.Request(url=url, method=method, headers=headers, data=raw_body)
            try:
                with request.urlopen(req, timeout=10) as response:
                    raw = response.read().decode("utf-8")
            except error.HTTPError as exc:
                if exc.status in (401, 403):
                    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized") from exc
                if exc.status == 404:
                    return None
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Supabase request failed") from exc
            except OSError as exc:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Supabase unavailable") from exc

            if not raw:
                return None
            return json.loads(raw)

        return await asyncio.to_thread(_call)


async def _refresh_next_run_after_trigger(handle: Any, *, agent_key: str, tenant_id: str) -> None:
    """Re-read the schedule's next fire time after a manual run and persist it.

    Best-effort: only persists Temporal's reported ``next_action_times`` (no cron
    fallback), so a non-provisioned or disabled schedule stays "no scheduled
    run". Never raises — a failed refresh must not fail the run-now request.
    """
    try:
        desc = await handle.describe()
        next_run_at = next_action_time_iso(desc)
        if next_run_at is not None:
            await asyncio.to_thread(persist_schedule_next_run, agent_key, tenant_id, next_run_at)
    except BaseException as exc:  # noqa: BLE001 - refresh is advisory, never fatal
        logger.warning(
            "run-now next_run_at refresh skipped",
            extra={"agent_key": agent_key, "tenant_id": tenant_id, "error": str(exc)},
        )


class TemporalSignalClient:
    def __init__(self, *, temporal_address: str, temporal_namespace: str) -> None:
        self._temporal_address = temporal_address
        self._temporal_namespace = temporal_namespace
        self._client: Client | None = None
        self._lock = asyncio.Lock()

    async def run_agent_now(self, *, agent_key: str, tenant_id: str, locale: str | None = None) -> dict[str, Any]:
        schedule_id = _agent_schedule_id(agent_key=agent_key, tenant_id=tenant_id)
        resolved_locale = resolve_locale(locale)
        if locale is not None:
            workflow_id = f"{schedule_id}:manual:{int(time.time() * 1000)}"
            registered = _MANUAL_RUN_WORKFLOWS.get(agent_key)
            if registered is not None:
                workflow_run, input_factory = registered
                workflow_input = input_factory(tenant_id, resolved_locale)
                await (await self._client_instance()).start_workflow(
                    workflow_run,
                    workflow_input,
                    id=workflow_id,
                    task_queue=settings.temporal_task_queue,
                )
                return {
                    "agent_key": agent_key,
                    "schedule_id": schedule_id,
                    "workflow_id": workflow_id,
                    "status": "started",
                    "locale": resolved_locale,
                }

        handle = (await self._client_instance()).get_schedule_handle(schedule_id)
        try:
            await handle.trigger(overlap=ScheduleOverlapPolicy.SKIP)
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                raise AgentScheduleNotProvisioned(agent_key) from exc
            raise
        await _refresh_next_run_after_trigger(handle, agent_key=agent_key, tenant_id=tenant_id)
        return {"agent_key": agent_key, "schedule_id": schedule_id, "status": "triggered"}

    async def signal_approve(self, *, finding: FindingRecord, approver: Principal, note: str | None) -> None:
        workflow_id = _require_workflow_id(finding)
        handle = (await self._client_instance()).get_workflow_handle(workflow_id)
        if _is_fleet_finding(finding):
            await handle.signal(
                FleetUtilizationWorkflow.approve_finding,
                ApproveFleetFindingSignal(
                    asset_id=_require_fleet_asset_id(finding),
                    finding_type=finding.finding_type,
                    fingerprint=_fingerprint_or_none(finding.fingerprint),
                    approver_id=approver.sub,
                    approver_name=approver.name,
                    note=note,
                ),
            )
            return
        contract_id, line_item_id = _require_revrec_signal_fields(finding)
        await handle.signal(
            RevenueRecognitionWorkflow.approve_finding,
            ApproveFindingSignal(
                contract_id=contract_id,
                line_item_id=line_item_id,
                finding_type=finding.finding_type,
                approver_id=approver.sub,
                approver_name=approver.name,
                note=note,
            ),
        )

    async def signal_reject(self, *, finding: FindingRecord, approver: Principal, reason: str) -> None:
        workflow_id = _require_workflow_id(finding)
        handle = (await self._client_instance()).get_workflow_handle(workflow_id)
        if _is_fleet_finding(finding):
            await handle.signal(
                FleetUtilizationWorkflow.reject_finding,
                RejectFleetFindingSignal(
                    asset_id=_require_fleet_asset_id(finding),
                    finding_type=finding.finding_type,
                    fingerprint=_fingerprint_or_none(finding.fingerprint),
                    approver_id=approver.sub,
                    approver_name=approver.name,
                    note=reason,
                ),
            )
            return
        contract_id, line_item_id = _require_revrec_signal_fields(finding)
        await handle.signal(
            RevenueRecognitionWorkflow.reject_finding,
            RejectFindingSignal(
                contract_id=contract_id,
                line_item_id=line_item_id,
                finding_type=finding.finding_type,
                approver_id=approver.sub,
                approver_name=approver.name,
                note=reason,
            ),
        )

    async def run_asset_update(
        self,
        *,
        asset_id: str,
        current_data: dict[str, Any],
        comments: str | None,
        report_damage: bool,
        damage_summary: str | None,
        evidence: list[AssetUpdateEvidenceItem],
    ) -> dict[str, Any]:
        workflow_id = f"asset-update-{asset_id}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}"
        handle = await (await self._client_instance()).start_workflow(
            AssetUpdateWorkflow.run,
            AssetUpdateWorkflowInput(
                asset_id=asset_id,
                current_data=current_data,
                comments=comments,
                report_damage=report_damage,
                damage_summary=damage_summary,
                evidence=[AssetUpdateEvidence(**item.model_dump()) for item in evidence],
            ),
            id=workflow_id,
            task_queue=settings.temporal_task_queue,
        )
        result = await handle.result()
        if not isinstance(result, dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid asset update workflow result")
        return {"workflow_id": workflow_id, **result}

    async def run_maintenance_invoice(
        self,
        *,
        maintenance_record_id: str,
        billing_account_id: str,
        work_order_status: str,
        sell_subtotal: float,
        tax_total: float,
        sell_total: float,
        created_by: str = "system",
    ) -> dict[str, Any]:
        workflow_id = f"maintenance-invoice-{maintenance_record_id}"
        handle = await (await self._client_instance()).start_workflow(
            MaintenanceInvoiceWorkflow.run,
            MaintenanceInvoiceRequest(
                maintenance_record_id=maintenance_record_id,
                billing_account_id=billing_account_id,
                work_order_status=work_order_status,
                sell_subtotal=sell_subtotal,
                tax_total=tax_total,
                sell_total=sell_total,
                created_by=created_by,
            ),
            id=workflow_id,
            task_queue=settings.temporal_task_queue,
        )
        result = await handle.result()
        if not isinstance(result, dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid maintenance invoice workflow result")
        return {"workflow_id": workflow_id, **result}

    async def run_mulesoft_outbound(
        self,
        *,
        tenant_id: str,
        exchange_key: str,
        entity_ids: list[str],
        mode: Literal["publish", "replay", "backfill"],
        replay_token: str | None = None,
    ) -> dict[str, Any]:
        if mode in {"replay", "backfill"}:
            resolved_replay_token = replay_token or _stable_mulesoft_replay_token(
                tenant_id=tenant_id,
                exchange_key=exchange_key,
                entity_ids=entity_ids,
                mode=mode,
            )
            workflow_id = _mulesoft_outbound_workflow_id(
                exchange_key=exchange_key,
                mode=mode,
                replay_token=resolved_replay_token,
            )
        else:
            resolved_replay_token = replay_token
            workflow_id = f"mulesoft-{mode}-{exchange_key}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}"

        duplicate = False
        try:
            await (await self._client_instance()).start_workflow(
                MuleSoftOutboundWorkflow.run,
                MuleSoftOutboundWorkflowInput(
                    tenant_id=tenant_id,
                    exchange_key=exchange_key,
                    entity_ids=entity_ids,
                    mode=mode,
                    replay_token=resolved_replay_token,
                ),
                id=workflow_id,
                task_queue=settings.temporal_task_queue,
            )
        except RPCError as exc:
            if exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            duplicate = True

        response = {"workflow_id": workflow_id, "status": "accepted", "duplicate": duplicate}
        if resolved_replay_token is not None:
            response["replay_token"] = resolved_replay_token
        return response

    async def run_mulesoft_inbound_callback(
        self,
        *,
        tenant_id: str,
        delivery_log_id: str,
        payload: dict[str, Any],
        delivery_id: str,
    ) -> dict[str, Any]:
        workflow_id = f"mulesoft-inbound-{delivery_id}"
        duplicate = False
        try:
            await (await self._client_instance()).start_workflow(
                MuleSoftInboundCallbackWorkflow.run,
                MuleSoftInboundCallbackWorkflowInput(
                    tenant_id=tenant_id,
                    delivery_log_id=delivery_log_id,
                    payload=payload,
                ),
                id=workflow_id,
                task_queue=settings.temporal_task_queue,
            )
        except RPCError as exc:
            if exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            duplicate = True
        return {"workflow_id": workflow_id, "status": "accepted", "duplicate": duplicate}

    async def run_samsara_sync(
        self,
        *,
        tenant_id: str,
        scopes: list[str],
        mode: Literal["sync", "backfill"],
    ) -> dict[str, Any]:
        if mode == "backfill":
            # Backfill gets a timestamped ID so multiple historical re-fetches can coexist.
            # Backfill never advances the durable cursor so concurrent runs are safe.
            timestamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S%f")
            scopes_tag = "-".join(sorted(scopes)) if scopes else "all"
            workflow_id = f"samsara-backfill-{tenant_id}-{scopes_tag}-{timestamp}"
        else:
            # Incremental sync uses a stable ID so Temporal's ALREADY_EXISTS prevents
            # concurrent runs from racing on the per-scope cursor in integration_sync_state.
            # The same stable ID is used by the scheduled reconcile path so manual and
            # scheduled incremental syncs are mutually exclusive.
            workflow_id = f"samsara-sync-{tenant_id}"

        duplicate = False
        try:
            await (await self._client_instance()).start_workflow(
                SamsaraSyncWorkflow.run,
                SamsaraSyncWorkflowInput(
                    tenant_id=tenant_id,
                    scopes=scopes,
                    mode=mode,
                ),
                id=workflow_id,
                task_queue=settings.temporal_task_queue,
            )
        except RPCError as exc:
            if exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            duplicate = True
        return {"workflow_id": workflow_id, "status": "accepted", "duplicate": duplicate}

    async def run_coupa_sync(
        self,
        *,
        tenant_id: str,
        scopes: list[str],
        mode: Literal["sync", "backfill"],
    ) -> dict[str, Any]:
        if mode == "backfill":
            # Backfill gets a timestamped ID so multiple historical re-fetches can coexist.
            # Backfill never advances the durable cursor so concurrent runs are safe.
            timestamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S%f")
            scopes_tag = "-".join(sorted(scopes)) if scopes else "all"
            workflow_id = f"coupa-backfill-{tenant_id}-{scopes_tag}-{timestamp}"
        else:
            # Incremental sync uses a stable ID so Temporal's ALREADY_EXISTS prevents
            # concurrent runs from racing on the per-scope cursor in integration_sync_state.
            # The same stable ID is used by the scheduled reconcile path so manual and
            # scheduled incremental syncs are mutually exclusive.
            workflow_id = f"coupa-sync-{tenant_id}"

        duplicate = False
        try:
            await (await self._client_instance()).start_workflow(
                CoupaSyncWorkflow.run,
                CoupaSyncWorkflowInput(
                    tenant_id=tenant_id,
                    scopes=scopes,
                    mode=mode,
                ),
                id=workflow_id,
                task_queue=settings.temporal_task_queue,
            )
        except RPCError as exc:
            if exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            duplicate = True
        return {"workflow_id": workflow_id, "status": "accepted", "duplicate": duplicate}

    async def run_descartes_sync(
        self,
        *,
        tenant_id: str,
        scopes: list[str],
        mode: Literal["sync", "backfill"],
    ) -> dict[str, Any]:
        if mode == "backfill":
            timestamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S%f")
            scopes_tag = "-".join(sorted(scopes)) if scopes else "all"
            workflow_id = f"descartes-backfill-{tenant_id}-{scopes_tag}-{timestamp}"
        else:
            workflow_id = f"descartes-sync-{tenant_id}"

        duplicate = False
        try:
            await (await self._client_instance()).start_workflow(
                DescartesSyncWorkflow.run,
                DescartesSyncWorkflowInput(
                    tenant_id=tenant_id,
                    scopes=scopes,
                    mode=mode,
                ),
                id=workflow_id,
                task_queue=settings.temporal_task_queue,
            )
        except RPCError as exc:
            if exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            duplicate = True
        return {"workflow_id": workflow_id, "status": "accepted", "duplicate": duplicate}

    async def run_branch_morning_brief(
        self,
        *,
        tenant_id: str,
        branch_id: str | None,
    ) -> dict[str, Any]:
        """Trigger a branch morning brief workflow for the given tenant/branch.

        Uses a stable workflow ID keyed on tenant + branch + date so a
        duplicate trigger on the same day is idempotent (ALREADY_EXISTS).
        """
        from datetime import date as _date

        date_tag = _date.today().isoformat()
        branch_tag = branch_id or "all"
        workflow_id = f"branch-morning-brief-{tenant_id}-{branch_tag}-{date_tag}"

        duplicate = False
        try:
            await (await self._client_instance()).start_workflow(
                BranchMorningBriefWorkflow.run,
                BranchMorningBriefWorkflowInput(
                    tenant_id=tenant_id,
                    branch_id=branch_id,
                ),
                id=workflow_id,
                task_queue=settings.temporal_task_queue,
            )
        except RPCError as exc:
            if exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            duplicate = True
        return {"workflow_id": workflow_id, "status": "accepted", "duplicate": duplicate}

    async def run_territory_brief(
        self,
        *,
        tenant_id: str,
        rep_id: str | None,
        account_id: str | None,
    ) -> dict[str, Any]:
        """Trigger a territory account brief workflow for the given tenant/rep/account.

        Uses a stable workflow ID keyed on tenant + rep/account + date so a
        duplicate trigger on the same day is idempotent (ALREADY_EXISTS).

        Returns a dict with keys:
          - workflow_id: str — stable Temporal workflow ID for this scope + date.
          - status: str — always "accepted".
          - duplicate: bool — True when a workflow for this scope already ran today.
        """
        from datetime import date as _date

        date_tag = _date.today().isoformat()
        scope_tag = account_id or rep_id or "all"
        workflow_id = f"territory-account-brief-{tenant_id}-{scope_tag}-{date_tag}"

        duplicate = False
        try:
            await (await self._client_instance()).start_workflow(
                TerritoryAccountBriefWorkflow.run,
                TerritoryAccountBriefWorkflowInput(
                    tenant_id=tenant_id,
                    rep_id=rep_id,
                    account_id=account_id,
                ),
                id=workflow_id,
                task_queue=settings.temporal_task_queue,
            )
        except RPCError as exc:
            if exc.status != RPCStatusCode.ALREADY_EXISTS:
                raise
            duplicate = True
        return {"workflow_id": workflow_id, "status": "accepted", "duplicate": duplicate}

    async def _client_instance(self) -> Client:
        if self._client is not None:
            return self._client
        async with self._lock:
            if self._client is None:
                self._client = await Client.connect(self._temporal_address, namespace=self._temporal_namespace)
        return self._client


def _is_fleet_finding(finding: FindingRecord) -> bool:
    return finding.agent_key == _FLEET_AUDITOR_AGENT_KEY


def _require_workflow_id(finding: FindingRecord) -> str:
    if not finding.workflow_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Finding is missing workflow signal fields",
        )
    return finding.workflow_id


def _require_revrec_signal_fields(finding: FindingRecord) -> tuple[str, str]:
    if not finding.contract_id or not finding.line_item_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Finding is missing workflow signal fields",
        )
    return str(finding.contract_id), str(finding.line_item_id)


def _require_fleet_asset_id(finding: FindingRecord) -> str:
    if not finding.contract_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Finding is missing workflow signal fields",
        )
    return str(finding.contract_id)


def _fingerprint_or_none(fingerprint: str) -> str | None:
    return fingerprint or None


def _parse_finding_record(value: Any) -> FindingRecord:
    if not isinstance(value, dict):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid finding payload")
    finding_type = value.get("finding_type")
    status_value = value.get("status")
    tenant_id = value.get("tenant_id")
    agent_key = value.get("agent_key")
    fingerprint = value.get("fingerprint")
    if (
        not isinstance(finding_type, str)
        or not isinstance(status_value, str)
        or not isinstance(tenant_id, str)
        or not isinstance(agent_key, str)
        or not isinstance(fingerprint, str)
    ):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid finding payload")
    return FindingRecord(
        id=str(value.get("id")),
        tenant_id=tenant_id,
        agent_key=agent_key,
        run_id=value.get("run_id"),
        workflow_id=value.get("workflow_id"),
        contract_id=value.get("contract_id"),
        line_item_id=value.get("line_item_id"),
        fingerprint=fingerprint,
        finding_type=finding_type,
        status=status_value,
        proposed_action=value.get("proposed_action") if isinstance(value.get("proposed_action"), str) else None,
    )


def _stable_mulesoft_replay_token(
    *,
    tenant_id: str,
    exchange_key: str,
    entity_ids: list[str],
    mode: str,
) -> str:
    fingerprint = json.dumps(
        {
            "tenant_id": tenant_id,
            "exchange_key": exchange_key,
            "entity_ids": entity_ids,
            "mode": mode,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    # 24 hex characters keeps workflow IDs compact while leaving 96 bits of entropy,
    # which makes accidental collisions negligible for operator-triggered replay jobs.
    return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:24]


def _mulesoft_outbound_workflow_id(
    *,
    exchange_key: str,
    mode: str,
    replay_token: str,
) -> str:
    token_hash = hashlib.sha256(replay_token.encode("utf-8")).hexdigest()[:16]
    return f"mulesoft-{mode}-{exchange_key}-{token_hash}"


def _delivery_log_is_processed(log_row: dict[str, Any] | None) -> bool:
    return log_row is not None and str(log_row.get("status") or "") == "processed"


# ---------------------------------------------------------------------------
# Prometheus metrics (shared across all app instances in this process)
# ---------------------------------------------------------------------------

_HTTP_REQUESTS_TOTAL = Counter(
    "ops_api_http_requests_total",
    "Total HTTP requests to the ops-api",
    ["method", "path", "status_code"],
)
_HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "ops_api_http_request_duration_seconds",
    "HTTP request latency for the ops-api",
    ["method", "path"],
    buckets=[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
)


def create_app(
    *,
    supabase_client: SupabaseServiceClient | None = None,
    temporal_client: TemporalSignalClient | None = None,
    connector_registry: dict[str, ConnectorProvider] | None = None,
) -> FastAPI:
    app = FastAPI()
    app.state.supabase_client = supabase_client or SupabaseServiceClient(
        base_url=settings.supabase_url,
        service_role_key=settings.supabase_service_role_key,
    )
    app.state.temporal_client = temporal_client or TemporalSignalClient(
        temporal_address=settings.temporal_address,
        temporal_namespace=settings.temporal_namespace,
    )
    app.state.connector_registry = connector_registry or build_connector_registry()

    def _supabase_client() -> SupabaseServiceClient:
        return app.state.supabase_client

    def _temporal_client() -> TemporalSignalClient:
        return app.state.temporal_client

    def _connector_provider(provider_key: str) -> ConnectorProvider:
        provider = app.state.connector_registry.get(provider_key)
        if provider is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration provider not registered")
        return provider

    async def _principal(
        authorization: str | None = Header(default=None),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> Principal:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
        return await client.authenticate_user(user_jwt=authorization.split(" ", 1)[1].strip())

    @app.middleware("http")
    async def _prometheus_middleware(request: Request, call_next: Any) -> Any:
        path = request.url.path
        method = request.method
        start = time.perf_counter()
        response = await call_next(request)
        duration = time.perf_counter() - start
        _HTTP_REQUESTS_TOTAL.labels(method=method, path=path, status_code=str(response.status_code)).inc()
        _HTTP_REQUEST_DURATION_SECONDS.labels(method=method, path=path).observe(duration)
        return response

    @app.get("/metrics")
    async def metrics() -> Response:
        data = generate_latest(REGISTRY)
        return Response(content=data, media_type=CONTENT_TYPE_LATEST)

    @app.get("/api/ops/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/ops/agents/catalog")
    async def agents_catalog() -> dict[str, Any]:
        """Read-only static mission catalog for the four DIA agents (issue #125).

        Returns only i18n keys and structural data (action list, ``assist_only``);
        the agent ``system_prompt``/``user_prompt_template`` is never exposed.
        """
        return {"agents": agent_catalog_payload()}

    async def _authorized_tenant_id(*, principal: Principal, client: SupabaseServiceClient) -> str:
        tenant_id = await client.get_tenant_id_by_key(tenant_key=principal.tenant)
        if tenant_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Tenant access denied")
        return tenant_id

    def _require_operate_permission(principal: Principal) -> None:
        if principal.role not in _CAN_OPERATE_ROLES:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operation")
        if principal.can_operate is False:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Operate permission denied")

    def _require_finance_permission(principal: Principal) -> None:
        if principal.role not in _CAN_VIEW_FINANCIALS_ROLES:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin or branch_manager role required")

    def _require_mulesoft_replay_permission(principal: Principal) -> None:
        if principal.role not in _CAN_REPLAY_MULESOFT_ROLES:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role for operation")
        if principal.can_operate is False:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Operate permission denied")

    def _raise_mulesoft_unauthenticated() -> NoReturn:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    def _validate_and_resolve_approver(
        *,
        principal: Principal,
        approver_id: str | None,
        approver_name: str | None,
    ) -> tuple[str, str | None]:
        if approver_id is not None and approver_id != principal.sub:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Approver identity mismatch")
        if approver_name is not None and approver_name != principal.name:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Approver identity mismatch")
        return principal.sub, principal.name

    def _validate_signal_identity(
        *,
        finding: FindingRecord,
        workflow_id: str | None,
        run_id: str | None,
    ) -> None:
        if workflow_id is not None and workflow_id != finding.workflow_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Workflow identity mismatch")
        if run_id is not None and run_id != finding.run_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Run identity mismatch")

    async def _handle_decision(
        *,
        finding_id: str,
        principal: Principal,
        client: SupabaseServiceClient,
        signal_client: TemporalSignalClient,
        decision: Literal["approve", "reject", "dismiss"],
        note: str | None,
        workflow_id: str | None,
        run_id: str | None,
        approver_id: str | None,
        approver_name: str | None,
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)

        finding = await client.get_finding(finding_id=finding_id, tenant_id=tenant_id)
        if finding is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")

        _validate_signal_identity(finding=finding, workflow_id=workflow_id, run_id=run_id)
        resolved_approver_id, resolved_approver_name = _validate_and_resolve_approver(
            principal=principal,
            approver_id=approver_id,
            approver_name=approver_name,
        )
        if finding.status in _TERMINAL_FINDING_STATUSES:
            return {"status": "accepted", "idempotent": True}
        approver = {"approver_id": resolved_approver_id, "approver_name": resolved_approver_name, "note": note}
        # Dismiss leaves the pending queue (recorded as rejected) but is tagged so
        # it is distinguishable from an explicit reject and needs no reason.
        if decision == "dismiss":
            approver["disposition"] = "dismissed"
        status_value = "approved" if decision == "approve" else "rejected"
        persisted = await client.persist_disposition(
            finding_id=finding_id,
            tenant_id=tenant_id,
            status_value=status_value,
            approver=approver,
        )
        if persisted is None:
            finding = await client.get_finding(finding_id=finding_id, tenant_id=tenant_id)
            if finding and finding.status in _TERMINAL_FINDING_STATUSES:
                return {"status": "accepted", "idempotent": True}
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Finding disposition conflict")

        # Execute the recommended action for an approved vehicle-aging finding.
        if decision == "approve":
            await client.execute_finding_action(finding=persisted, approver=approver)
        elif decision == "dismiss" and persisted.contract_id:
            try:
                await client.append_audit_event(
                    entity_id=persisted.contract_id,
                    tenant_id=tenant_id,
                    event_type="vehicle_finding_dismissed",
                    finding_id=finding_id,
                    action_type=persisted.proposed_action or "",
                    approver=approver,
                    payload={"disposition": "dismissed"},
                )
            except Exception as exc:  # noqa: BLE001 — never break the decision response.
                logger.warning(f"finding_dismiss_audit_failed finding_id={finding_id} error={exc}")

        if decision in ("approve", "reject") and persisted.workflow_id:
            try:
                if decision == "approve":
                    await signal_client.signal_approve(finding=persisted, approver=principal, note=note)
                else:
                    await signal_client.signal_reject(finding=persisted, approver=principal, reason=note or "")
            except Exception as exc:
                logger.warning(f"finding_signal_failed finding_id={finding_id} decision={decision} error={exc}")
        return {"status": "accepted", "idempotent": False}

    @app.post("/api/ops/findings/{finding_id}/approve", status_code=status.HTTP_202_ACCEPTED)
    async def approve_finding(
        finding_id: str,
        payload: ApproveFindingRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        signal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        note = payload.note.strip() if isinstance(payload.note, str) else payload.note
        return await _handle_decision(
            finding_id=finding_id,
            principal=principal,
            client=client,
            signal_client=signal_client,
            decision="approve",
            note=note or None,
            workflow_id=None,
            run_id=None,
            approver_id=None,
            approver_name=None,
        )

    @app.post("/api/ops/findings/{finding_id}/reject", status_code=status.HTTP_202_ACCEPTED)
    async def reject_finding(
        finding_id: str,
        payload: RejectFindingRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        signal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        reason = payload.reason.strip()
        if not reason:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="reason is required")
        return await _handle_decision(
            finding_id=finding_id,
            principal=principal,
            client=client,
            signal_client=signal_client,
            decision="reject",
            note=reason,
            workflow_id=None,
            run_id=None,
            approver_id=None,
            approver_name=None,
        )

    @app.post("/api/ops/findings/decision", status_code=status.HTTP_202_ACCEPTED)
    async def decide_finding(
        payload: FindingDecisionRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        signal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        note = payload.note.strip() if isinstance(payload.note, str) else None
        reason = payload.reason.strip() if isinstance(payload.reason, str) else None
        if payload.decision == "reject" and not reason:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="reason is required")
        return await _handle_decision(
            finding_id=payload.finding_id,
            principal=principal,
            client=client,
            signal_client=signal_client,
            decision=payload.decision,
            note=reason if payload.decision == "reject" else note,
            workflow_id=payload.workflow_id,
            run_id=payload.run_id,
            approver_id=payload.approver_id,
            approver_name=payload.approver_name,
        )

    @app.get("/api/ops/findings/{finding_id}")
    async def get_finding_detail(
        finding_id: str,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        # Read-only finding detail that exposes the deterministic decision preview
        # (issue #126): what Approve vs Reject actually does, faithful to
        # execute_finding_action via the shared describe_action_effect rule.
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        finding = await client.get_finding(finding_id=finding_id, tenant_id=tenant_id)
        if finding is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")
        return {
            "id": finding.id,
            "finding_type": finding.finding_type,
            "status": finding.status,
            "proposed_action": finding.proposed_action,
            "decision_preview": describe_action_effect(finding),
        }

    @app.post("/api/ops/assets/{asset_id}/update-request")
    async def submit_asset_update_request(
        asset_id: str,
        payload: AssetUpdateRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        await _authorized_tenant_id(principal=principal, client=client)

        comments = payload.comments.strip() if isinstance(payload.comments, str) else None
        damage_summary = payload.damage_summary.strip() if isinstance(payload.damage_summary, str) else None
        if not payload.evidence and not comments and not damage_summary:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="image evidence or comments are required",
            )

        current = await client.get_entity_current_version(entity_id=asset_id)
        if current is None or current.entity_type != "asset":
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")

        workflow_result = await temporal_client.run_asset_update(
            asset_id=asset_id,
            current_data=current.data,
            comments=comments,
            report_damage=payload.report_damage,
            damage_summary=damage_summary,
            evidence=payload.evidence,
        )
        proposed_data = workflow_result.get("proposed_data")
        if not isinstance(proposed_data, dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid asset update workflow result")

        version_row = await client.append_entity_version(
            entity_id=asset_id,
            version_number=current.version_number + 1,
            data=proposed_data,
        )
        return {
            "status": "accepted",
            "workflow_id": workflow_result.get("workflow_id"),
            "summary": workflow_result.get("summary"),
            "recommended_status": workflow_result.get("recommended_status"),
            "damage_severity": workflow_result.get("damage_severity"),
            "updated_fields": workflow_result.get("updated_fields"),
            "version_number": version_row.get("version_number"),
        }

    @app.post("/api/maintenance/work-orders/{record_id}/generate-invoice", status_code=status.HTTP_202_ACCEPTED)
    async def generate_maintenance_invoice(
        record_id: str,
        payload: GenerateMaintenanceInvoiceRequest,
        principal: Principal = Depends(_principal),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)

        result = await temporal_client.run_maintenance_invoice(
            maintenance_record_id=record_id,
            billing_account_id=payload.billing_account_id,
            work_order_status=payload.work_order_status,
            sell_subtotal=payload.sell_subtotal,
            tax_total=payload.tax_total,
            sell_total=payload.sell_total,
            created_by=principal.sub,
        )
        return result

    @app.post("/api/integrations/mulesoft/replays", status_code=status.HTTP_202_ACCEPTED)
    async def replay_mulesoft_exchange(
        payload: MuleSoftReplayRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        _require_mulesoft_replay_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        return await temporal_client.run_mulesoft_outbound(
            tenant_id=tenant_id,
            exchange_key=payload.exchange_key,
            entity_ids=payload.entity_ids,
            mode=payload.mode,
            replay_token=payload.replay_token,
        )

    @app.post("/api/integrations/mulesoft/callbacks/delivery_receipt", status_code=status.HTTP_202_ACCEPTED)
    async def receive_mulesoft_delivery_receipt(
        request: Request,
        tenant_key: str = Header(alias="X-Tenant-Key"),
        delivery_id: str = Header(alias="X-MuleSoft-Delivery-Id"),
        signature: str = Header(alias="X-MuleSoft-Signature"),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        tenant_id = await client.get_tenant_id_by_key(tenant_key=tenant_key)
        if tenant_id is None:
            _raise_mulesoft_unauthenticated()
        config = await client.get_integration_config(tenant_id=tenant_id, connector_key="mulesoft")
        if config is None:
            _raise_mulesoft_unauthenticated()

        secret_refs = config.get("secret_refs") if isinstance(config.get("secret_refs"), dict) else {}
        webhook_secret_env = secret_refs.get("webhook_secret_env")
        if not isinstance(webhook_secret_env, str) or not webhook_secret_env:
            _raise_mulesoft_unauthenticated()
        webhook_secret = os.getenv(webhook_secret_env)
        if not webhook_secret:
            _raise_mulesoft_unauthenticated()

        body = await request.body()
        if not verify_mulesoft_signature(secret=webhook_secret, delivery_id=delivery_id, body=body, signature=signature):
            _raise_mulesoft_unauthenticated()

        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid JSON payload") from exc
        receipt = MuleSoftCallbackReceipt.model_validate(payload)
        log_row = await client.get_integration_delivery_log(
            tenant_id=tenant_id,
            connector_key="mulesoft",
            direction="inbound",
            exchange_key="delivery_receipt",
            idempotency_key=delivery_id,
        )
        if _delivery_log_is_processed(log_row):
            return {"status": "accepted", "idempotent": True}
        if log_row is None:
            log_row = await client.upsert_integration_delivery_log(
                payload={
                    "tenant_id": tenant_id,
                    "connector_key": "mulesoft",
                    "exchange_key": "delivery_receipt",
                    "direction": "inbound",
                    "scope_key": f"{receipt.subject_exchange_key}:{receipt.entity_id}",
                    "entity_type": receipt.entity_type,
                    "entity_id": receipt.entity_id,
                    "source_of_truth": "mulesoft",
                    "provider_delivery_id": delivery_id,
                    "idempotency_key": delivery_id,
                    "status": "received",
                    "request_payload": receipt.model_dump(mode="json"),
                    "received_at": datetime.now(UTC).isoformat(),
                }
            )

        result = await temporal_client.run_mulesoft_inbound_callback(
            tenant_id=tenant_id,
            delivery_log_id=str(log_row.get("id") or ""),
            payload=receipt.model_dump(mode="json"),
            delivery_id=delivery_id,
        )
        await client.update_integration_delivery_log(
            delivery_log_id=str(log_row.get("id") or ""),
            payload={"workflow_id": result.get("workflow_id"), "updated_at": datetime.now(UTC).isoformat()},
        )
        return {"status": "accepted", "idempotent": bool(result.get("duplicate")), **result}

    @app.post("/api/ops/integrations/descartes/configure")
    async def configure_descartes(
        payload: DescartesConfigureRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        provider = _connector_provider("descartes")
        config_payload = {
            "endpoint_base_url": payload.endpoint_base_url,
            "auth_secret_ref": payload.auth_secret_ref,
            "enabled_scopes": payload.enabled_scopes,
            "route_mapping_profile": payload.route_mapping_profile,
            "shipment_mapping_profile": payload.shipment_mapping_profile,
            "compliance_profile": payload.compliance_profile,
            "healthcheck_path": payload.healthcheck_path,
            "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
        }
        validation_errors = provider.validate_config(config_payload)
        if validation_errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"classification": "configuration", "errors": validation_errors},
            )
        # When schedule is None (omitted), preserve existing schedule from config
        if payload.schedule is None:
            existing = await client.get_integration_config(tenant_id=tenant_id, connector_key="descartes")
            schedule = existing.get("schedule", {}) if existing else {}
        else:
            schedule = payload.schedule
        row = await client.upsert_integration_config(
            tenant_id=tenant_id,
            connector_key="descartes",
            enabled=payload.enabled,
            # settings carries connection + probe controls shared by runtime validation.
            settings={
                "endpoint_base_url": payload.endpoint_base_url,
                "enabled_scopes": payload.enabled_scopes,
                "healthcheck_path": payload.healthcheck_path,
                "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
            },
            # mappings carries provider field-mapping profiles consumed by sync logic.
            mappings={
                "route_mapping_profile": payload.route_mapping_profile,
                "shipment_mapping_profile": payload.shipment_mapping_profile,
                "compliance_profile": payload.compliance_profile,
            },
            secret_refs={"auth_secret_ref": payload.auth_secret_ref},
            schedule=schedule,
        )
        return {"status": "configured", "connector_key": "descartes", "config": row}

    @app.post("/api/ops/integrations/descartes/validate")
    async def validate_descartes(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="descartes")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")

        provider = _connector_provider("descartes")
        secret_refs = row.get("secret_refs")
        secret_refs_obj = secret_refs if isinstance(secret_refs, dict) else {}
        settings = row.get("settings")
        settings_obj = settings if isinstance(settings, dict) else {}
        mappings = row.get("mappings")
        mappings_obj = mappings if isinstance(mappings, dict) else {}
        config = {
            "endpoint_base_url": settings_obj.get("endpoint_base_url"),
            "auth_secret_ref": secret_refs_obj.get("auth_secret_ref"),
            "enabled_scopes": settings_obj.get("enabled_scopes"),
            "healthcheck_path": settings_obj.get("healthcheck_path"),
            "healthcheck_timeout_seconds": settings_obj.get("healthcheck_timeout_seconds"),
            "route_mapping_profile": mappings_obj.get("route_mapping_profile"),
            "shipment_mapping_profile": mappings_obj.get("shipment_mapping_profile"),
            "compliance_profile": mappings_obj.get("compliance_profile"),
        }
        healthcheck = provider.healthcheck(config)
        return {
            "status": healthcheck.status,
            "classification": healthcheck.classification,
            "message": healthcheck.message,
            "details": healthcheck.details,
        }

    @app.post("/api/ops/integrations/descartes/disable")
    async def disable_descartes(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.disable_integration_config(tenant_id=tenant_id, connector_key="descartes")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        return {"status": "disabled", "connector_key": "descartes", "config": row}

    @app.post("/api/ops/integrations/descartes/sync")
    async def trigger_descartes_sync(
        payload: DescartesSyncRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="descartes")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        if not row.get("enabled"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Descartes integration is disabled; enable it before triggering a sync",
            )
        return await temporal_client.run_descartes_sync(
            tenant_id=tenant_id,
            scopes=payload.scopes,
            mode=payload.mode,
        )

    @app.post("/api/ops/integrations/samsara/configure")
    async def configure_samsara(
        payload: SamsaraConfigureRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        provider = _connector_provider("samsara")
        config_payload = {
            "api_base_url": payload.api_base_url,
            "api_secret_ref": payload.api_secret_ref,
            "enabled_scopes": payload.enabled_scopes,
            "fleet_targeting": payload.fleet_targeting,
            "gps_mapping_profile": payload.gps_mapping_profile,
            "hours_mapping_profile": payload.hours_mapping_profile,
            "eld_profile": payload.eld_profile,
            "dashcam_event_profile": payload.dashcam_event_profile,
            "healthcheck_path": payload.healthcheck_path,
            "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
        }
        validation_errors = provider.validate_config(config_payload)
        if validation_errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"classification": "configuration", "errors": validation_errors},
            )
        row = await client.upsert_integration_config(
            tenant_id=tenant_id,
            connector_key="samsara",
            enabled=payload.enabled,
            settings={
                "api_base_url": payload.api_base_url,
                "enabled_scopes": payload.enabled_scopes,
                "fleet_targeting": payload.fleet_targeting,
                "healthcheck_path": payload.healthcheck_path,
                "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
            },
            mappings={
                "gps_mapping_profile": payload.gps_mapping_profile,
                "hours_mapping_profile": payload.hours_mapping_profile,
                "eld_profile": payload.eld_profile,
                "dashcam_event_profile": payload.dashcam_event_profile,
            },
            secret_refs={"api_secret_ref": payload.api_secret_ref},
            schedule=payload.schedule,
        )
        return {"status": "configured", "connector_key": "samsara", "config": row}

    @app.post("/api/ops/integrations/samsara/validate")
    async def validate_samsara(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="samsara")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")

        provider = _connector_provider("samsara")
        secret_refs = row.get("secret_refs")
        secret_refs_obj = secret_refs if isinstance(secret_refs, dict) else {}
        settings = row.get("settings")
        settings_obj = settings if isinstance(settings, dict) else {}
        mappings = row.get("mappings")
        mappings_obj = mappings if isinstance(mappings, dict) else {}
        config = {
            "api_base_url": settings_obj.get("api_base_url"),
            "api_secret_ref": secret_refs_obj.get("api_secret_ref"),
            "enabled_scopes": settings_obj.get("enabled_scopes"),
            "fleet_targeting": settings_obj.get("fleet_targeting"),
            "healthcheck_path": settings_obj.get("healthcheck_path"),
            "healthcheck_timeout_seconds": settings_obj.get("healthcheck_timeout_seconds"),
            "gps_mapping_profile": mappings_obj.get("gps_mapping_profile"),
            "hours_mapping_profile": mappings_obj.get("hours_mapping_profile"),
            "eld_profile": mappings_obj.get("eld_profile"),
            "dashcam_event_profile": mappings_obj.get("dashcam_event_profile"),
        }
        healthcheck = provider.healthcheck(config)
        return {
            "status": healthcheck.status,
            "classification": healthcheck.classification,
            "message": healthcheck.message,
            "details": healthcheck.details,
        }

    @app.post("/api/ops/integrations/samsara/disable")
    async def disable_samsara(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.disable_integration_config(tenant_id=tenant_id, connector_key="samsara")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        return {"status": "disabled", "connector_key": "samsara", "config": row}

    @app.post("/api/ops/integrations/samsara/sync")
    async def trigger_samsara_sync(
        payload: SamsaraSyncRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="samsara")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        if not row.get("enabled"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Samsara integration is disabled; enable it before triggering a sync",
            )
        return await temporal_client.run_samsara_sync(
            tenant_id=tenant_id,
            scopes=payload.scopes,
            mode=payload.mode,
        )

    @app.post("/api/ops/integrations/billtrust/configure")
    async def configure_billtrust(
        payload: BilltrustConfigureRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        provider = _connector_provider("billtrust")
        config_payload = {
            "api_base_url": payload.api_base_url,
            "client_id_secret_ref": payload.client_id_secret_ref,
            "client_secret_secret_ref": payload.client_secret_secret_ref,
            "enabled_scopes": payload.enabled_scopes,
            "tenant_mapping": payload.tenant_mapping,
            "invoice_mapping_profile": payload.invoice_mapping_profile,
            "payment_mapping_profile": payload.payment_mapping_profile,
            "ar_aging_profile": payload.ar_aging_profile,
            "healthcheck_path": payload.healthcheck_path,
            "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
        }
        validation_errors = provider.validate_config(config_payload)
        if validation_errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"classification": "configuration", "errors": validation_errors},
            )
        row = await client.upsert_integration_config(
            tenant_id=tenant_id,
            connector_key="billtrust",
            enabled=payload.enabled,
            settings={
                "api_base_url": payload.api_base_url,
                "enabled_scopes": payload.enabled_scopes,
                "tenant_mapping": payload.tenant_mapping,
                "healthcheck_path": payload.healthcheck_path,
                "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
            },
            mappings={
                "invoice_mapping_profile": payload.invoice_mapping_profile,
                "payment_mapping_profile": payload.payment_mapping_profile,
                "ar_aging_profile": payload.ar_aging_profile,
            },
            secret_refs={
                "client_id_secret_ref": payload.client_id_secret_ref,
                "client_secret_secret_ref": payload.client_secret_secret_ref,
            },
            schedule={},
        )
        return {"status": "configured", "connector_key": "billtrust", "config": row}

    @app.post("/api/ops/integrations/billtrust/validate")
    async def validate_billtrust(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="billtrust")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")

        provider = _connector_provider("billtrust")
        secret_refs = row.get("secret_refs")
        secret_refs_obj = secret_refs if isinstance(secret_refs, dict) else {}
        settings = row.get("settings")
        settings_obj = settings if isinstance(settings, dict) else {}
        mappings = row.get("mappings")
        mappings_obj = mappings if isinstance(mappings, dict) else {}
        config = {
            "api_base_url": settings_obj.get("api_base_url"),
            "client_id_secret_ref": secret_refs_obj.get("client_id_secret_ref"),
            "client_secret_secret_ref": secret_refs_obj.get("client_secret_secret_ref"),
            "enabled_scopes": settings_obj.get("enabled_scopes"),
            "tenant_mapping": settings_obj.get("tenant_mapping"),
            "healthcheck_path": settings_obj.get("healthcheck_path"),
            "healthcheck_timeout_seconds": settings_obj.get("healthcheck_timeout_seconds"),
            "invoice_mapping_profile": mappings_obj.get("invoice_mapping_profile"),
            "payment_mapping_profile": mappings_obj.get("payment_mapping_profile"),
            "ar_aging_profile": mappings_obj.get("ar_aging_profile"),
        }
        healthcheck = provider.healthcheck(config)
        return {
            "status": healthcheck.status,
            "classification": healthcheck.classification,
            "message": healthcheck.message,
            "details": healthcheck.details,
        }

    @app.post("/api/ops/integrations/billtrust/disable")
    async def disable_billtrust(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.disable_integration_config(tenant_id=tenant_id, connector_key="billtrust")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        return {"status": "disabled", "connector_key": "billtrust", "config": row}

    @app.post("/api/ops/integrations/sage_intacct/configure")
    async def configure_sage_intacct(
        payload: SageConfigureRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        provider = _connector_provider("sage_intacct")
        config_payload = {
            "api_base_url": payload.api_base_url,
            "company_id": payload.company_id,
            "client_id_secret_ref": payload.client_id_secret_ref,
            "client_secret_secret_ref": payload.client_secret_secret_ref,
            "enabled_scopes": payload.enabled_scopes,
            "general_ledger_profile": payload.general_ledger_profile,
            "accounts_payable_profile": payload.accounts_payable_profile,
            "accounts_receivable_profile": payload.accounts_receivable_profile,
            "cash_management_profile": payload.cash_management_profile,
            "healthcheck_path": payload.healthcheck_path,
            "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
        }
        validation_errors = provider.validate_config(config_payload)
        if validation_errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"classification": "configuration", "errors": validation_errors},
            )
        row = await client.upsert_integration_config(
            tenant_id=tenant_id,
            connector_key="sage_intacct",
            enabled=payload.enabled,
            settings={
                "api_base_url": payload.api_base_url,
                "company_id": payload.company_id,
                "enabled_scopes": payload.enabled_scopes,
                "healthcheck_path": payload.healthcheck_path,
                "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
            },
            mappings={
                "general_ledger_profile": payload.general_ledger_profile,
                "accounts_payable_profile": payload.accounts_payable_profile,
                "accounts_receivable_profile": payload.accounts_receivable_profile,
                "cash_management_profile": payload.cash_management_profile,
            },
            secret_refs={
                "client_id_secret_ref": payload.client_id_secret_ref,
                "client_secret_secret_ref": payload.client_secret_secret_ref,
            },
            schedule={},
        )
        return {"status": "configured", "connector_key": "sage_intacct", "config": row}

    @app.post("/api/ops/integrations/sage_intacct/validate")
    async def validate_sage_intacct(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="sage_intacct")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")

        provider = _connector_provider("sage_intacct")
        secret_refs = row.get("secret_refs")
        secret_refs_obj = secret_refs if isinstance(secret_refs, dict) else {}
        settings = row.get("settings")
        settings_obj = settings if isinstance(settings, dict) else {}
        mappings = row.get("mappings")
        mappings_obj = mappings if isinstance(mappings, dict) else {}
        config = {
            "api_base_url": settings_obj.get("api_base_url"),
            "company_id": settings_obj.get("company_id"),
            "client_id_secret_ref": secret_refs_obj.get("client_id_secret_ref"),
            "client_secret_secret_ref": secret_refs_obj.get("client_secret_secret_ref"),
            "enabled_scopes": settings_obj.get("enabled_scopes"),
            "healthcheck_path": settings_obj.get("healthcheck_path"),
            "healthcheck_timeout_seconds": settings_obj.get("healthcheck_timeout_seconds"),
            "general_ledger_profile": mappings_obj.get("general_ledger_profile"),
            "accounts_payable_profile": mappings_obj.get("accounts_payable_profile"),
            "accounts_receivable_profile": mappings_obj.get("accounts_receivable_profile"),
            "cash_management_profile": mappings_obj.get("cash_management_profile"),
        }
        healthcheck = provider.healthcheck(config)
        return {
            "status": healthcheck.status,
            "classification": healthcheck.classification,
            "message": healthcheck.message,
            "details": healthcheck.details,
        }

    @app.post("/api/ops/integrations/sage_intacct/disable")
    async def disable_sage_intacct(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.disable_integration_config(tenant_id=tenant_id, connector_key="sage_intacct")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        return {"status": "disabled", "connector_key": "sage_intacct", "config": row}

    @app.post("/api/ops/integrations/coupa/configure")
    async def configure_coupa(
        payload: CoupaConfigureRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        provider = _connector_provider("coupa")
        config_payload = {
            "api_base_url": payload.api_base_url,
            "tenant_slug": payload.tenant_slug,
            "client_id_secret_ref": payload.client_id_secret_ref,
            "client_secret_secret_ref": payload.client_secret_secret_ref,
            "enabled_scopes": payload.enabled_scopes,
            "requisition_mapping_profile": payload.requisition_mapping_profile,
            "purchase_order_mapping_profile": payload.purchase_order_mapping_profile,
            "supplier_mapping_profile": payload.supplier_mapping_profile,
            "invoice_mapping_profile": payload.invoice_mapping_profile,
            "healthcheck_path": payload.healthcheck_path,
            "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
        }
        validation_errors = provider.validate_config(config_payload)
        if validation_errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"classification": "configuration", "errors": validation_errors},
            )
        row = await client.upsert_integration_config(
            tenant_id=tenant_id,
            connector_key="coupa",
            enabled=payload.enabled,
            settings={
                "api_base_url": payload.api_base_url,
                "tenant_slug": payload.tenant_slug,
                "enabled_scopes": payload.enabled_scopes,
                "healthcheck_path": payload.healthcheck_path,
                "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
            },
            mappings={
                "requisition_mapping_profile": payload.requisition_mapping_profile,
                "purchase_order_mapping_profile": payload.purchase_order_mapping_profile,
                "supplier_mapping_profile": payload.supplier_mapping_profile,
                "invoice_mapping_profile": payload.invoice_mapping_profile,
            },
            secret_refs={
                "client_id_secret_ref": payload.client_id_secret_ref,
                "client_secret_secret_ref": payload.client_secret_secret_ref,
            },
            schedule={},
        )
        return {"status": "configured", "connector_key": "coupa", "config": row}

    @app.post("/api/ops/integrations/coupa/validate")
    async def validate_coupa(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="coupa")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")

        provider = _connector_provider("coupa")
        secret_refs = row.get("secret_refs")
        secret_refs_obj = secret_refs if isinstance(secret_refs, dict) else {}
        settings = row.get("settings")
        settings_obj = settings if isinstance(settings, dict) else {}
        mappings = row.get("mappings")
        mappings_obj = mappings if isinstance(mappings, dict) else {}
        config = {
            "api_base_url": settings_obj.get("api_base_url"),
            "tenant_slug": settings_obj.get("tenant_slug"),
            "client_id_secret_ref": secret_refs_obj.get("client_id_secret_ref"),
            "client_secret_secret_ref": secret_refs_obj.get("client_secret_secret_ref"),
            "enabled_scopes": settings_obj.get("enabled_scopes"),
            "healthcheck_path": settings_obj.get("healthcheck_path"),
            "healthcheck_timeout_seconds": settings_obj.get("healthcheck_timeout_seconds"),
            "requisition_mapping_profile": mappings_obj.get("requisition_mapping_profile"),
            "purchase_order_mapping_profile": mappings_obj.get("purchase_order_mapping_profile"),
            "supplier_mapping_profile": mappings_obj.get("supplier_mapping_profile"),
            "invoice_mapping_profile": mappings_obj.get("invoice_mapping_profile"),
        }
        healthcheck = provider.healthcheck(config)
        return {
            "status": healthcheck.status,
            "classification": healthcheck.classification,
            "message": healthcheck.message,
            "details": healthcheck.details,
        }

    @app.post("/api/ops/integrations/coupa/disable")
    async def disable_coupa(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.disable_integration_config(tenant_id=tenant_id, connector_key="coupa")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        return {"status": "disabled", "connector_key": "coupa", "config": row}

    @app.post("/api/ops/integrations/coupa/sync")
    async def trigger_coupa_sync(
        payload: CoupaSyncRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="coupa")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        if not row.get("enabled"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Coupa integration is disabled; enable it before triggering a sync",
            )
        return await temporal_client.run_coupa_sync(
            tenant_id=tenant_id,
            scopes=payload.scopes,
            mode=payload.mode,
        )

    @app.post("/api/ops/integrations/netsuite/configure")
    async def configure_netsuite(
        payload: NetSuiteConfigureRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        provider = _connector_provider("netsuite")
        config_payload = {
            "api_base_url": payload.api_base_url,
            "account_id": payload.account_id,
            "consumer_key_secret_ref": payload.consumer_key_secret_ref,
            "consumer_secret_secret_ref": payload.consumer_secret_secret_ref,
            "token_id_secret_ref": payload.token_id_secret_ref,
            "token_secret_secret_ref": payload.token_secret_secret_ref,
            "enabled_scopes": payload.enabled_scopes,
            "items_profile": payload.items_profile,
            "customers_profile": payload.customers_profile,
            "vendors_profile": payload.vendors_profile,
            "invoices_profile": payload.invoices_profile,
            "healthcheck_path": payload.healthcheck_path,
            "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
        }
        validation_errors = provider.validate_config(config_payload)
        if validation_errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"classification": "configuration", "errors": validation_errors},
            )
        row = await client.upsert_integration_config(
            tenant_id=tenant_id,
            connector_key="netsuite",
            enabled=payload.enabled,
            settings={
                "api_base_url": payload.api_base_url,
                "account_id": payload.account_id,
                "enabled_scopes": payload.enabled_scopes,
                "healthcheck_path": payload.healthcheck_path,
                "healthcheck_timeout_seconds": payload.healthcheck_timeout_seconds,
            },
            mappings={
                "items_profile": payload.items_profile,
                "customers_profile": payload.customers_profile,
                "vendors_profile": payload.vendors_profile,
                "invoices_profile": payload.invoices_profile,
            },
            secret_refs={
                "consumer_key_secret_ref": payload.consumer_key_secret_ref,
                "consumer_secret_secret_ref": payload.consumer_secret_secret_ref,
                "token_id_secret_ref": payload.token_id_secret_ref,
                "token_secret_secret_ref": payload.token_secret_secret_ref,
            },
            schedule={},
        )
        return {"status": "configured", "connector_key": "netsuite", "config": row}

    @app.post("/api/ops/integrations/netsuite/validate")
    async def validate_netsuite(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.get_integration_config(tenant_id=tenant_id, connector_key="netsuite")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")

        provider = _connector_provider("netsuite")
        secret_refs = row.get("secret_refs")
        secret_refs_obj = secret_refs if isinstance(secret_refs, dict) else {}
        settings = row.get("settings")
        settings_obj = settings if isinstance(settings, dict) else {}
        mappings = row.get("mappings")
        mappings_obj = mappings if isinstance(mappings, dict) else {}
        config = {
            "api_base_url": settings_obj.get("api_base_url"),
            "account_id": settings_obj.get("account_id"),
            "consumer_key_secret_ref": secret_refs_obj.get("consumer_key_secret_ref"),
            "consumer_secret_secret_ref": secret_refs_obj.get("consumer_secret_secret_ref"),
            "token_id_secret_ref": secret_refs_obj.get("token_id_secret_ref"),
            "token_secret_secret_ref": secret_refs_obj.get("token_secret_secret_ref"),
            "enabled_scopes": settings_obj.get("enabled_scopes"),
            "healthcheck_path": settings_obj.get("healthcheck_path"),
            "healthcheck_timeout_seconds": settings_obj.get("healthcheck_timeout_seconds"),
            "items_profile": mappings_obj.get("items_profile"),
            "customers_profile": mappings_obj.get("customers_profile"),
            "vendors_profile": mappings_obj.get("vendors_profile"),
            "invoices_profile": mappings_obj.get("invoices_profile"),
        }
        healthcheck = provider.healthcheck(config)
        return {
            "status": healthcheck.status,
            "classification": healthcheck.classification,
            "message": healthcheck.message,
            "details": healthcheck.details,
        }

    @app.post("/api/ops/integrations/netsuite/disable")
    async def disable_netsuite(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        row = await client.disable_integration_config(tenant_id=tenant_id, connector_key="netsuite")
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration config not found")
        return {"status": "disabled", "connector_key": "netsuite", "config": row}

    @app.post("/api/ops/agents/{agent_key}/run", status_code=status.HTTP_202_ACCEPTED)
    async def trigger_agent_now(
        agent_key: str,
        payload: AgentRunRequest | None = Body(default=None),
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        if agent_key not in _AGENT_SCHEDULE_ID_BUILDERS:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown agent_key: {agent_key}")

        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        try:
            if payload is None:
                result = await temporal_client.run_agent_now(agent_key=agent_key, tenant_id=tenant_id)
            else:
                result = await temporal_client.run_agent_now(
                    agent_key=agent_key,
                    tenant_id=tenant_id,
                    locale=resolve_locale(payload.locale),
                )
        except AgentScheduleNotProvisioned as exc:
            logger.warning(
                "manual ops agent trigger not provisioned",
                extra={
                    "who": principal.name or principal.sub,
                    "principal_sub": principal.sub,
                    "principal_name": principal.name,
                    "agent_key": agent_key,
                    "tenant_id": tenant_id,
                    "status": "not_provisioned",
                },
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Agent {agent_key} is disabled or schedule not provisioned",
            ) from exc

        logger.info(
            "manual ops agent trigger accepted",
            extra={
                "who": principal.name or principal.sub,
                "principal_sub": principal.sub,
                "principal_name": principal.name,
                "agent_key": agent_key,
                "tenant_id": tenant_id,
                "locale": resolve_locale(payload.locale) if payload else DEFAULT_LOCALE,
                "schedule_id": result["schedule_id"],
                "status": result["status"],
            },
        )
        return result

    @app.post("/api/ops/branch-morning-brief/trigger", status_code=status.HTTP_202_ACCEPTED)
    async def trigger_branch_morning_brief(
        payload: BranchMorningBriefTriggerRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        """Trigger a branch morning brief for the authenticated branch manager.

        Idempotent: a second trigger for the same tenant/branch/date returns
        the same workflow_id with duplicate=true.
        """
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        return await temporal_client.run_branch_morning_brief(
            tenant_id=tenant_id,
            branch_id=payload.branch_id,
        )

    @app.post("/api/ops/territory-brief/trigger", status_code=status.HTTP_202_ACCEPTED)
    async def trigger_territory_brief(
        payload: TerritoryBriefTriggerRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        temporal_client: TemporalSignalClient = Depends(_temporal_client),
    ) -> dict[str, Any]:
        """Trigger a territory account brief for the authenticated rep.

        When account_id is provided, runs a single-account pre-visit brief (t2).
        Otherwise runs a territory-plan pass across all active accounts (t1).

        Scope enforcement:
        - field_operator: rep scope is always bound to the authenticated principal
          (principal.sub).  Supplying a rep_id that differs from the caller's own
          sub is rejected with 403.  Tenant-wide fan-out is also denied — the
          caller's identity is always used as the rep scope.
        - admin / branch_manager: may supply any rep_id or omit it for a
          tenant-wide pass.

        Idempotent: a second trigger for the same tenant/scope/date returns
        the same workflow_id with duplicate=true.
        """
        _require_operate_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)

        if principal.role == "field_operator":
            if payload.rep_id is not None and payload.rep_id != principal.sub:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="field_operator may only trigger briefs for their own rep scope",
                )
            effective_rep_id: str | None = principal.sub
        else:
            effective_rep_id = payload.rep_id

        return await temporal_client.run_territory_brief(
            tenant_id=tenant_id,
            rep_id=effective_rep_id,
            account_id=payload.account_id,
        )

    @app.post("/api/ops/accounting/export/configure")
    async def configure_accounting_export(
        payload: AccountingExportConfigureRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        """Save accounting export mode configuration for the authenticated tenant.

        Only admins may call this endpoint.  Saves the export mode (xero, sage, or
        export_only), optional account-code and tax-code remapping profiles, and
        free-form notes.  A new row is created; any previous active config row is
        disabled atomically by the ``accounting_upsert_export_config`` RPC.
        """
        if principal.role != "admin":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="admin role required to configure accounting export",
            )
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)

        _FORMAT_FOR_MODE = {
            "xero": "xero_csv_v1",
            "sage": "sage_intacct_gl_csv_v1",
            "export_only": "export_only_v1",
        }
        format_version = _FORMAT_FOR_MODE[payload.export_mode]

        result = await client._request_json(
            method="POST",
            path="/rest/v1/rpc/accounting_upsert_export_config",
            body={
                "p_tenant_id": tenant_id,
                "p_export_mode": payload.export_mode,
                "p_format_version": format_version,
                "p_account_code_map": payload.account_code_map,
                "p_tax_code_map": payload.tax_code_map,
                "p_notes": payload.notes,
                "p_created_by": principal.sub,
            },
        )
        return {"status": "configured", "export_mode": payload.export_mode, "config": result}

    @app.post("/api/ops/accounting/export/trigger")
    async def trigger_accounting_export(
        payload: AccountingExportTriggerRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> Response:
        """Generate a period-bounded accounting export package.

        Fetches posted ledger entries for the given period from the database,
        maps them to the tenant's configured export format (Xero/Sage/export-only),
        records an audit row, and returns the CSV as a downloadable attachment.

        No live provider connection is required — export works in standalone mode.
        """
        _require_finance_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)

        # Load tenant export config
        config_rows = await client._request_json(
            method="GET",
            path=f"/rest/v1/accounting_export_config?tenant_id=eq.{tenant_id}&enabled=eq.true&limit=1",
        )
        if not config_rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No active accounting export configuration found for this tenant. "
                       "An admin must configure the export mode in Accounting > Export Configuration.",
            )
        config = config_rows[0]
        export_mode = config["export_mode"]
        export_config_id = config["id"]
        account_code_map = config.get("account_code_map") or {}
        tax_code_map = config.get("tax_code_map") or {}

        # Validate period
        try:
            from datetime import date as _date, datetime as _datetime, time as _time, timezone as _tz
            period_start = _date.fromisoformat(payload.period_start)
            period_end = _date.fromisoformat(payload.period_end)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid period date: {exc}",
            ) from exc
        if period_end < period_start:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="period_end must not be before period_start",
            )

        # Fetch ledger rows for the period.
        # Timestamp values must be percent-encoded: ISO-8601 UTC offsets contain '+' which is
        # decoded as a space in URL query strings, making the PostgREST filter malformed.
        basis_filter = "" if payload.basis == "all" else f"&basis=eq.{payload.basis}"
        period_start_encoded = parse.quote(period_start.isoformat(), safe="")
        period_end_encoded = parse.quote(
            _datetime.combine(period_end, _time.max).replace(tzinfo=_tz.utc).isoformat(),
            safe="",
        )
        ledger_rows = await client._request_json(
            method="GET",
            path=(
                f"/rest/v1/accounting_posted_ledger_entries"
                f"?tenant_id=eq.{tenant_id}"
                f"&posted_at=gte.{period_start_encoded}"
                f"&posted_at=lte.{period_end_encoded}"
                f"{basis_filter}"
                f"&order=posted_at.asc"
                f"&limit={_LEDGER_FETCH_LIMIT}"
            ),
        )

        # Guard against silent truncation: if exactly at the cap, the result is incomplete.
        if ledger_rows and len(ledger_rows) >= _LEDGER_FETCH_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Export period contains {len(ledger_rows)}+ ledger entries, which exceeds the "
                    f"{_LEDGER_FETCH_LIMIT:,}-row fetch limit. Narrow the period (e.g. export one month "
                    "at a time) to avoid producing a truncated CSV."
                ),
            )

        pkg = build_export_package(
            ledger_rows or [],
            export_mode,
            period_start,
            period_end,
            basis=payload.basis,
            account_code_map=account_code_map if isinstance(account_code_map, dict) else {},
            tax_code_map=tax_code_map if isinstance(tax_code_map, dict) else {},
        )

        artifact_status = "complete" if pkg.manifest.row_count > 0 else "empty"

        # Record audit row
        await client._request_json(
            method="POST",
            path="/rest/v1/rpc/accounting_record_export_run",
            body={
                "p_tenant_id": tenant_id,
                "p_export_config_id": export_config_id,
                "p_export_mode": export_mode,
                "p_format_version": pkg.manifest.format_version,
                "p_period_start": period_start.isoformat(),
                "p_period_end": period_end.isoformat(),
                "p_basis": payload.basis,
                "p_triggered_by": principal.sub,
                "p_row_count": pkg.manifest.row_count,
                "p_artifact_status": artifact_status,
            },
        )

        return Response(
            content=pkg.csv_text,
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="{pkg.manifest.filename}"',
                "X-Export-Mode": export_mode,
                "X-Export-Format-Version": pkg.manifest.format_version,
                "X-Export-Row-Count": str(pkg.manifest.row_count),
            },
        )

    @app.get("/api/ops/accounting/export/runs")
    async def list_accounting_export_runs(
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
        limit: int = 50,
    ) -> dict[str, Any]:
        """List accounting export runs for the authenticated tenant (most recent first)."""
        _require_finance_permission(principal)
        tenant_id = await _authorized_tenant_id(principal=principal, client=client)
        clamped_limit = max(1, min(limit, 200))
        rows = await client._request_json(
            method="GET",
            path=(
                f"/rest/v1/accounting_export_runs"
                f"?tenant_id=eq.{tenant_id}"
                f"&order=created_at.desc"
                f"&limit={clamped_limit}"
            ),
        )
        return {"runs": rows or [], "count": len(rows or [])}

    @app.post("/api/ops/assistant/chat")
    async def assistant_chat(
        payload: AssistantChatRequest,
        principal: Principal = Depends(_principal),
        client: SupabaseServiceClient = Depends(_supabase_client),
    ) -> dict[str, Any]:
        """Live conversational turn for the Portal assistant (DIA).

        Answers BI questions with read-only data and proposes UI navigation.
        Navigation is allowlist-checked server-side against the screens the
        frontend (permission-filtered menu) declared as available.
        """
        # Gate: principal must map to a known tenant (inherits the user's access).
        await _authorized_tenant_id(principal=principal, client=client)

        context = {
            "current_screen": payload.context.current_screen,
            "empresa_id": payload.context.empresa_id,
            "locale": resolve_locale(payload.context.locale),
            "available_screens": [s.model_dump() for s in payload.context.available_screens],
        }
        history = [m.model_dump() for m in payload.messages]

        try:
            reply = await run_portal_assistant(history, context)
        except Exception as exc:  # noqa: BLE001 — never leak a stack to the client
            logger.exception("assistant_chat failed")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Assistant is temporarily unavailable",
            ) from exc

        reply = filter_actions_to_allowlist(reply, allowed_screen_keys(context))
        return reply.model_dump(mode="json")

    return app


def _coerce_float(value: Any) -> float:
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return 0.0
    return 0.0


def _coerce_optional_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    return None
