"""Audit: every Temporal workflow/activity defined in the worker package is registered.

Blind spot this closes: a PR that adds a workflow file rarely touches worker.py,
so a diff-scoped reviewer cannot see that the new workflow is never registered and
therefore cannot run. (See #269: Maintenance/Inspection/Transfer/Invoice workflows
and all rental_operations activities were defined but unregistered.)
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

try:
    from ._common import CheckResult, Finding, emit, repo_root
except ImportError:  # invoked as a script, not a package
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _common import CheckResult, Finding, emit, repo_root  # type: ignore


def _has_decorator(node: ast.AST, attr: str) -> bool:
    decorators = getattr(node, "decorator_list", [])
    for dec in decorators:
        target = dec.func if isinstance(dec, ast.Call) else dec
        # matches `@workflow.defn` / `@activity.defn` (and the bare/var forms)
        if isinstance(target, ast.Attribute) and target.attr == attr:
            return True
        if isinstance(target, ast.Name) and target.id == attr:
            return True
    return False


def _defined_names(root: Path, kind: str) -> set[str]:
    """kind='defn' on classes (workflows) or functions (activities)."""
    names: set[str] = set()
    if not root.exists():
        return names
    for path in root.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            is_class = isinstance(node, ast.ClassDef)
            is_func = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            if kind == "workflow" and is_class and _has_decorator(node, "defn"):
                names.add(node.name)
            elif kind == "activity" and is_func and _has_decorator(node, "defn"):
                names.add(node.name)
    return names


def _registered_names(worker_py: Path) -> tuple[set[str], set[str]]:
    """Extract names passed to Worker(workflows=[...], activities=[...])."""
    workflows: set[str] = set()
    activities: set[str] = set()
    if not worker_py.exists():
        return workflows, activities
    tree = ast.parse(worker_py.read_text(encoding="utf-8"))

    def collect(elts: list[ast.expr]) -> set[str]:
        out: set[str] = set()
        for el in elts:
            if isinstance(el, ast.Attribute):  # module.func
                out.add(el.attr)
            elif isinstance(el, ast.Name):  # ClassName / func
                out.add(el.id)
        return out

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            for kw in node.keywords:
                if kw.arg == "workflows" and isinstance(kw.value, (ast.List, ast.Tuple)):
                    workflows |= collect(kw.value.elts)
                if kw.arg == "activities" and isinstance(kw.value, (ast.List, ast.Tuple)):
                    activities |= collect(kw.value.elts)
    return workflows, activities


def find_unregistered(src_root: Path) -> list[Finding]:
    """src_root is temporal/src. Returns findings for defined-but-unregistered."""
    worker_py = src_root / "worker.py"
    defined_wf = _defined_names(src_root / "workflows", "workflow")
    defined_act = _defined_names(src_root / "activities", "activity")
    reg_wf, reg_act = _registered_names(worker_py)

    findings: list[Finding] = []
    for name in sorted(defined_wf - reg_wf):
        findings.append(
            Finding(
                check="temporal-registration",
                severity="CRITICAL",
                location="temporal/src/worker.py",
                message=f"Workflow `{name}` is @workflow.defn but not registered with the Worker — it cannot run.",
                issue="#269",
            )
        )
    for name in sorted(defined_act - reg_act):
        findings.append(
            Finding(
                check="temporal-registration",
                severity="HIGH",
                location="temporal/src/worker.py",
                message=f"Activity `{name}` is @activity.defn but not registered with the Worker.",
                issue="#269",
            )
        )
    return findings


def run(root: Path | None = None) -> CheckResult:
    root = root or repo_root()
    return CheckResult(
        name="temporal-registration",
        findings=find_unregistered(root / "temporal" / "src"),
    )


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--strict", action="store_true", help="exit non-zero if findings exist")
    args = ap.parse_args()
    result = run()
    emit([result])
    return 1 if (args.strict and not result.ok) else 0


if __name__ == "__main__":
    raise SystemExit(main())
