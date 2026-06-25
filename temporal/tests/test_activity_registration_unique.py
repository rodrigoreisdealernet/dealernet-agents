"""Regression guard: every Temporal @activity.defn must have a globally-unique name.

temporalio rejects duplicate activity names when the Worker is constructed, which
crashes the worker on startup (CrashLoopBackOff) and times out the deploy rollout.
This actually happened: ops_fleet duplicated six ops_revrec activity names
(ops_load_agent_config, ops_create_workflow_run, ops_record_finding, ...), so the
new worker image crash-looped while the old one kept serving — an opaque
`helm upgrade --wait: context deadline exceeded` deploy failure.

Worker registration calls activities by function reference, so the activity NAME is
whatever `@activity.defn(name=...)` resolves to (defaulting to the function name).
Two activities sharing a name in modules that the worker co-registers is the bug.
This test imports every module under src/activities/ and asserts no name repeats.
"""
from __future__ import annotations

import importlib
import inspect
import pkgutil
from pathlib import Path

TEMPORAL_SRC = Path(__file__).resolve().parents[1] / "src"


def _activity_name(fn: object) -> str | None:
    definition = getattr(fn, "__temporal_activity_definition", None)
    return getattr(definition, "name", None)


def _all_activity_names() -> dict[str, list[str]]:
    """Map activity-name -> [qualified function locations] across src/activities/."""
    import sys

    sys.path.insert(0, str(TEMPORAL_SRC.parent))
    activities_pkg = importlib.import_module("src.activities")
    names: dict[str, list[str]] = {}
    for mod_info in pkgutil.iter_modules(activities_pkg.__path__):
        module = importlib.import_module(f"src.activities.{mod_info.name}")
        for fn_name, fn in inspect.getmembers(module, inspect.isfunction):
            act_name = _activity_name(fn)
            if act_name is not None:
                names.setdefault(act_name, []).append(f"src.activities.{mod_info.name}.{fn_name}")
    return names


def test_every_activity_name_is_globally_unique() -> None:
    names = _all_activity_names()
    duplicates = {name: locs for name, locs in names.items() if len(locs) > 1}
    assert not duplicates, (
        "Duplicate Temporal activity names would crash the worker at Worker() "
        "construction (CrashLoopBackOff). Give each a distinct @activity.defn(name=...):\n"
        + "\n".join(f"  {name}: {locs}" for name, locs in sorted(duplicates.items()))
    )


def test_found_a_reasonable_number_of_activities() -> None:
    # Guard against the test silently passing because imports failed / found nothing.
    names = _all_activity_names()
    assert len(names) >= 20, f"expected the activities package to define many activities, found {len(names)}"
