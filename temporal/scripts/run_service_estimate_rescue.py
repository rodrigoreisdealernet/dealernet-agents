"""Manual trigger for the Service Estimate Authorization Rescue workflow (issue #81).

Run from the repository root:

    python -m temporal.scripts.run_service_estimate_rescue --tenant-key demo-ops-a

The script resolves the tenant key to its UUID, starts
``ServiceEstimateRescueWorkflow`` on the configured task queue, waits for the
result, and prints a compact ``{scoped, recorded, deduped}`` summary alongside
the full workflow result.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from temporalio.client import Client

from temporal.src.activities import ops_revrec
from temporal.src.config import settings
from temporal.src.workflows.ops.service_estimate_rescue import (
    ServiceEstimateRescueWorkflow,
    ServiceEstimateRescueWorkflowInput,
)


def _resolve_tenant_id(tenant_key: str) -> str:
    client = ops_revrec.get_ops_persistence_client()
    rows = client.select("tenants", columns="id", filters={"tenant_key": tenant_key}, limit=1)
    if not rows:
        raise SystemExit(f"No tenant found for tenant_key={tenant_key!r}")
    tenant_id = str(rows[0].get("id") or "").strip()
    if not tenant_id:
        raise SystemExit(f"Tenant row for tenant_key={tenant_key!r} is missing an id")
    return tenant_id


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    tenant_id = args.tenant_id or _resolve_tenant_id(args.tenant_key)
    workflow_id = args.workflow_id or (
        f"ops-service-estimate-rescue-manual-{tenant_id}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}"
    )

    client = await Client.connect(settings.temporal_address, namespace=settings.temporal_namespace)
    handle = await client.start_workflow(
        ServiceEstimateRescueWorkflow.run,
        ServiceEstimateRescueWorkflowInput(
            tenant_id=tenant_id,
            run_window_start=args.run_window_start,
            run_window_end=args.run_window_end,
        ),
        id=workflow_id,
        task_queue=settings.temporal_task_queue,
    )
    result = await handle.result()
    merged: dict[str, Any] = {"workflow_id": workflow_id, "tenant_id": tenant_id}
    if isinstance(result, dict):
        merged.update(result)
    return merged


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Manually trigger the Service Estimate Authorization Rescue workflow.",
    )
    parser.add_argument(
        "--tenant-key",
        default="demo-ops-a",
        help="Tenant key to resolve to a tenant UUID (default: demo-ops-a).",
    )
    parser.add_argument(
        "--tenant-id",
        default=None,
        help="Tenant UUID (skips tenant_key resolution when provided).",
    )
    parser.add_argument(
        "--run-window-start",
        default=None,
        help="Optional ISO run window start passed to the workflow input.",
    )
    parser.add_argument(
        "--run-window-end",
        default=None,
        help="Optional ISO run window end passed to the workflow input.",
    )
    parser.add_argument(
        "--workflow-id",
        default=None,
        help="Optional explicit Temporal workflow id (defaults to a timestamped id).",
    )
    args = parser.parse_args()

    result = asyncio.run(_run(args))

    summary = {
        "scoped": result.get("total_estimates_scoped", 0),
        "recorded": result.get("recorded_findings", 0),
        "deduped": result.get("deduped_findings", 0),
    }
    print(json.dumps({"summary": summary, "result": result}, indent=2, default=str))


if __name__ == "__main__":
    main()
