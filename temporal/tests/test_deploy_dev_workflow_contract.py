from __future__ import annotations

from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "deploy-dev.yml"
APP_NAME = "rental-app"
HELM_UPGRADE_STEP = "Helm upgrade (dia-dev)"
DIAGNOSTICS_STEP = "Diagnose rollout failure (pods, events, logs)"
DB_BOOTSTRAP_STEP = "Apply Supabase migrations + demo seed (in-cluster job)"
YAML_BLOCK_INDENT = 2


@lru_cache(maxsize=1)
def _workflow_text() -> str:
    return WORKFLOW_PATH.read_text()


def _workflow_lines() -> list[str]:
    return _workflow_text().splitlines()


def _extract_concurrency_block() -> list[str]:
    lines = _workflow_lines()
    start = next((i for i, line in enumerate(lines) if line.strip() == "concurrency:"), None)
    assert start is not None, "Unable to locate `concurrency:` block in deploy-dev workflow."

    block: list[str] = []
    for line in lines[start + 1 :]:
        if line and not line.startswith(" "):
            break
        block.append(line)
    return block


def _find_step_index(step_name: str) -> int:
    marker = f"- name: {step_name}"
    step_index = next((i for i, line in enumerate(_workflow_lines()) if line.strip() == marker), None)
    assert step_index is not None, f"Unable to locate workflow step `{step_name}`."
    return step_index


def _extract_step_block(step_name: str) -> list[str]:
    lines = _workflow_lines()
    step_index = _find_step_index(step_name)
    step_indent = len(lines[step_index]) - len(lines[step_index].lstrip(" "))
    block = [lines[step_index]]

    for line in lines[step_index + 1 :]:
        stripped = line.strip()
        indent = len(line) - len(line.lstrip(" "))
        if stripped and indent <= step_indent and stripped.startswith("- name:"):
            break
        if stripped and indent < step_indent:
            break
        block.append(line)
    return block


def _extract_step_run_script(step_name: str) -> str:
    step_block = _extract_step_block(step_name)
    run_index = next((i for i, line in enumerate(step_block) if line.strip().startswith("run:")), None)
    assert run_index is not None, f"Unable to locate `run:` block for step `{step_name}`."

    run_line = step_block[run_index].strip()
    if run_line.startswith("run: ") and run_line not in {"run: |", "run: >", "run: |-", "run: >-", "run: |+", "run: >+"}:
        return run_line.partition("run:")[2].strip()

    run_line_indent = len(step_block[run_index]) - len(step_block[run_index].lstrip(" "))
    content_indent = run_line_indent + YAML_BLOCK_INDENT
    script_lines: list[str] = []

    for line in step_block[run_index + 1 :]:
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if stripped and indent >= content_indent:
            script_lines.append(line[content_indent:])
            continue
        if stripped == "":
            script_lines.append("")
            continue
        break

    return "\n".join(script_lines)


def test_deploy_dev_uses_dev_lane_concurrency_group() -> None:
    block_text = "\n".join(_extract_concurrency_block())
    assert "group: deploy-dev" in block_text


def test_deploy_dev_does_not_cancel_in_progress_rollouts() -> None:
    block = _extract_concurrency_block()
    setting_line = next((line for line in block if line.strip().startswith("cancel-in-progress:")), None)
    assert setting_line is not None, "deploy-dev concurrency must define cancel-in-progress explicitly."
    assert setting_line.strip() == "cancel-in-progress: false"


def test_deploy_dev_concurrency_documents_latest_pending_coalescing() -> None:
    assert "single most-recent pending run" in _workflow_text()
    assert "cancels older" in _workflow_text()
    assert "pending ones" in _workflow_text()


def test_deploy_dev_rollout_diagnostics_only_run_after_helm_failure() -> None:
    workflow_text = "\n".join(_extract_step_block(DIAGNOSTICS_STEP))

    assert _find_step_index(DIAGNOSTICS_STEP) > _find_step_index(HELM_UPGRADE_STEP)
    assert "if: failure()" in workflow_text


def test_deploy_dev_rollout_diagnostics_capture_actionable_pod_debug_signals() -> None:
    script = _extract_step_run_script(DIAGNOSTICS_STEP)

    # The script sets release_name=APP_NAME and then calls `helm status "$release_name"`.
    # Assert both that the variable is set to the correct app name and that helm status
    # uses it, so the contract holds even when the literal app name is not embedded directly
    # in the helm command.
    assert f"release_name='{APP_NAME}'" in script
    assert 'helm status "$release_name" -n "$ns"' in script
    assert 'kubectl get pods -n "$ns" -o wide' in script
    assert 'kubectl get events -n "$ns" --sort-by=.lastTimestamp' in script
    assert "for pod in $(kubectl get pods -n \"$ns\" -o jsonpath=" in script
    assert 'if [ "$phase" != "Running" ]' in script
    assert "printf" in script
    assert "grep -qiw false" in script
    assert 'kubectl describe pod "$pod" -n "$ns"' in script
    assert 'kubectl logs "$pod" -n "$ns" --all-containers --tail=60' in script
    assert 'kubectl logs "$pod" -n "$ns" --all-containers --previous --tail=60' in script


def test_deploy_dev_rollout_diagnostics_remain_observational_with_grouped_logs() -> None:
    workflow_text = "\n".join(_extract_step_block(DIAGNOSTICS_STEP))
    script = _extract_step_run_script(DIAGNOSTICS_STEP)

    assert "continue-on-error:" not in workflow_text
    assert "set +e" in script
    assert 'echo "::group::helm status rental-app"' in script
    assert 'echo "::group::pods (-o wide)"' in script
    assert 'echo "::group::recent events"' in script
    assert 'echo "::group::describe $pod (phase=$phase ready=[$ready])"' in script
    assert 'echo "::group::logs $pod (current, last 60)"' in script
    assert 'echo "::group::logs $pod (previous, last 60)"' in script
    assert "exit 0" in script


def test_deploy_dev_bootstrap_validates_non_empty_migrations_configmap() -> None:
    script = _extract_step_run_script(DB_BOOTSTRAP_STEP)

    assert 'create configmap "$migrations_configmap"' in script
    assert 'Generated migrations configmap \'$migrations_configmap\' has no .tar.gz entries in .binaryData' in script
    # Verification iterates .binaryData (binary --from-file entries) not .data.
    # The kubectl command may span two lines via a backslash continuation.
    assert 'get configmap "$migrations_configmap"' in script
    assert ".binaryData" in script
    assert "grep -E '\\.tar\\.gz$'" in script


def test_deploy_dev_bootstrap_reads_sql_migrations_from_tarball_extraction() -> None:
    """The bootstrap pod now extracts a gzip tarball from the ConfigMap mount
    into /tmp/migrations (a real directory, not a symlink mount) before applying
    migrations.  The runner packages all .sql files into migrations.tar.gz to stay
    within the 1 MiB ConfigMap limit."""
    script = _extract_step_run_script(DB_BOOTSTRAP_STEP)

    assert "tar -xzf /bootstrap/migrations/migrations.tar.gz -C /tmp/migrations" in script
    assert "find /tmp/migrations -maxdepth 1 -name '*.sql' | sort" in script
    assert "find /bootstrap/migrations -maxdepth 1 -name '*.sql' | sort" not in script, (
        "Migrations are no longer read directly from the ConfigMap mount path; "
        "they must be extracted from the tarball into /tmp/migrations first."
    )


def test_deploy_dev_bootstrap_records_migration_history_via_psql_script_mode() -> None:
    script = _extract_step_run_script(DB_BOOTSTRAP_STEP)

    assert "psql_exec -v migration_name=\"$migration_name\" <<'SQL'" in script
    assert "VALUES (:'migration_name')" in script
    assert '-c "INSERT INTO public.dia_deploy_migrations' not in script


def test_deploy_dev_bootstrap_migrations_configmap_uses_plain_create() -> None:
    """Regression guard: the run-scoped migrations ConfigMap must be created with
    plain `kubectl create configmap`, not `kubectl apply`.  Using apply stores the
    entire object in the `last-applied-configuration` annotation, which is capped at
    256KiB — the migrations payload exceeded that cap and failed every bootstrap."""
    script = _extract_step_run_script(DB_BOOTSTRAP_STEP)

    assert 'create configmap "$migrations_configmap"' in script, (
        "The migrations ConfigMap must be created with `kubectl create configmap`, "
        "not `kubectl apply`. Using apply would silently reintroduce the 256KiB "
        "last-applied-configuration annotation cap failure."
    )


def test_deploy_dev_bootstrap_migrations_configmap_not_created_with_apply() -> None:
    """Regression guard: no `kubectl apply` command in the DB-bootstrap step must
    target the migrations ConfigMap.  The only permitted `kubectl apply` is for the
    Job manifest file (which does not carry large annotation payloads)."""
    script = _extract_step_run_script(DB_BOOTSTRAP_STEP)

    apply_lines = [line for line in script.splitlines() if "kubectl" in line and "apply" in line]
    for line in apply_lines:
        assert "$migrations_configmap" not in line, (
            f"Found `kubectl apply` line referencing migrations_configmap: {line!r}. "
            "Use `kubectl create configmap` to avoid the 256KiB annotation cap."
        )


def test_deploy_dev_bootstrap_documents_256kib_annotation_cap_workaround() -> None:
    """The 256KiB last-applied-configuration annotation cap workaround must be
    documented in the workflow script so future maintainers understand why plain
    `create` is used instead of `apply` for the migrations ConfigMap."""
    script = _extract_step_run_script(DB_BOOTSTRAP_STEP)

    assert "256KiB" in script, (
        "The script must document the 256KiB annotation cap reason for using plain create."
    )
    assert "last-applied-configuration" in script, (
        "The script must mention the last-applied-configuration annotation to explain "
        "why plain `kubectl create` is required over `kubectl apply`."
    )


def test_deploy_dev_bootstrap_migrations_configmap_is_run_scoped_and_ephemeral() -> None:
    """The migrations ConfigMap name must be unique to the GitHub Actions run so
    concurrent or retried runs do not collide, and must be deleted on EXIT so it
    does not accumulate across deploys."""
    script = _extract_step_run_script(DB_BOOTSTRAP_STEP)

    assert 'bootstrap_job="dia-db-bootstrap-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"' in script, (
        "The bootstrap job (and derived ConfigMap) name must embed GITHUB_RUN_ID "
        "and GITHUB_RUN_ATTEMPT to stay unique per run attempt."
    )
    assert 'migrations_configmap="${bootstrap_job}-migrations"' in script, (
        "The migrations ConfigMap name must be derived from the run-scoped bootstrap_job name."
    )
    assert 'delete configmap "$migrations_configmap"' in script, (
        "The migrations ConfigMap must be deleted in the cleanup function."
    )
    assert "trap cleanup EXIT" in script, (
        "The cleanup function must be registered as an EXIT trap so the ConfigMap "
        "is removed even when the step fails or is cancelled."
    )
