import re
import tomllib
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "pr-validation.yml"
PYPROJECT_PATH = REPO_ROOT / "temporal" / "pyproject.toml"
RESET_VALIDATION_LIB_PATH = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
TEMPORAL_JOB_NAME = "temporal"
MIN_TEMPORAL_TIMEOUT_MINUTES = 1
# The Temporal suite currently completes in ~52 minutes on the referenced incident run.
# Keep a safety margin while still enforcing a bounded upper limit that prevents
# effectively unbounded required-check hangs.
MAX_TEMPORAL_TIMEOUT_MINUTES = 120


def _workflow_text() -> str:
    return WORKFLOW_PATH.read_text()


def _pyproject_data() -> dict:
    return tomllib.loads(PYPROJECT_PATH.read_text())


def _reset_validation_lib_text() -> str:
    return RESET_VALIDATION_LIB_PATH.read_text()


def _extract_db_surface_grep_pattern() -> str:
    """Extract the DB-surface regex from the scope step shell script."""
    text = _workflow_text()
    m = re.search(r"""db_surface_pattern='([^']+)'""", text)
    assert m, (
        "Could not find db_surface_pattern in the scope step of pr-validation.yml. "
        "The scoping step has been removed or reformatted."
    )
    return m.group(1)


def _extract_temporal_surface_grep_pattern() -> str:
    """Extract the Temporal-surface regex from the scope step shell script."""
    text = _workflow_text()
    m = re.search(r"""temporal_surface_pattern='([^']+)'""", text)
    assert m, (
        "Could not find temporal_surface_pattern in the scope step of "
        "pr-validation.yml. The scoping step has been removed or reformatted."
    )
    return m.group(1)


def _simulate_scope_outputs(changed_paths: list[str]) -> tuple[int, int]:
    """Mirror workflow scope logic for deterministic behavior checks.

    Returns (skip_reset, skip_temporal_suite).
    """
    db_pattern = re.compile(_extract_db_surface_grep_pattern())
    temporal_pattern = re.compile(_extract_temporal_surface_grep_pattern())

    if not changed_paths:
        return 0, 1
    if any(temporal_pattern.match(path) for path in changed_paths):
        return (0 if any(db_pattern.match(path) for path in changed_paths) else 1, 0)
    if any(db_pattern.match(path) for path in changed_paths):
        return 0, 1
    return 1, 1


_TEMPORAL_JOB_TIMEOUT_MAX = 90  # minutes — enough for the full reset suite plus buffer


def test_temporal_job_has_bounded_timeout() -> None:
    """The Temporal worker tests job must carry a timeout-minutes guard so a hung
    runner cannot block the required check indefinitely.

    Incident reference: a frontend-only PR (touching only
    ``frontend/e2e/experience.spec.ts``) was blocked for >25 minutes because the
    ``Temporal worker tests`` job had no effective upper bound and stalled with no
    heartbeat (run 27480296536, job 81226775373).  Any PR that triggers this job
    must be able to reach a terminal conclusion within a bounded wall-clock window.

    The timeout must be:
    - Present (prevents infinite hangs).
    - ≤ 90 minutes (keeps it a real bound, not a token value like 360).
    """
    text = _workflow_text()

    # Locate the temporal job block: find "name: Temporal worker tests" and
    # then extract the next timeout-minutes value that follows it.
    job_match = re.search(
        r"name:\s*Temporal worker tests.*?timeout-minutes:\s*(\d+)",
        text,
        re.DOTALL,
    )
    assert job_match, (
        "The 'Temporal worker tests' job in pr-validation.yml must have a "
        "'timeout-minutes' key. Without it a hung runner silently wedges every "
        "open PR that triggers this job (incident: run 27480296536)."
    )
    actual = int(job_match.group(1))
    assert actual <= _TEMPORAL_JOB_TIMEOUT_MAX, (
        f"The Temporal worker tests timeout ({actual} min) exceeds the maximum "
        f"allowed ({_TEMPORAL_JOB_TIMEOUT_MAX} min). A very large timeout is "
        f"effectively no timeout and allows stuck runs to block the required check "
        f"for hours."
    )


def test_pr_validation_cancels_stale_pr_runs() -> None:
    """Stale PR runs must be cancelled when a new commit is pushed so a
    retriggered PR validation always advances to the current head SHA rather
    than queuing behind an older run.  cancel-in-progress must use a
    conditional expression that evaluates to true for pull_request events
    and false for push-to-main, preserving trunk coverage."""
    text = _workflow_text()
    assert "cancel-in-progress: ${{ github.event_name == 'pull_request' }}" in text, (
        "cancel-in-progress must be conditional on pull_request events so stale "
        "PR runs are retired automatically when a new commit is pushed."
    )
    assert "cancel-in-progress: false" not in text, (
        "Hard-coded 'cancel-in-progress: false' would prevent stale PR runs from "
        "being retired, wedging newer head SHAs behind older runs."
    )


def test_pr_validation_temporal_suite_has_fail_fast_timeout_guard() -> None:
    """Temporal pytest execution must be bounded inside the step so hung test
    runs fail closed with diagnostics before the job-level timeout."""
    text = _workflow_text()
    assert "timeout_budget=" in text
    assert "timeout --signal=SIGINT --kill-after=60s" in text
    assert "bash -o pipefail -c '" in text
    assert "heartbeat_interval_seconds=" in text
    assert 'Temporal suite in progress (elapsed ${elapsed}s / timeout ${pytest_timeout_minutes}m).' in text
    assert "--preserve-status" not in text
    assert '"$timeout_budget"' in text
    assert "python -X faulthandler -m pytest temporal/tests -v" in text
    assert '2>&1 | tee "$1"' in text
    assert "GNU timeout returns exit code 124" in text
    assert "Temporal test suite timed out after ${pytest_timeout_minutes} minutes (fail-fast guard)." in text


def test_pr_validation_temporal_job_has_bounded_timeout() -> None:
    """The Temporal worker job must be bounded so a hung pytest run cannot
    hold the required PR check open indefinitely."""
    lines = _workflow_text().splitlines()
    temporal_start: int | None = None
    temporal_indent: int | None = None
    for index, line in enumerate(lines):
        if re.match(rf"^\s+{TEMPORAL_JOB_NAME}:\s*$", line):
            temporal_start = index
            temporal_indent = len(line) - len(line.lstrip())
            break

    assert temporal_start is not None and temporal_indent is not None, (
        "Temporal worker tests job must exist in PR validation workflow."
    )

    timeout_minutes: int | None = None
    for line in lines[temporal_start + 1 :]:
        stripped = line.strip()
        if not stripped:
            continue
        line_indent = len(line) - len(line.lstrip())
        if line_indent <= temporal_indent and stripped.endswith(":"):
            break
        if stripped.startswith("timeout-minutes:"):
            timeout_minutes = int(stripped.split(":", 1)[1].strip())
            break

    assert timeout_minutes is not None, (
        "Temporal worker tests job must define timeout-minutes so stuck test "
        "runs fail closed instead of hanging indefinitely."
    )
    assert MIN_TEMPORAL_TIMEOUT_MINUTES <= timeout_minutes <= MAX_TEMPORAL_TIMEOUT_MINUTES, (
        "Temporal worker tests timeout must be bounded to a practical value "
        f"({MIN_TEMPORAL_TIMEOUT_MINUTES}-{MAX_TEMPORAL_TIMEOUT_MINUTES} minutes) "
        "so CI cannot stall indefinitely."
    )


def test_pr_validation_uploads_temporal_diagnostics_artifacts() -> None:
    """Temporal CI diagnostics/log artifacts must be uploaded so timeout/failure
    incidents have actionable evidence."""
    text = _workflow_text()
    assert "temporal/pytest-output.log" in text
    assert "temporal/pytest-heartbeat.log" in text
    assert "temporal/pytest-diagnostics.txt" in text


def test_temporal_pyproject_includes_pytest_timeout_plugin() -> None:
    """Temporal dev deps must include pytest-timeout for per-test hang guards."""
    pyproject = _pyproject_data()
    project = pyproject.get("project")
    assert isinstance(project, dict), "temporal/pyproject.toml must define [project]."
    optional_deps = project.get("optional-dependencies")
    assert isinstance(optional_deps, dict), (
        "temporal/pyproject.toml must define [project.optional-dependencies]."
    )
    dev_deps = optional_deps.get("dev")
    assert isinstance(dev_deps, list), (
        "temporal/pyproject.toml must define a dev dependency list under "
        "[project.optional-dependencies]."
    )
    assert any(re.match(r"^pytest-timeout(?:[<>=!~].*)?$", dep) for dep in dev_deps), (
        "temporal/pyproject.toml must include pytest-timeout in dev dependencies "
        "so CI/local pytest runs can fail an individual wedged test."
    )


def test_temporal_pyproject_sets_default_test_timeout() -> None:
    """Per-test timeout must be configured to bound hangs in pytest runs."""
    pyproject = _pyproject_data()
    tool_config = pyproject.get("tool")
    assert isinstance(tool_config, dict), "temporal/pyproject.toml must define [tool]."
    pytest_config = tool_config.get("pytest")
    assert isinstance(pytest_config, dict), "temporal/pyproject.toml must define [tool.pytest]."
    ini_options = pytest_config.get("ini_options")
    assert isinstance(ini_options, dict), (
        "temporal/pyproject.toml must define [tool.pytest.ini_options]."
    )
    assert ini_options.get("timeout") == 600, (
        "temporal/pyproject.toml must set [tool.pytest.ini_options].timeout = 600 "
        "to cap individual Temporal tests at 10 minutes."
    )
    assert ini_options.get("timeout_method") == "thread", (
        "temporal/pyproject.toml must set [tool.pytest.ini_options].timeout_method = "
        '"thread" so timed-out tests fail closed even when signal delivery is blocked.'
    )


# ---------------------------------------------------------------------------
# Path-scoping: the "Scope reset/smoke validations to DB-surface changes" step
# ---------------------------------------------------------------------------

def test_pr_validation_scope_step_is_present() -> None:
    """The scoping step must exist so that SKIP_SUPABASE_RESET_VALIDATION is set."""
    assert "Scope reset/smoke validations to DB-surface changes" in _workflow_text()


def test_pr_validation_scope_step_has_id_scope() -> None:
    """The step must publish its output under the id 'scope' so downstream env
    references (${{ steps.scope.outputs.skip_reset }}) resolve correctly."""
    text = _workflow_text()
    # Both declarations must be adjacent in the same step block.
    assert "id: scope" in text


def test_pr_validation_scope_step_skips_non_db_prs() -> None:
    """When a PR touches neither supabase/ nor temporal/tests/ nor
    .github/workflows/pr-validation.yml, skip_reset=1 must be written to
    GITHUB_OUTPUT so the heavy validations are deselected.

    Note: temporal/src/ changes are NOT DB-surface and will also set skip_reset=1.
    """
    assert 'echo "skip_reset=1" >> "$GITHUB_OUTPUT"' in _workflow_text()


def test_pr_validation_scope_step_runs_for_supabase_or_temporal_changes() -> None:
    """When a PR touches supabase/ or temporal/tests/, skip_reset=0 must be set so the
    full validation suite runs."""
    assert 'echo "skip_reset=0" >> "$GITHUB_OUTPUT"' in _workflow_text()


def test_pr_validation_scope_step_always_runs_on_push_to_main() -> None:
    """Non-PR runs (push to main) must unconditionally set skip_reset=0 so trunk
    coverage is never gated by the path filter."""
    text = _workflow_text()
    # The else branch (non-PR / push-to-main) must be present and set skip_reset=0.
    assert "push to main" in text or "trunk" in text
    # The unconditional skip_reset=0 appears in the else branch of the step.
    assert 'echo "skip_reset=0" >> "$GITHUB_OUTPUT"' in text


def test_pr_validation_scope_step_checks_supabase_and_temporal_paths() -> None:
    """The path filter must cover supabase/, temporal/tests/, and temporal/pyproject.toml
    so changes to any of those surfaces trigger the full reset coverage.

    Note: temporal/src/ is intentionally excluded — source code changes do not
    affect the Supabase migration stack (ADR-0076 / issue #1883).
    temporal/pyproject.toml is included because it controls the Python environment
    installed for this job and must not silently skip the reset suite when changed.
    """
    text = _workflow_text()
    assert "supabase/" in text
    assert "temporal/tests/" in text
    assert "temporal/pyproject.toml" in text


def test_pr_validation_skip_env_var_wired_from_scope_step() -> None:
    """SKIP_SUPABASE_RESET_VALIDATION must be driven by the scope step's output, not
    hard-coded.  Removing or renaming the step would break this wiring."""
    assert "SKIP_SUPABASE_RESET_VALIDATION: ${{ steps.scope.outputs.skip_reset }}" in _workflow_text()
    assert "SKIP_TEMPORAL_SUITE: ${{ steps.scope.outputs.skip_temporal_suite }}" in _workflow_text()


# ---------------------------------------------------------------------------
# Behavioral path-filter tests: extract the grep regex and run it in Python
# so tests fail if the pattern is removed, narrowed, or broken
# ---------------------------------------------------------------------------

def test_scope_filter_matches_supabase_paths() -> None:
    """A PR that touches supabase/ must be identified as DB-surface (skip_reset=0)."""
    pattern = _extract_db_surface_grep_pattern()
    assert re.match(pattern, "supabase/migrations/20260101000000_add_table.sql"), (
        "supabase/ path must match the DB-surface filter so reset validations run"
    )


def test_scope_filter_matches_temporal_paths() -> None:
    """Changes to temporal/tests/ must be identified as DB-surface (skip_reset=0)
    because those files contain the reset/smoke validation tests themselves.
    Changes to temporal/pyproject.toml must also trigger the full suite because
    that file controls the Python environment installed for this job — altering
    it can change how the reset/smoke suite executes (regression guard: issue #1883).

    Changes to temporal/src/ (Python workflows, activities, tools) must NOT
    trigger the reset suite — they affect application logic but not the Supabase
    migration stack, and including them was the cause of the ~50 min required-check
    runtime observed in incident runs 27591470076 and 27591305734 (issue #1883).
    """
    pattern = _extract_db_surface_grep_pattern()
    # Changes to the reset-test files themselves must trigger the full suite.
    assert re.match(pattern, "temporal/tests/test_rental_master_data_foundation.py"), (
        "temporal/tests/ path must match the DB-surface filter so reset-test "
        "changes are validated when those files are modified."
    )
    assert re.match(pattern, "temporal/tests/test_seed_demo_users.py"), (
        "temporal/tests/ path must match the DB-surface filter so smoke-test "
        "changes are validated when those files are modified."
    )
    # temporal/pyproject.toml controls pip install -e ".[dev]" — a change there
    # can alter how the reset suite runs, so it must not be given the fast path.
    assert re.match(pattern, "temporal/pyproject.toml"), (
        "temporal/pyproject.toml must match the DB-surface filter. It defines the "
        "Python environment installed for this job; a change that silently skips "
        "the reset suite could push breakage to post-merge main. "
        "(Regression guard: issue #1883.)"
    )
    # Pure temporal source code must NOT trigger the ~45+ min reset suite.
    assert not re.match(pattern, "temporal/src/workflows.py"), (
        "temporal/src/workflows.py is a pure application-code path and must not "
        "trigger the DB-surface reset suite. Only supabase/, temporal/tests/, and "
        "temporal/pyproject.toml changes exercise the migration stack. "
        "(Regression guard: issue #1883.)"
    )
    assert not re.match(pattern, "temporal/src/activities/rental.py"), (
        "temporal/src/ paths must not trigger the DB-surface reset suite. "
        "(Regression guard: issue #1883.)"
    )


def test_scope_filter_matches_pr_validation_workflow_itself() -> None:
    """A PR that edits .github/workflows/pr-validation.yml must trigger the full
    reset/smoke suite — the file that governs this check must be in the filter."""
    pattern = _extract_db_surface_grep_pattern()
    assert re.match(pattern, ".github/workflows/pr-validation.yml"), (
        ".github/workflows/pr-validation.yml must be in the DB-surface path filter. "
        "Without it a PR editing this control-plane file can skip the very validations "
        "it is changing."
    )


def test_temporal_scope_filter_only_matches_temporal_or_pr_validation_paths() -> None:
    """Temporal suite should run only for temporal/ or pr-validation workflow edits."""
    pattern = _extract_temporal_surface_grep_pattern()
    assert re.match(pattern, "temporal/src/workflows.py")
    assert re.match(pattern, "temporal/tests/test_rental_workflow.py")
    assert re.match(pattern, ".github/workflows/pr-validation.yml")
    assert not re.match(pattern, "supabase/migrations/20260101000000_add_table.sql")
    assert not re.match(pattern, "frontend/src/App.tsx")


def test_scope_filter_rejects_frontend_paths() -> None:
    """Frontend-only paths must NOT match the filter so non-DB PRs skip heavy
    validations and clear the required check quickly."""
    pattern = _extract_db_surface_grep_pattern()
    for path in [
        "frontend/src/App.tsx",
        "frontend/src/components/Button.tsx",
    ]:
        assert not re.match(pattern, path), (
            f"{path!r} is a frontend path and must not trigger DB-surface validation"
        )


def test_scope_filter_rejects_docs_paths() -> None:
    """Documentation-only paths must NOT match the filter."""
    pattern = _extract_db_surface_grep_pattern()
    for path in ["docs/README.md", "docs/adrs/0063-example.md"]:
        assert not re.match(pattern, path), (
            f"{path!r} is a docs path and must not trigger DB-surface validation"
        )


def test_scope_step_can_skip_temporal_suite_for_non_temporal_prs() -> None:
    """Non-temporal PRs should be able to short-circuit the Temporal suite."""
    text = _workflow_text()
    assert re.search(r'echo\s+"skip_temporal_suite=1"\s*>>\s*"\$GITHUB_OUTPUT"', text)
    assert "Temporal suite: SKIPPED" in text
    assert "DB surfaces only" in text


def test_scope_outputs_skip_temporal_for_db_only_prs() -> None:
    """Supabase-only changes should skip Temporal suite but keep DB reset coverage."""
    assert _simulate_scope_outputs(["supabase/migrations/20260101000000_add_table.sql"]) == (0, 1)


def test_scope_outputs_run_temporal_for_temporal_changes() -> None:
    """Temporal changes should run Temporal suite; reset path depends on DB-surface."""
    assert _simulate_scope_outputs(["temporal/src/workflows.py"]) == (1, 0)
    assert _simulate_scope_outputs(["temporal/tests/test_rental_workflow.py"]) == (0, 0)


def test_scope_outputs_for_empty_and_non_temporal_non_db_prs() -> None:
    """Empty and non-Temporal non-DB PRs should short-circuit Temporal suite."""
    assert _simulate_scope_outputs([]) == (0, 1)
    assert _simulate_scope_outputs(["frontend/src/App.tsx"]) == (1, 1)


# ---------------------------------------------------------------------------
# Fail-closed behavior: indeterminate diff must never default to skip
# ---------------------------------------------------------------------------

def test_scope_step_does_not_suppress_diff_errors() -> None:
    """The git diff command must NOT use '|| true' or similar error suppression.
    If the diff fails, the step must hard-fail so the job doesn't silently skip
    coverage for a DB-touching PR (fail-closed, not fail-open)."""
    text = _workflow_text()
    assert "git diff --name-only" in text, (
        "git diff --name-only must be present in the scope step"
    )
    for line in text.splitlines():
        if "git diff --name-only" in line and "|| true" in line:
            raise AssertionError(
                "git diff --name-only must not use '|| true'. "
                "If the diff fails, the step should hard-fail rather than "
                "silently defaulting to skip_reset=1 (fail-open)."
            )


def test_scope_step_fails_closed_on_empty_diff() -> None:
    """When the diff succeeds but returns no files (empty changeset), the step must
    default to skip_reset=0 (fail closed), not skip_reset=1."""
    text = _workflow_text()
    assert '[ -z "$changed" ]' in text, (
        "The scope step must guard against an empty diff and default to "
        "skip_reset=0 when no changed files are returned."
    )
    lines = text.splitlines()
    in_empty_diff_block = False
    for i, line in enumerate(lines):
        if '[ -z "$changed" ]' in line:
            in_empty_diff_block = True
        if in_empty_diff_block:
            if 'skip_reset=1' in line:
                raise AssertionError(
                    f"Line {i+1}: empty-diff branch must emit skip_reset=0 "
                    f"(fail closed), not skip_reset=1. Got: {line.strip()!r}"
                )
            if 'skip_reset=0' in line:
                break


def test_scope_step_uses_merge_base_diff() -> None:
    """The changed-file diff must use three-dot (merge-base) syntax so only commits
    introduced by the PR itself are evaluated.

    Two-tree diff ('$base' '$head') lists ALL differences between the base tip and
    the PR head, including unrelated commits already on main.  If main recently
    merged a supabase/ change, every subsequent PR — even a pure frontend change —
    would see that file in the diff and be forced to run the full heavy reset suite,
    defeating the path-scoping entirely.

    Three-dot syntax ('$base...$head') diffs from the merge-base, so only the files
    the PR branch itself changed are evaluated.
    """
    text = _workflow_text()
    # Three-dot syntax must be present.
    assert 'git diff --name-only "$base...$head"' in text, (
        "The scope step must use 'git diff --name-only \"$base...$head\"' "
        "(three-dot merge-base diff) so only the PR's own changes are checked. "
        "Two-tree diff ('$base' '$head') includes unrelated commits on main and "
        "would force skip_reset=0 for frontend PRs whenever main has recent "
        "supabase/ or temporal/ changes."
    )
    # Two-tree syntax must NOT be present on the same line as git diff --name-only
    # (catches accidental revert to two-argument form).
    for line in text.splitlines():
        if "git diff --name-only" in line:
            assert "..." in line, (
                f"git diff --name-only must use three-dot (merge-base) syntax. "
                f"Got: {line.strip()!r}"
            )


# ---------------------------------------------------------------------------
# Supabase reset-path jobs: timeout-minutes: 20 regression guard
# ---------------------------------------------------------------------------

_SUPABASE_RESET_TIMEOUT_MINUTES = 20

# Jobs that are known NOT to be reset-path jobs (no supabase db reset, no
# supabase/setup-cli@v2).  Listing them here lets the scoping test detect
# if one of them accidentally acquires setup-cli@v2 in the future, which
# would mean it should also carry the timeout guard.
_NON_RESET_PATH_SUPABASE_JOBS = [
    "supabase-seed",
    "supabase-rpc-guards",
    "supabase-seed-demo-users",
    "supabase-storefront-availability",
    "supabase-crm-customer-profile",
]


def _extract_job_blocks() -> dict[str, str]:
    """Return {job_id: raw_block_text} for every top-level job in the workflow.

    Jobs in GitHub Actions YAML are 2-space-indented keys immediately under
    ``jobs:``.  This function splits the file on those boundaries so each job's
    properties can be inspected independently.
    """
    lines = _workflow_text().splitlines()

    # Locate the "jobs:" section.
    jobs_section_index: int | None = None
    for i, line in enumerate(lines):
        if line.strip() == "jobs:":
            jobs_section_index = i
            break
    if jobs_section_index is None:
        return {}

    blocks: dict[str, list[str]] = {}
    current_id: str | None = None

    for line in lines[jobs_section_index + 1 :]:
        # A job-ID line is exactly "  <id>:" (2-space indent, no deeper nesting).
        job_match = re.match(r"^  ([a-zA-Z0-9_-]+):\s*$", line)
        if job_match:
            current_id = job_match.group(1)
            blocks[current_id] = [line]
        elif current_id is not None:
            blocks[current_id].append(line)

    return {job_id: "\n".join(block_lines) for job_id, block_lines in blocks.items()}


def _extract_job_ids() -> list[str]:
    """Return top-level job IDs from the workflow in file order.

    GitHub Actions job IDs live directly under ``jobs:`` and, in this repository's
    workflow style, are written with a 2-space indent.  Scanning only that section
    lets this test catch duplicate raw keys before later dict-building code would
    overwrite the earlier occurrence.
    """
    lines = _workflow_text().splitlines()
    in_jobs = False
    job_ids: list[str] = []

    for line in lines:
        if not in_jobs:
            if line.strip() == "jobs:":
                in_jobs = True
            continue

        if line and not line.startswith(" "):
            break

        # Top-level job IDs in this workflow are written directly under "jobs:"
        # with a 2-space indent; deeper-nested step keys have greater indentation.
        job_match = re.match(r"^  ([a-zA-Z0-9_-]+):\s*$", line)
        if job_match:
            job_ids.append(job_match.group(1))

    return job_ids


def test_pr_validation_job_ids_are_unique() -> None:
    """Top-level job IDs must be unique so the workflow remains parseable."""
    duplicates = sorted(
        job_id for job_id, count in Counter(_extract_job_ids()).items() if count > 1
    )
    assert not duplicates, (
        "Workflow job IDs must be unique; duplicate keys make GitHub reject "
        f"pr-validation.yml before any jobs start. Duplicates: {duplicates}"
    )


def test_supabase_reset_path_jobs_have_timeout_20() -> None:
    """Every Supabase reset-path job (identified by ``uses: supabase/setup-cli@v2``)
    must declare ``timeout-minutes: 20`` so a hung CLI install or ``supabase db reset``
    cannot block the required PR check indefinitely.

    Regression guard for PR #1828 / issue #1841: the timeout was added to all
    existing reset-path jobs by that PR.  This test fails fast whenever a future
    reset-path job is added without the same guard.

    The expected timeout is :data:`_SUPABASE_RESET_TIMEOUT_MINUTES` (20).  A value
    larger than 20 is also flagged because it would effectively remove the bound.
    """
    job_blocks = _extract_job_blocks()

    # Identify reset-path jobs: dedicated supabase-* jobs that install the
    # Supabase CLI.  The temporal job also installs setup-cli@v2 but carries
    # a different (higher) timeout that is enforced by
    # test_pr_validation_temporal_job_has_bounded_timeout.
    reset_jobs = {
        job_id: block
        for job_id, block in job_blocks.items()
        if job_id.startswith("supabase-") and "uses: supabase/setup-cli@v2" in block
    }

    assert reset_jobs, (
        "No Supabase reset-path jobs (using 'supabase/setup-cli@v2') were found in "
        "pr-validation.yml.  If all reset-path jobs were removed or renamed, update "
        "this test accordingly."
    )

    missing_timeout: list[str] = []
    wrong_timeout: list[tuple[str, int]] = []

    for job_id, block in reset_jobs.items():
        timeout_match = re.search(r"timeout-minutes:\s*(\d+)", block)
        if timeout_match is None:
            missing_timeout.append(job_id)
        elif int(timeout_match.group(1)) != _SUPABASE_RESET_TIMEOUT_MINUTES:
            wrong_timeout.append((job_id, int(timeout_match.group(1))))

    assert not missing_timeout, (
        f"Supabase reset-path job(s) are missing 'timeout-minutes': "
        f"{missing_timeout}.  Add 'timeout-minutes: {_SUPABASE_RESET_TIMEOUT_MINUTES}' "
        f"to each job so a hung CLI install or db reset cannot block the required "
        f"check indefinitely (regression guard for PR #1828 / issue #1841)."
    )
    assert not wrong_timeout, (
        f"Supabase reset-path job(s) have an unexpected 'timeout-minutes' value: "
        f"{wrong_timeout}.  Each reset-path job must declare "
        f"'timeout-minutes: {_SUPABASE_RESET_TIMEOUT_MINUTES}' "
        f"(regression guard for PR #1828 / issue #1841)."
    )


def test_supabase_reset_retries_port_bind_conflicts() -> None:
    """Supabase reset retry must classify host-port bind collisions as transient.

    Regression guard for PR #2381 follow-up: CI job
    ``Supabase route exception thread + review bundle reset-path validation`` failed
    when ``supabase db reset`` could not bind the Inbucket port (address already in
    use). This must be retried with a fresh stop/start cycle, not fail immediately.
    """
    text = _reset_validation_lib_text()
    match = re.search(
        r"""run_supabase_reset_with_transient_retry\(\).*?local transient_re=(["'])(.*?)\1""",
        text,
        re.DOTALL,
    )
    assert match is not None, (
        "Could not locate run_supabase_reset_with_transient_retry transient regex in "
        "supabase/tests/reset_validation_lib.sh."
    )
    transient_re = match.group(2)
    for pattern in (
        "failed to start docker container",
        "failed to set up container networking",
        "driver failed programming external connectivity",
        "failed to bind host port",
        "address already in use",
    ):
        assert pattern in transient_re, (
            "run_supabase_reset_with_transient_retry must treat host-port bind "
            f"collisions as transient ('{pattern}') so reset-path CI retries "
            "one-off Docker port conflicts."
        )


def test_supabase_reset_path_timeout_scoped_not_all_supabase_jobs() -> None:
    """The timeout assertion must cover only reset-path jobs (those using
    ``supabase/setup-cli@v2``), not lighter-weight Supabase smoke/contract jobs.

    Scoping guard: the jobs listed in :data:`_NON_RESET_PATH_SUPABASE_JOBS` do not
    run ``supabase db reset`` and must not use ``supabase/setup-cli@v2``.  If one of
    them acquires that step in the future it should also gain ``timeout-minutes: 20``,
    and this test will flag the missing pairing so it is not overlooked.
    """
    job_blocks = _extract_job_blocks()

    for job_id in _NON_RESET_PATH_SUPABASE_JOBS:
        if job_id not in job_blocks:
            continue  # job was renamed or removed — no assertion to make
        block = job_blocks[job_id]
        assert "uses: supabase/setup-cli@v2" not in block, (
            f"Job {job_id!r} is listed as a non-reset-path job but now uses "
            f"'supabase/setup-cli@v2'.  If it now performs a supabase db reset it "
            f"must also carry 'timeout-minutes: {_SUPABASE_RESET_TIMEOUT_MINUTES}', "
            f"and it should be removed from _NON_RESET_PATH_SUPABASE_JOBS in this "
            f"test file."
        )


def test_scope_filter_matches_portal_schedule_paths() -> None:
    """Paths introduced by the portal-schedule migration PR (#1596) must be
    identified as DB-surface changes so the full reset/smoke suite runs.

    Regression guard for factory-stuck-pr-1596 / issue #1630: PR #1596 touched
    both supabase/ and temporal/ paths; the path filter must flag them as
    DB-surface so the heavy reset/smoke validations are not skipped.
    """
    pattern = _extract_db_surface_grep_pattern()
    db_surface_paths = [
        "supabase/migrations/20260614174000_portal_schedule_search_path_extensions.sql",
        "supabase/migrations/20260614190500_portal_off_rent_digest_search_path.sql",
        "supabase/tests/run_portal_schedule_access_reset.sh",
        "supabase/tests/portal_schedule_access.sql",
        "temporal/tests/test_rental_master_data_foundation.py",
    ]
    for path in db_surface_paths:
        assert re.match(pattern, path), (
            f"{path!r} is a DB-surface path (from PR #1596) and must match the "
            "path filter so the full reset validation suite runs. "
            "Regression guard for factory-stuck-pr-1596 / issue #1630."
        )


def test_validation_summary_lists_portal_schedule_reset_once() -> None:
    """validation-summary must report the portal-schedule reset job exactly once.

    The workflow carries a single ``supabase-portal-schedule-access-reset`` job
    after the duplicate-ID cleanup; leaving two summary rows behind makes the
    required-check report inconsistent with the final job list.
    """
    text = _workflow_text()
    assert text.count("  supabase-portal-schedule-access-reset:\n") == 1, (
        "pr-validation.yml must define exactly one "
        "'supabase-portal-schedule-access-reset' job."
    )
    assert text.count("needs.supabase-portal-schedule-access-reset.result") == 1, (
        "validation-summary must reference "
        "'supabase-portal-schedule-access-reset' exactly once."
    )
