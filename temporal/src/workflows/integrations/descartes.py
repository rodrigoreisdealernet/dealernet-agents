from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from ...activities import descartes_sync

_NON_RETRYABLE = [
    "DescartesAuthError",
    "DescartesPermanentError",
    "ValueError",
    "ApplicationError",
]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_RATE_LIMIT_RETRY = RetryPolicy(maximum_attempts=5, non_retryable_error_types=_NON_RETRYABLE)


@dataclass
class DescartesSyncWorkflowInput:
    tenant_id: str
    scopes: list[str] = field(default_factory=list)
    mode: Literal["sync", "backfill"] = "sync"


@workflow.defn
class DescartesSyncWorkflow:
    @workflow.run
    async def run(self, inp: DescartesSyncWorkflowInput) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "tenant_id": inp.tenant_id,
            "mode": inp.mode,
            "scopes": {},
        }
        scopes_to_run = inp.scopes if inp.scopes else list(descartes_sync.DESCARTES_SCOPES)
        for scope in scopes_to_run:
            scope_result = await self._sync_scope(
                tenant_id=inp.tenant_id,
                scope=scope,
                mode=inp.mode,
            )
            summary["scopes"][scope] = scope_result

        failed_scopes = [scope_name for scope_name, result in summary["scopes"].items() if result["status"] == "failed"]
        if failed_scopes:
            raise ApplicationError(
                f"Descartes sync had {len(failed_scopes)} scope failure(s): {', '.join(failed_scopes)}",
                non_retryable=True,
            )
        return summary

    async def _sync_scope(
        self,
        *,
        tenant_id: str,
        scope: str,
        mode: str,
    ) -> dict[str, Any]:
        scope_summary: dict[str, Any] = {
            "scope": scope,
            "pages": 0,
            "upserted": 0,
            "duplicates": 0,
            "status": "ok",
            "error": None,
        }
        try:
            config_snapshot = await workflow.execute_activity(
                descartes_sync.descartes_load_sync_config,
                args=[tenant_id, scope],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )

            enabled_scopes: list[str] = config_snapshot.get("enabled_scopes") or []
            if scope not in enabled_scopes:
                scope_summary["status"] = "skipped"
                scope_summary["error"] = f"scope {scope!r} not enabled for tenant"
                return scope_summary

            cursor: str | None = None if mode == "backfill" else config_snapshot.get("cursor")
            while True:
                page_result = await workflow.execute_activity(
                    descartes_sync.descartes_fetch_scope_page,
                    args=[tenant_id, scope, cursor, config_snapshot],
                    start_to_close_timeout=workflow.timedelta(seconds=60),
                    retry_policy=_RATE_LIMIT_RETRY,
                )
                records: list[dict[str, Any]] = page_result.get("records") or []
                fetched_at: str = page_result.get("fetched_at") or ""
                next_cursor: str | None = page_result.get("next_cursor")
                page_cursor: str | None = page_result.get("page_cursor")

                if records:
                    mappings_obj = config_snapshot.get("mappings")
                    mappings: dict[str, Any] = dict(mappings_obj) if isinstance(mappings_obj, Mapping) else {}
                    persist_result = await workflow.execute_activity(
                        descartes_sync.descartes_persist_scope_batch,
                        args=[tenant_id, scope, records, fetched_at, mappings],
                        start_to_close_timeout=workflow.timedelta(seconds=60),
                        retry_policy=_STANDARD_RETRY,
                    )
                    scope_summary["upserted"] += persist_result.get("upserted") or 0
                    scope_summary["duplicates"] += persist_result.get("duplicates") or 0

                advance_cursor: str | None = next_cursor or page_cursor
                if advance_cursor is not None and mode != "backfill":
                    await workflow.execute_activity(
                        descartes_sync.descartes_advance_sync_cursor,
                        args=[tenant_id, scope, advance_cursor, fetched_at],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )

                scope_summary["pages"] += 1
                cursor = next_cursor
                if not next_cursor:
                    break
        except Exception as exc:  # noqa: BLE001
            scope_summary["status"] = "failed"
            scope_summary["error"] = f"{type(exc).__name__}: {exc}"
        return scope_summary
