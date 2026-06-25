"""Tests proving the architecture-audit checkers actually catch the defects they target.

These are fixture-based (stable/green regardless of repo state) so they verify the
*tooling* works. A separate non-gating CI job runs the checks against the live repo.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

AUDIT_DIR = Path(__file__).resolve().parents[2] / "scripts" / "audit"
sys.path.insert(0, str(AUDIT_DIR))

import check_temporal_registration as reg  # noqa: E402
import check_view_security_invoker as views  # noqa: E402
import check_workflow_security as wfsec  # noqa: E402

ARCHITECTURE_AUDIT_WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "architecture-audit.yml"


# ---- temporal registration ------------------------------------------------

def _write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_registration_flags_unregistered_workflow_and_activity(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(
        src / "workflows" / "a.py",
        "from temporalio import workflow\n"
        "@workflow.defn\nclass RegisteredWorkflow:\n    pass\n"
        "@workflow.defn\nclass OrphanWorkflow:\n    pass\n",
    )
    _write(
        src / "activities" / "b.py",
        "from temporalio import activity\n"
        "@activity.defn\ndef registered_act():\n    return 1\n"
        "@activity.defn\ndef orphan_act():\n    return 2\n",
    )
    _write(
        src / "worker.py",
        "from temporalio.worker import Worker\n"
        "from .activities import b\n"
        "from .workflows.a import RegisteredWorkflow\n"
        "Worker(client, task_queue='q',\n"
        "    workflows=[RegisteredWorkflow],\n"
        "    activities=[b.registered_act],\n"
        ")\n",
    )
    findings = reg.find_unregistered(src)
    names = {f.message for f in findings}
    assert any("OrphanWorkflow" in m for m in names), findings
    assert any("orphan_act" in m for m in names), findings
    # The registered ones must NOT be flagged.
    assert not any("RegisteredWorkflow" in m for m in names)
    assert not any("registered_act" in m for m in names)


def test_registration_clean_when_all_registered(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(
        src / "workflows" / "a.py",
        "from temporalio import workflow\n@workflow.defn\nclass W:\n    pass\n",
    )
    _write(
        src / "activities" / "b.py",
        "from temporalio import activity\n@activity.defn\ndef act():\n    return 1\n",
    )
    _write(
        src / "worker.py",
        "from temporalio.worker import Worker\n"
        "Worker(client, workflows=[W], activities=[b.act])\n",
    )
    assert reg.find_unregistered(src) == []


def _extract_activity_defn_names(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        for dec in getattr(node, "decorator_list", []):
            target = dec.func if isinstance(dec, ast.Call) else dec
            if (
                isinstance(target, ast.Attribute)
                and target.attr == "defn"
                and isinstance(target.value, ast.Name)
                and target.value.id == "activity"
            ):
                out.add(node.name)
                break
    return out


def test_extract_activity_defn_names(tmp_path: Path) -> None:
    module_path = tmp_path / "activities.py"
    _write(
        module_path,
        "from temporalio import activity\n"
        "@activity.defn\ndef sync_activity():\n    return 1\n"
        "@activity.defn\nasync def async_activity():\n    return 2\n"
        "def plain_function():\n    return 3\n",
    )
    assert _extract_activity_defn_names(module_path) == {"sync_activity", "async_activity"}


def test_rental_workflows_and_rental_operations_activities_are_registered() -> None:
    repo = Path(__file__).resolve().parents[2]
    findings = reg.find_unregistered(repo / "temporal" / "src")
    unregistered_names = {
        m.group(1)
        for f in findings
        for m in [re.search(r"`([^`]+)`", f.message)]
        if m
    }

    # Parse __all__ from the rental package __init__.py without importing it
    # (avoids a temporalio runtime dep in the audit-only CI step).
    rental_init = repo / "temporal" / "src" / "workflows" / "rental" / "__init__.py"
    tree = ast.parse(rental_init.read_text(encoding="utf-8"))
    rental_all: list[str] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets)
            and isinstance(node.value, ast.List)
        ):
            rental_all = [
                elt.value
                for elt in node.value.elts
                if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
            ]

    missing_workflows = set(rental_all) & unregistered_names
    assert not missing_workflows, f"Missing rental workflow registrations: {sorted(missing_workflows)}"

    rental_operations_py = repo / "temporal" / "src" / "activities" / "rental_operations.py"
    defined_rental_operation_activities = _extract_activity_defn_names(rental_operations_py)
    missing_activities = defined_rental_operation_activities & unregistered_names
    assert not missing_activities, f"Missing rental operations activity registrations: {sorted(missing_activities)}"


# ---- workflow security ----------------------------------------------------

def test_workflow_security_flags_pr_target_with_secrets(tmp_path: Path) -> None:
    d = tmp_path / ".github" / "workflows"
    _write(
        d / "bad.yml",
        "on:\n  pull_request_target:\n    types: [labeled]\n"
        "jobs:\n  x:\n    steps:\n      - run: echo ${{ secrets.MY_PAT }}\n",
    )
    findings = wfsec.scan_workflows(d)
    assert len(findings) == 1
    assert findings[0].severity == "CRITICAL"
    assert "bad.yml" in findings[0].location


def test_workflow_security_allows_plain_pull_request(tmp_path: Path) -> None:
    d = tmp_path / ".github" / "workflows"
    _write(
        d / "ok.yml",
        "on:\n  pull_request:\n    branches: [main]\n"
        "jobs:\n  x:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
    )
    assert wfsec.scan_workflows(d) == []


def _extract_block(lines: list[str], key: str, *, indent: int) -> list[str]:
    target = f"{' ' * indent}{key}:"
    start = None
    for i, line in enumerate(lines):
        if line == target:
            start = i
            break
    assert start is not None, f"Missing `{key}` block"

    block: list[str] = []
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if stripped:
            current_indent = len(line) - len(line.lstrip(" "))
            if current_indent <= indent:
                break
        block.append(line)
    return block


def _extract_top_level_block(text: str, key: str) -> list[str]:
    return _extract_block(text.splitlines(), key, indent=0)


def _extract_job_block(text: str, job_name: str) -> list[str]:
    jobs_block = _extract_top_level_block(text, "jobs")
    return _extract_block(jobs_block, job_name, indent=2)


def _non_comment_lines(lines: list[str]) -> list[str]:
    return [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]


def test_architecture_audit_workflow_keeps_required_pull_request_trigger_paths() -> None:
    text = ARCHITECTURE_AUDIT_WORKFLOW.read_text(encoding="utf-8")
    on_block = _extract_top_level_block(text, "on")
    pull_request_block = _extract_block(on_block, "pull_request", indent=2)
    paths_block = _extract_block(pull_request_block, "paths", indent=4)

    paths = {
        stripped.removeprefix("- ").strip("'\"")
        for line in paths_block
        if (stripped := line.strip()).startswith("- ")
    }
    assert ".github/workflows/**" in paths
    assert "scripts/audit/**" in paths


def test_architecture_audit_workflow_has_strict_workflow_security_gate_job() -> None:
    text = ARCHITECTURE_AUDIT_WORKFLOW.read_text(encoding="utf-8")
    gate_job = _extract_job_block(text, "workflow-security-gate")
    gate_job_text = "\n".join(gate_job)
    gate_job_non_comment_lines = _non_comment_lines(gate_job)

    assert "name: Workflow security gate" in gate_job_text
    assert "strict" in gate_job_text
    assert "blocks merge" in gate_job_text
    assert "run: python scripts/audit/check_workflow_security.py --strict" in gate_job_text
    assert "continue-on-error: true" not in gate_job_non_comment_lines
    assert not any("|| true" in line for line in gate_job_non_comment_lines)


def test_architecture_audit_workflow_keeps_report_only_and_strict_split() -> None:
    text = ARCHITECTURE_AUDIT_WORKFLOW.read_text(encoding="utf-8")
    report_job = _extract_job_block(text, "audit")
    gate_job = _extract_job_block(text, "workflow-security-gate")
    report_job_text = "\n".join(report_job)
    gate_job_text = "\n".join(gate_job)

    assert "run: python scripts/audit/run_audits.py" in report_job_text
    assert "run: python scripts/audit/run_audits.py --strict" not in report_job_text
    assert "run: python scripts/audit/check_workflow_security.py --strict" in gate_job_text


# ---- view security_invoker ------------------------------------------------

def test_view_check_flags_missing_security_invoker(tmp_path: Path) -> None:
    d = tmp_path / "migrations"
    _write(
        d / "001_x.sql",
        "create view v_bad as select 1;\n"
        "create or replace view v_good\n"
        "  with (security_invoker = true) as select 2;\n",
    )
    findings = views.scan_migrations(d)
    msgs = " ".join(f.message for f in findings)
    assert "v_bad" in msgs
    assert "v_good" not in msgs


def test_view_check_clean_when_all_invoker(tmp_path: Path) -> None:
    d = tmp_path / "migrations"
    _write(
        d / "001_x.sql",
        "create view v_a with (security_invoker = true) as select 1;\n",
    )
    assert views.scan_migrations(d) == []


def test_view_check_uses_latest_definition_for_each_view(tmp_path: Path) -> None:
    d = tmp_path / "migrations"
    _write(d / "001_x.sql", "create view v_same as select 1;\n")
    _write(
        d / "002_y.sql",
        "create or replace view v_same with (security_invoker = true) as select 1;\n",
    )
    assert views.scan_migrations(d) == []
