"""Regression tests for Temporal worker activity/workflow registration integrity.

Guards against worker.py referencing non-existent activity or workflow symbols
that would cause AttributeError at Worker() construction (CrashLoopBackOff).
"""
from __future__ import annotations

import importlib
import inspect


def _extract_worker_activity_references() -> list[tuple[str, str]]:
    """
    Parse worker.py source to extract all activity references in the Worker() activities list.
    Returns list of (module_alias, function_name) tuples.
    """
    from pathlib import Path
    worker_path = Path(__file__).resolve().parents[1] / "src" / "worker.py"
    source = worker_path.read_text()

    # Find the activities=[...] block in Worker() construction
    references: list[tuple[str, str]] = []
    in_activities_block = False
    for line in source.splitlines():
        stripped = line.strip()
        if "activities=[" in stripped:
            in_activities_block = True
            continue
        if in_activities_block:
            if stripped.startswith("]"):
                break
            # Extract module_alias.function_name references
            if "." in stripped and not stripped.startswith("#"):
                # Remove trailing comma and whitespace
                ref = stripped.rstrip(",").strip()
                if "." in ref and not ref.startswith("#"):
                    parts = ref.split(".")
                    if len(parts) == 2:
                        references.append((parts[0], parts[1]))
    return references


def _extract_worker_workflow_references() -> list[str]:
    """
    Parse worker.py source to extract all workflow class names in the Worker() workflows list.
    Returns list of class names.
    """
    from pathlib import Path
    worker_path = Path(__file__).resolve().parents[1] / "src" / "worker.py"
    source = worker_path.read_text()

    # Find the workflows=[...] block in Worker() construction
    references: list[str] = []
    in_workflows_block = False
    for line in source.splitlines():
        stripped = line.strip()
        if "workflows=[" in stripped:
            in_workflows_block = True
            continue
        if in_workflows_block:
            if stripped.startswith("]"):
                break
            # Extract workflow class names
            if stripped and not stripped.startswith("#"):
                # Remove trailing comma and whitespace
                ref = stripped.rstrip(",").strip()
                if ref and not ref.startswith("#"):
                    references.append(ref)
    return references


def _resolve_activity_module_alias(alias: str) -> str | None:
    """Map activity module aliases used in worker.py to actual import paths."""
    # Based on the imports at the top of worker.py
    alias_map = {
        "rental_activities": "temporal.src.activities.rental",
        "rental_operations": "temporal.src.activities.rental_operations",
        "accounting_activities": "temporal.src.activities.accounting",
        "mulesoft": "temporal.src.activities.mulesoft",
        "notifications": "temporal.src.activities.notifications",
        "ops_branch_brief": "temporal.src.activities.ops_branch_brief",
        "ops_contract_ocr": "temporal.src.activities.ops_contract_ocr",
        "ops_account_health": "temporal.src.activities.ops_account_health",
        "ops_credit": "temporal.src.activities.ops_credit",
        "ops_dispatch_snapshot": "temporal.src.activities.ops_dispatch_snapshot",
        "ops_fleet": "temporal.src.activities.ops_fleet",
        "ops_billing_update": "temporal.src.activities.ops_billing_update",
        "ops_integration_exception": "temporal.src.activities.ops_integration_exception",
        "ops_llm_usage": "temporal.src.activities.ops_llm_usage",
        "ops_pm": "temporal.src.activities.ops_pm",
        "ops_revrec": "temporal.src.activities.ops_revrec",
        "ops_vehicle_aging": "temporal.src.activities.ops_vehicle_aging",
        "ops_safety_compliance_monitor": "temporal.src.activities.ops_safety_compliance_monitor",
        "ops_shop_queue": "temporal.src.activities.ops_shop_queue",
        "ops_technician_queue": "temporal.src.activities.ops_technician_queue",
        "ops_territory_brief": "temporal.src.activities.ops_territory_brief",
        "ops_disposition": "temporal.src.activities.ops_disposition",
        "supabase_core": "temporal.src.activities.supabase_core",
        "samsara_activities": "temporal.src.activities.samsara",
        "coupa_activities": "temporal.src.activities.coupa",
        "descartes_activities": "temporal.src.activities.descartes_sync",
    }
    return alias_map.get(alias)


def test_all_registered_activities_exist() -> None:
    """
    Every activity reference in worker.py's Worker(activities=[...]) list must
    resolve to an actual function symbol in the corresponding module.

    Regression guard for issues like registering descartes_activities.descartes_persist_logistics_batch
    when the real function is descartes_persist_scope_batch (causes AttributeError at Worker construction).
    """
    import sys
    from pathlib import Path

    # Add temporal package to sys.path for imports
    temporal_root = Path(__file__).resolve().parents[1]
    if str(temporal_root) not in sys.path:
        sys.path.insert(0, str(temporal_root))

    activity_refs = _extract_worker_activity_references()
    assert activity_refs, "Expected to find activity references in worker.py"

    missing: list[str] = []
    for module_alias, function_name in activity_refs:
        module_path = _resolve_activity_module_alias(module_alias)
        if module_path is None:
            missing.append(f"{module_alias}.{function_name} (unknown module alias)")
            continue

        try:
            module = importlib.import_module(module_path)
        except ImportError as e:
            missing.append(f"{module_alias}.{function_name} (module import failed: {e})")
            continue

        if not hasattr(module, function_name):
            missing.append(f"{module_alias}.{function_name} (function not found in {module_path})")

    assert not missing, (
        "Worker registration references non-existent activity symbols that would cause "
        "AttributeError at Worker() construction (CrashLoopBackOff):\n"
        + "\n".join(f"  - {ref}" for ref in missing)
    )


def test_all_registered_workflows_exist() -> None:
    """
    Every workflow reference in worker.py's Worker(workflows=[...]) list must
    resolve to an actual class symbol that can be imported.
    """
    import sys
    from pathlib import Path

    # Add temporal package to sys.path for imports
    temporal_root = Path(__file__).resolve().parents[1]
    if str(temporal_root) not in sys.path:
        sys.path.insert(0, str(temporal_root))

    # Import the worker module to get the workflow classes it imports
    try:
        from temporal.src import worker as worker_module
    except ImportError as e:
        raise AssertionError(f"Failed to import worker module: {e}") from e

    workflow_refs = _extract_worker_workflow_references()
    assert workflow_refs, "Expected to find workflow references in worker.py"

    missing: list[str] = []
    for workflow_name in workflow_refs:
        if not hasattr(worker_module, workflow_name):
            missing.append(workflow_name)

    assert not missing, (
        "Worker registration references non-existent workflow symbols that would cause "
        "NameError at Worker() construction:\n"
        + "\n".join(f"  - {ref}" for ref in missing)
    )


def test_found_reasonable_number_of_registrations() -> None:
    """Guard against the test silently passing because parsing failed to find anything."""
    activity_refs = _extract_worker_activity_references()
    workflow_refs = _extract_worker_workflow_references()

    assert len(activity_refs) >= 30, (
        f"Expected worker.py to register many activities, found {len(activity_refs)}"
    )
    assert len(workflow_refs) >= 10, (
        f"Expected worker.py to register many workflows, found {len(workflow_refs)}"
    )


def test_all_ops_branch_brief_activities_registered() -> None:
    """Every @activity.defn function in ops_branch_brief must be registered in worker.py.

    This is the inverse of test_all_registered_activities_exist: it catches the case
    where a developer adds a new @activity.defn to ops_branch_brief but forgets to add
    it to the Worker(activities=[...]) list, which would silently leave the activity
    unreachable by the Temporal worker.
    """
    import sys
    from pathlib import Path

    temporal_root = Path(__file__).resolve().parents[1]
    if str(temporal_root) not in sys.path:
        sys.path.insert(0, str(temporal_root))

    from temporal.src.activities import ops_branch_brief

    # Collect every callable decorated with @activity.defn in the module.
    decorated: list[str] = [
        name
        for name, obj in inspect.getmembers(ops_branch_brief)
        if (
            callable(obj)
            and hasattr(obj, "__temporal_activity_definition")
            and inspect.getmodule(obj) is ops_branch_brief
        )
    ]
    assert decorated, "Expected to find @activity.defn functions in ops_branch_brief"

    # Collect what worker.py registers under the ops_branch_brief alias.
    registered_fns = {
        fn_name
        for alias, fn_name in _extract_worker_activity_references()
        if alias == "ops_branch_brief"
    }

    unregistered = [fn for fn in decorated if fn not in registered_fns]
    assert not unregistered, (
        "ops_branch_brief has @activity.defn functions not registered in worker.py "
        "(would be unreachable by the Temporal worker):\n"
        + "\n".join(f"  - {fn}" for fn in unregistered)
    )


def test_all_ops_credit_activities_registered() -> None:
    """Every @activity.defn function in ops_credit must be registered in worker.py.

    Inverse coverage that would have caught the missing ops_credit.ops_list_existing_findings
    registration before it reached the architecture audit.
    """
    import sys
    from pathlib import Path

    temporal_root = Path(__file__).resolve().parents[1]
    if str(temporal_root) not in sys.path:
        sys.path.insert(0, str(temporal_root))

    from temporal.src.activities import ops_credit

    decorated: list[str] = [
        name
        for name, obj in inspect.getmembers(ops_credit)
        if (
            callable(obj)
            and hasattr(obj, "__temporal_activity_definition")
            and inspect.getmodule(obj) is ops_credit
        )
    ]
    assert decorated, "Expected to find @activity.defn functions in ops_credit"

    registered_fns = {
        fn_name
        for alias, fn_name in _extract_worker_activity_references()
        if alias == "ops_credit"
    }

    unregistered = [fn for fn in decorated if fn not in registered_fns]
    assert not unregistered, (
        "ops_credit has @activity.defn functions not registered in worker.py "
        "(would be unreachable by the Temporal worker):\n"
        + "\n".join(f"  - {fn}" for fn in unregistered)
    )


def test_all_ops_disposition_activities_registered() -> None:
    """Every @activity.defn function in ops_disposition must be registered in worker.py.

    Catches the exact class of bug where ops_record_finding_review was defined in
    ops_disposition but omitted from the Worker(activities=[...]) list, which would
    cause the first real review signal to fail with an unregistered-activity error.
    """
    import sys
    from pathlib import Path

    temporal_root = Path(__file__).resolve().parents[1]
    if str(temporal_root) not in sys.path:
        sys.path.insert(0, str(temporal_root))

    from temporal.src.activities import ops_disposition

    decorated: list[str] = [
        name
        for name, obj in inspect.getmembers(ops_disposition)
        if (
            callable(obj)
            and hasattr(obj, "__temporal_activity_definition")
            and inspect.getmodule(obj) is ops_disposition
        )
    ]
    assert decorated, "Expected to find @activity.defn functions in ops_disposition"

    registered_fns = {
        fn_name
        for alias, fn_name in _extract_worker_activity_references()
        if alias == "ops_disposition"
    }

    unregistered = [fn for fn in decorated if fn not in registered_fns]
    assert not unregistered, (
        "ops_disposition has @activity.defn functions not registered in worker.py "
        "(would be unreachable by the Temporal worker):\n"
        + "\n".join(f"  - {fn}" for fn in unregistered)
    )


def test_all_ops_contract_ocr_activities_registered() -> None:
    """Every @activity.defn function in ops_contract_ocr must be registered in worker.py.

    Guards the explicit OCR boundary for ContractOcrRevalidationWorkflow: if a new
    activity is added to ops_contract_ocr but not registered in worker.py it would
    be silently unreachable, defeating the no-bypass contract analysis gate.
    """
    import sys
    from pathlib import Path

    temporal_root = Path(__file__).resolve().parents[1]
    if str(temporal_root) not in sys.path:
        sys.path.insert(0, str(temporal_root))

    from temporal.src.activities import ops_contract_ocr

    decorated: list[str] = [
        name
        for name, obj in inspect.getmembers(ops_contract_ocr)
        if (
            callable(obj)
            and hasattr(obj, "__temporal_activity_definition")
            and inspect.getmodule(obj) is ops_contract_ocr
        )
    ]
    assert decorated, "Expected to find @activity.defn functions in ops_contract_ocr"

    registered_fns = {
        fn_name
        for alias, fn_name in _extract_worker_activity_references()
        if alias == "ops_contract_ocr"
    }

    unregistered = [fn for fn in decorated if fn not in registered_fns]
    assert not unregistered, (
        "ops_contract_ocr has @activity.defn functions not registered in worker.py "
        "(would be unreachable by the Temporal worker):\n"
        + "\n".join(f"  - {fn}" for fn in unregistered)
    )
