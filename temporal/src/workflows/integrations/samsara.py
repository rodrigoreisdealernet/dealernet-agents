from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy
    from temporalio.exceptions import ApplicationError

    from ...activities import samsara

# ---------------------------------------------------------------------------
# Retry policies
# ---------------------------------------------------------------------------

_NON_RETRYABLE = [
    "SamsaraAuthError",
    "SamsaraMappingError",
    "ValueError",
    "ApplicationError",
]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
# Rate-limit retries: up to 5 attempts with longer back-off (handled by Temporal)
_RATE_LIMIT_RETRY = RetryPolicy(
    maximum_attempts=5,
    non_retryable_error_types=["SamsaraAuthError", "SamsaraMappingError", "ValueError", "ApplicationError"],
)


# ---------------------------------------------------------------------------
# I/O dataclasses
# ---------------------------------------------------------------------------


@dataclass
class SamsaraSyncWorkflowInput:
    tenant_id: str
    scopes: list[str] = field(default_factory=list)
    """Scopes to sync. Empty list means sync all enabled scopes from config."""
    mode: Literal["sync", "backfill"] = "sync"
    """sync = incremental from cursor; backfill = ignore cursor and re-fetch from beginning."""


# ---------------------------------------------------------------------------
# Workflow
# ---------------------------------------------------------------------------


@workflow.defn
class SamsaraSyncWorkflow:
    """Orchestrates incremental polling of Samsara telematics data.

    For each enabled scope (gps, hours, eld, dashcam_events):
      1. Load integration config and the stored cursor from integration_sync_state.
      2. Paginate through the Samsara API, persisting each page idempotently.
      3. Advance the cursor after each page so retries can resume mid-stream.

    Source-of-truth is always Samsara for all scopes (inbound direction).
    """

    @workflow.run
    async def run(self, inp: SamsaraSyncWorkflowInput) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "tenant_id": inp.tenant_id,
            "mode": inp.mode,
            "scopes": {},
        }

        # Determine which scopes to process
        scopes_to_run = inp.scopes if inp.scopes else list(samsara.SAMSARA_SCOPES)

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
                f"Samsara sync had {len(failed_scopes)} scope failure(s): {', '.join(failed_scopes)}",
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
                samsara.samsara_load_sync_config,
                args=[tenant_id, scope],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )

            # Validate that this scope is enabled in the tenant's config
            enabled_scopes: list[str] = config_snapshot.get("enabled_scopes") or []
            if scope not in enabled_scopes:
                scope_summary["status"] = "skipped"
                scope_summary["error"] = f"scope {scope!r} not enabled for tenant"
                return scope_summary

            # For backfill mode, ignore the stored cursor so we re-fetch from the start
            cursor: str | None = None if mode == "backfill" else config_snapshot.get("cursor")

            # Paginate until exhausted
            while True:
                page_result = await workflow.execute_activity(
                    samsara.samsara_fetch_scope_page,
                    args=[tenant_id, scope, cursor, config_snapshot],
                    start_to_close_timeout=workflow.timedelta(seconds=60),
                    retry_policy=_RATE_LIMIT_RETRY,
                )

                records: list[dict[str, Any]] = page_result.get("records") or []
                fetched_at: str = page_result.get("fetched_at") or ""
                next_cursor: str | None = page_result.get("next_cursor")
                page_cursor: str | None = page_result.get("page_cursor")

                if records:
                    mappings: dict[str, Any] = config_snapshot.get("mappings") or {}
                    persist_result = await workflow.execute_activity(
                        samsara.samsara_persist_telemetry_batch,
                        args=[tenant_id, scope, records, fetched_at, mappings],
                        start_to_close_timeout=workflow.timedelta(seconds=60),
                        retry_policy=_STANDARD_RETRY,
                    )
                    scope_summary["upserted"] += persist_result.get("upserted") or 0
                    scope_summary["duplicates"] += persist_result.get("duplicates") or 0

                # Advance cursor only with a provider-derived token.
                # Never fall back to a worker-local timestamp: that is not a
                # valid Samsara resume cursor and would skip late-arriving records.
                # During backfill, do not advance the durable cursor at all: backfill
                # runs from cursor=None and must not overwrite the live incremental
                # resume point stored in integration_sync_state.
                advance_cursor: str | None = next_cursor or page_cursor
                if advance_cursor is not None and mode != "backfill":
                    await workflow.execute_activity(
                        samsara.samsara_advance_sync_cursor,
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
