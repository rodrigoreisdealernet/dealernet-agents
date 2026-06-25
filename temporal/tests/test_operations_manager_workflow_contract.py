"""Tests for Operations Manager actor split-runner workflow and deduped auto:ops incident flow.

Covers the behavior introduced by PR #185 and carried forward into the
hourly cadence pipeline (ADR-0025). All assertions are static — they read
workflow YAML and agent prompt text as plain text so they execute in CI
without any live GitHub, Azure, or Kubernetes side effects.

NOTE: Workflow and config files are read as plain text (no PyYAML — it is not
installed in the temporal test env; see test_cluster_guardian_gating.py and
test_pipeline_fast_workflow_contract.py for the same convention).

Section extraction strategy
────────────────────────────
All workflow assertions are scoped to the specific job section
(pipeline_public, pipeline_private, private_lane_preflight, private_lane_degraded)
via _extract_job_section() so that a string appearing in the wrong job cannot
satisfy a test for a different job.

All agent-prompt assertions are scoped to the relevant markdown section
(## Scope …, ## Incident lifecycle …, ## Guardrails, etc.) via
_extract_prompt_section() so that a string appearing in a different instruction
block cannot satisfy a test for the wrong block.

Coverage targets (51 tests total):
  1. pipeline-hourly.yml split-runner placement:
       - pipeline_public (ubuntu-latest) sets OPS_CHECK_SCOPE=public
       - pipeline_private (self-hosted) sets OPS_CHECK_SCOPE=private
       - The two lanes are mutually exclusive and use distinct runners
       - pipeline_private is gated on private_lane_preflight.outputs.private_ready
  2. Private-lane preflight gate:
       - Detects active_runner_profile == github-hosted-mvp and blocks private lane
       - Accumulates all missing requirements into a single output (no short-circuit)
       - pipeline_private is gated on private_ready == 'true'
       - private_lane_degraded fires when private_ready != 'true'
  3. Degraded-mode output (GitHub-hosted MVP path):
       - private_lane_degraded emits an explicit degraded status summary
       - Uses ::error:: annotation so the run is visibly red (not silently skipped)
       - References missing prerequisites and names skipped checks in the summary
  4. Deduped auto:ops incident lifecycle in the agent prompt:
       - Stable fingerprint required before create/update
       - Search open auto:ops issues before creating a new issue
       - Max 3 create/update operations per run
       - One open issue per fingerprinted problem
       - Issues always carry auto:ops and queue:ops labels
  5. Factory config scope:
       - ops: block present with dia- namespace prefix and nonprod AKS target
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

HOURLY_PIPELINE = REPO_ROOT / ".github" / "workflows" / "pipeline-hourly.yml"
OPS_MANAGER_PROMPT = REPO_ROOT / ".github" / "agents" / "operations-manager.agent.md"
FACTORY_CONFIG = REPO_ROOT / ".github" / "factory.yml"


def _workflow_text() -> str:
    return HOURLY_PIPELINE.read_text(encoding="utf-8")


def _prompt_text() -> str:
    return OPS_MANAGER_PROMPT.read_text(encoding="utf-8")


def _factory_text() -> str:
    return FACTORY_CONFIG.read_text(encoding="utf-8")


def _extract_job_section(text: str, job_name: str) -> str:
    """Extract the YAML text block for a specific job from workflow YAML.

    Jobs are declared at two-space indent under ``jobs:``.  A section begins at
    ``  <job_name>:`` and ends at the next two-space-indented job key or the end
    of the string.  This scopes every assertion to the exact job being tested so
    that a string present in a *different* job cannot satisfy the test.
    """
    pattern = rf"(^  {re.escape(job_name)}:.*?)(?=^  [A-Za-z0-9_]|\Z)"
    match = re.search(pattern, text, re.DOTALL | re.MULTILINE)
    if match is None:
        pytest.fail(f"Job section '{job_name}' not found in workflow YAML")
    return match.group(1)


def _extract_prompt_section(text: str, heading_prefix: str) -> str:
    """Extract text from a markdown ``##`` heading until the next ``##`` heading
    or end of file.

    ``heading_prefix`` is matched as a literal prefix so callers can pass the
    canonical heading text (including backtick / parenthesis characters) without
    worrying about regex escaping.  This ensures assertions are anchored to the
    specific instruction block, not to incidental occurrences elsewhere in the
    prompt.
    """
    escaped = re.escape(heading_prefix)
    pattern = rf"({escaped}.*?)(?=^## |\Z)"
    match = re.search(pattern, text, re.DOTALL | re.MULTILINE)
    if match is None:
        pytest.fail(f"Prompt section starting with '{heading_prefix}' not found")
    return match.group(1)


# ──────────────────────────────────────────────────────────────────────────────
# Prerequisites: files exist
# ──────────────────────────────────────────────────────────────────────────────


def test_hourly_pipeline_exists() -> None:
    assert HOURLY_PIPELINE.exists(), (
        "pipeline-hourly.yml must exist; it carries the Operations Manager "
        "split-runner cadence introduced by PR #185 (ADR-0025)."
    )


def test_operations_manager_agent_exists() -> None:
    assert OPS_MANAGER_PROMPT.exists(), (
        "operations-manager.agent.md must exist in .github/agents/."
    )


def test_operations_manager_agent_has_frontmatter() -> None:
    text = _prompt_text()
    assert text.startswith("---"), "agent file must start with YAML frontmatter"
    assert "name: operations-manager" in text
    # Frontmatter requires an opening '---' and a closing '---' on its own line.
    # Check for the closing delimiter appearing as a standalone line after the opening one.
    lines = text.splitlines()
    closing_delimiters = [i for i, line in enumerate(lines) if line.strip() == "---"]
    assert len(closing_delimiters) >= 2, (
        "Agent YAML frontmatter must have both an opening and closing '---' delimiter."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 1. Split-runner placement — public lane
# ──────────────────────────────────────────────────────────────────────────────


def test_ops_manager_public_lane_runs_on_ubuntu_latest() -> None:
    section = _extract_job_section(_workflow_text(), "pipeline_public")
    # The pipeline_public job must declare runs-on: ubuntu-latest, not self-hosted.
    assert re.search(r"^\s+runs-on:\s*ubuntu-latest\s*$", section, re.MULTILINE), (
        "pipeline_public job must declare 'runs-on: ubuntu-latest'."
    )


def test_ops_manager_public_lane_sets_check_scope_public() -> None:
    section = _extract_job_section(_workflow_text(), "pipeline_public")
    # The operations-manager step inside pipeline_public must set OPS_CHECK_SCOPE: public.
    assert "OPS_CHECK_SCOPE: public" in section, (
        "pipeline_public job must set OPS_CHECK_SCOPE: public for the operations-manager step."
    )


def test_ops_manager_public_lane_invokes_operations_manager_agent() -> None:
    section = _extract_job_section(_workflow_text(), "pipeline_public")
    assert "--agent operations-manager" in section, (
        "pipeline_public job must invoke the operations-manager agent via --agent operations-manager."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 2. Split-runner placement — private lane
# ──────────────────────────────────────────────────────────────────────────────


def test_ops_manager_private_lane_exists() -> None:
    text = _workflow_text()
    assert "pipeline_private:" in text, (
        "A dedicated private-lane job (pipeline_private) must exist in the hourly "
        "pipeline so private-env checks can run on a self-hosted runner."
    )


def test_ops_manager_private_lane_runs_on_self_hosted_runner() -> None:
    section = _extract_job_section(_workflow_text(), "pipeline_private")
    # pipeline_private must use a self-hosted runner — extract the runs-on value
    # and assert it contains 'self-hosted' and a factory runner label.
    runs_on_match = re.search(r"^\s+runs-on:\s*(.+)", section, re.MULTILINE)
    assert runs_on_match is not None, "pipeline_private must declare a runs-on key"
    runs_on_value = runs_on_match.group(1)
    assert "self-hosted" in runs_on_value, (
        "pipeline_private runs-on must include 'self-hosted', not 'ubuntu-latest'."
    )
    assert "factory-cluster-guardian" in runs_on_value or "factory-deploy-nonprod" in runs_on_value, (
        "pipeline_private runs-on must include a factory runner label."
    )


def test_ops_manager_private_lane_sets_check_scope_private() -> None:
    section = _extract_job_section(_workflow_text(), "pipeline_private")
    # The operations-manager step inside pipeline_private must set OPS_CHECK_SCOPE: private.
    assert "OPS_CHECK_SCOPE: private" in section, (
        "pipeline_private job must set OPS_CHECK_SCOPE: private for the operations-manager step."
    )


def test_public_and_private_lanes_are_distinct_runner_targets() -> None:
    text = _workflow_text()
    public_section = _extract_job_section(text, "pipeline_public")
    private_section = _extract_job_section(text, "pipeline_private")
    # OPS_CHECK_SCOPE=public must be inside pipeline_public, not pipeline_private.
    assert "OPS_CHECK_SCOPE: public" in public_section, (
        "OPS_CHECK_SCOPE: public must appear inside the pipeline_public job section."
    )
    assert "OPS_CHECK_SCOPE: private" not in public_section, (
        "pipeline_public must not set OPS_CHECK_SCOPE: private."
    )
    # OPS_CHECK_SCOPE=private must be inside pipeline_private, not pipeline_public.
    assert "OPS_CHECK_SCOPE: private" in private_section, (
        "OPS_CHECK_SCOPE: private must appear inside the pipeline_private job section."
    )
    assert "OPS_CHECK_SCOPE: public" not in private_section, (
        "pipeline_private must not set OPS_CHECK_SCOPE: public."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 3. Private-lane preflight gate
# ──────────────────────────────────────────────────────────────────────────────


def test_private_lane_preflight_job_exists() -> None:
    text = _workflow_text()
    assert "private_lane_preflight:" in text, (
        "A private_lane_preflight job must exist to detect whether the private-lane "
        "prerequisites are satisfied before running self-hosted checks."
    )


def test_preflight_checks_active_runner_profile_not_github_hosted_mvp() -> None:
    section = _extract_job_section(_workflow_text(), "private_lane_preflight")
    # The preflight script must reject the github-hosted-mvp profile.
    assert "active_runner_profile" in section, (
        "private_lane_preflight must read and check active_runner_profile."
    )
    assert "github-hosted-mvp" in section, (
        "private_lane_preflight must reject the 'github-hosted-mvp' profile."
    )


def test_preflight_emits_private_ready_output() -> None:
    section = _extract_job_section(_workflow_text(), "private_lane_preflight")
    # The preflight must write private_ready to GITHUB_OUTPUT.
    assert "private_ready" in section, (
        "private_lane_preflight must set a private_ready output."
    )
    assert "GITHUB_OUTPUT" in section, (
        "private_lane_preflight must write private_ready to GITHUB_OUTPUT."
    )


def test_preflight_accumulates_missing_requirements() -> None:
    section = _extract_job_section(_workflow_text(), "private_lane_preflight")
    # The preflight must use an array accumulator (missing=() ... missing+=(...))
    # so all failures are collected before the final gate decision, not short-circuited.
    assert re.search(r"missing\s*=\s*\(\)", section), (
        "private_lane_preflight must initialise an empty missing=() accumulator array."
    )
    assert re.search(r"missing\+=", section), (
        "private_lane_preflight must append to the missing array via missing+=(...)."
    )
    assert "missing_requirements" in section, (
        "private_lane_preflight must expose missing_requirements as an output."
    )


def test_private_lane_job_gated_on_private_ready_true() -> None:
    section = _extract_job_section(_workflow_text(), "pipeline_private")
    # The if: key inside pipeline_private must gate on private_ready == 'true'.
    assert re.search(r"^\s+if:.*private_ready == 'true'", section, re.MULTILINE), (
        "pipeline_private must have 'if: ... private_ready == 'true'' "
        "gating on the preflight output."
    )


def test_private_lane_degraded_job_fires_when_not_ready() -> None:
    text = _workflow_text()
    assert "private_lane_degraded:" in text, (
        "A private_lane_degraded job must exist to provide an explicit degraded "
        "status when private prerequisites are missing."
    )
    section = _extract_job_section(text, "private_lane_degraded")
    # The if: key inside private_lane_degraded must use the negated condition.
    assert re.search(r"^\s+if:.*private_ready != 'true'", section, re.MULTILINE), (
        "private_lane_degraded must fire when private_ready != 'true'."
    )


def test_private_lane_degraded_job_depends_on_preflight() -> None:
    section = _extract_job_section(_workflow_text(), "private_lane_degraded")
    # The degraded job must declare a 'needs:' dependency on the preflight job.
    assert re.search(r"^\s+needs:", section, re.MULTILINE), (
        "private_lane_degraded must declare a 'needs:' dependency."
    )
    assert "private_lane_preflight" in section, (
        "private_lane_degraded must depend on private_lane_preflight."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 4. Degraded-mode output (GitHub-hosted MVP path)
# ──────────────────────────────────────────────────────────────────────────────


def test_degraded_job_emits_github_step_summary() -> None:
    section = _extract_job_section(_workflow_text(), "private_lane_degraded")
    # Degraded state must write to GITHUB_STEP_SUMMARY so it is visible in the
    # Actions UI without having to inspect raw logs.
    assert "GITHUB_STEP_SUMMARY" in section, (
        "private_lane_degraded must write its status to GITHUB_STEP_SUMMARY."
    )


def test_degraded_job_emits_error_annotation() -> None:
    section = _extract_job_section(_workflow_text(), "private_lane_degraded")
    # The degraded job must emit an ::error:: annotation so the workflow run is
    # clearly red (not silently skipped) when private prerequisites are missing.
    assert "::error::" in section, (
        "private_lane_degraded must emit an ::error:: annotation; silent skips "
        "hide the missing-prerequisite condition from the repository health view."
    )


def test_degraded_job_references_missing_prerequisites_in_output() -> None:
    section = _extract_job_section(_workflow_text(), "private_lane_degraded")
    # The degraded summary must interpolate the concrete list of missing requirements.
    assert "MISSING_REQUIREMENTS" in section or "missing_requirements" in section, (
        "private_lane_degraded must reference missing prerequisites in its step output."
    )


def test_degraded_job_names_affected_checks() -> None:
    section = _extract_job_section(_workflow_text(), "private_lane_degraded")
    # The degraded summary must explicitly name which checks were skipped so the
    # operator knows what was deferred, not just that "something" was skipped.
    assert "operations-manager" in section, (
        "private_lane_degraded must name 'operations-manager' as an affected check."
    )
    assert "cluster-guardian" in section, (
        "private_lane_degraded must name 'cluster-guardian' as an affected check."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 5. Pipeline structure: jobs ordering and common hygiene
# ──────────────────────────────────────────────────────────────────────────────


def test_hourly_pipeline_has_schedule_and_workflow_dispatch_triggers() -> None:
    text = _workflow_text()
    assert "schedule:" in text
    assert "workflow_dispatch:" in text


def test_hourly_pipeline_has_single_concurrency_group_no_cancel() -> None:
    text = _workflow_text()
    assert re.search(r"^\s*group:\s*pipeline-hourly\s*$", text, re.MULTILINE), (
        "Concurrency group must be the fixed string 'pipeline-hourly'."
    )
    assert "cancel-in-progress: false" in text


def test_hourly_pipeline_has_per_job_timeout() -> None:
    # Each ops job must declare a timeout so a hung agent stage cannot block the run.
    public_section = _extract_job_section(_workflow_text(), "pipeline_public")
    private_section = _extract_job_section(_workflow_text(), "pipeline_private")
    assert "timeout-minutes:" in public_section, (
        "pipeline_public must declare timeout-minutes."
    )
    assert "timeout-minutes:" in private_section, (
        "pipeline_private must declare timeout-minutes."
    )


def test_ops_manager_stage_uses_continue_on_error() -> None:
    # Both the public and private ops-manager agent steps must use continue-on-error: true
    # so a failing/hung agent step does not cancel the remaining pipeline stages.
    public_section = _extract_job_section(_workflow_text(), "pipeline_public")
    private_section = _extract_job_section(_workflow_text(), "pipeline_private")
    assert "continue-on-error: true" in public_section, (
        "pipeline_public ops-manager step must declare 'continue-on-error: true'."
    )
    assert "continue-on-error: true" in private_section, (
        "pipeline_private ops-manager step must declare 'continue-on-error: true'."
    )


def test_ops_manager_stage_writes_step_summary_row() -> None:
    # The summarise step in pipeline_public must reference operations-manager and
    # append a row to GITHUB_STEP_SUMMARY.
    public_section = _extract_job_section(_workflow_text(), "pipeline_public")
    assert "operations-manager" in public_section, (
        "pipeline_public must reference 'operations-manager' in its step summary label."
    )
    assert "GITHUB_STEP_SUMMARY" in public_section, (
        "pipeline_public must write to GITHUB_STEP_SUMMARY."
    )


def test_pipeline_private_depends_on_preflight() -> None:
    section = _extract_job_section(_workflow_text(), "pipeline_private")
    needs_match = re.search(r"^\s+needs:\s*(.+)", section, re.MULTILINE)
    assert needs_match is not None, "pipeline_private job must declare a 'needs:' key"
    needs_value = needs_match.group(1)
    assert "private_lane_preflight" in needs_value, (
        "pipeline_private must depend on private_lane_preflight."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 6. Agent prompt: OPS_CHECK_SCOPE controls
# ──────────────────────────────────────────────────────────────────────────────


def test_agent_prompt_defines_ops_check_scope_variable() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Scope and environment source of truth")
    assert "OPS_CHECK_SCOPE" in section, (
        "The 'Scope and environment source of truth' section must document OPS_CHECK_SCOPE."
    )


def test_agent_prompt_defines_public_scope_behavior() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Scope and environment source of truth")
    # The scope section must define what checks run for the 'public' value.
    assert re.search(r"`public`", section), (
        "The scope section must explicitly define the 'public' OPS_CHECK_SCOPE behavior "
        "using backtick-quoted `public`."
    )


def test_agent_prompt_defines_private_scope_behavior() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Scope and environment source of truth")
    # The scope section must define what checks run for the 'private' value.
    assert re.search(r"`private`", section), (
        "The scope section must explicitly define the 'private' OPS_CHECK_SCOPE behavior "
        "using backtick-quoted `private`."
    )


def test_agent_prompt_no_duplicate_public_checks_in_private_scope() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Degraded-mode requirements")
    # The degraded-mode section must explicitly tell the agent not to repeat public checks.
    assert "do not perform duplicate public-only checks" in section, (
        "The Degraded-mode requirements section must contain the phrase "
        "'do not perform duplicate public-only checks'."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 7. Deduped auto:ops incident lifecycle
# ──────────────────────────────────────────────────────────────────────────────


def test_agent_prompt_uses_fingerprinted_incidents() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Incident lifecycle")
    # The incident lifecycle section must introduce the fingerprint concept.
    assert "fingerprint" in section, (
        "The 'Incident lifecycle' section must use incident fingerprints for deduplication."
    )


def test_agent_prompt_includes_fingerprint_comment_format() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Incident lifecycle")
    # Issue bodies must include a machine-readable fingerprint HTML comment so
    # future runs can identify existing incidents reliably.
    assert "<!-- fingerprint:" in section or "fingerprint:ops-" in section, (
        "The 'Incident lifecycle' section must specify the fingerprint HTML comment format."
    )


def test_agent_prompt_requires_search_before_create() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Incident lifecycle")
    # The incident lifecycle must have a step instructing the agent to search open
    # auto:ops issues for the fingerprint before creating or updating.
    assert re.search(
        r"Search open.*auto:ops.*issues.*fingerprint.*before",
        section,
        re.DOTALL | re.IGNORECASE,
    ), (
        "The 'Incident lifecycle' section must instruct the agent to search open "
        "auto:ops issues for the fingerprint before create/update."
    )


def test_agent_prompt_uses_auto_ops_label() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Incident lifecycle")
    assert "auto:ops" in section, (
        "The 'Incident lifecycle' section must specify the auto:ops label."
    )


def test_agent_prompt_uses_queue_ops_label() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Incident lifecycle")
    assert "queue:ops" in section, (
        "The 'Incident lifecycle' section must specify the queue:ops routing label."
    )


def test_agent_prompt_caps_issue_operations_per_run() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Guardrails")
    # The Guardrails section must state the per-run cap.
    assert "Max 3 issue create/update operations per run" in section, (
        "The 'Guardrails' section must state 'Max 3 issue create/update operations per run'."
    )


def test_agent_prompt_enforces_one_open_issue_per_fingerprint() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Guardrails")
    assert "Never spam: one open `auto:ops` issue per distinct fingerprinted problem" in section, (
        "The 'Guardrails' section must state "
        "'Never spam: one open `auto:ops` issue per distinct fingerprinted problem'."
    )


def test_agent_prompt_updates_existing_issue_when_fingerprint_matches() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Incident lifecycle")
    # The canonical lifecycle step must instruct update-over-create.
    assert "Update existing issue when fingerprint matches" in section, (
        "The 'Incident lifecycle' section must contain "
        "'Update existing issue when fingerprint matches'."
    )


def test_agent_prompt_searches_open_auto_ops_issues() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Discovery commands")
    # The discovery commands section must include a gh issue list invocation that
    # filters by the auto:ops label.
    assert "gh issue list" in section, (
        "The 'Discovery commands' section must include a 'gh issue list' command."
    )
    assert "auto:ops" in section, (
        "The 'Discovery commands' section must reference the auto:ops label."
    )
    # Verify the label filter is present (either --label flag or label value in quotes).
    assert "--label" in section or '"auto:ops"' in section, (
        "The 'Discovery commands' section must filter gh issue list by label."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 8. Agent conservative action guardrails
# ──────────────────────────────────────────────────────────────────────────────


def test_agent_prompt_lists_must_not_actions() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Conservative autonomous actions")
    # The conservative actions section must contain a 'Must NOT do:' sub-heading
    # followed by bullet-point prohibitions.
    assert "Must NOT do:" in section, (
        "The 'Conservative autonomous actions' section must contain 'Must NOT do:'."
    )
    must_not_pos = section.index("Must NOT do:")
    section_after = section[must_not_pos:]
    assert re.search(r"^\s*-\s+\S", section_after, re.MULTILINE), (
        "'Must NOT do:' must be followed by at least one bullet-point prohibited action."
    )


def test_agent_prompt_prohibits_delete_resource_groups_or_databases() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Conservative autonomous actions")
    must_not_pos = section.index("Must NOT do:")
    must_not_text = section[must_not_pos:]
    assert re.search(r"-\s+Delete\b", must_not_text), (
        "The 'Must NOT do' list must explicitly prohibit Delete operations."
    )


def test_agent_prompt_prohibits_scale_down() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Conservative autonomous actions")
    must_not_pos = section.index("Must NOT do:")
    must_not_text = section[must_not_pos:]
    assert re.search(r"-\s+Scale down", must_not_text, re.IGNORECASE), (
        "The 'Must NOT do' list must explicitly prohibit scale-down operations."
    )


def test_agent_prompt_prohibits_rbac_or_nsg_changes() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Conservative autonomous actions")
    must_not_pos = section.index("Must NOT do:")
    must_not_text = section[must_not_pos:]
    assert re.search(r"-\s+Change\b.*\b(RBAC|NSG|firewall)\b", must_not_text, re.IGNORECASE), (
        "The 'Must NOT do' list must prohibit RBAC, NSG, or firewall policy changes."
    )


def test_agent_prompt_prohibits_autonomous_secret_rotation() -> None:
    section = _extract_prompt_section(_prompt_text(), "## Conservative autonomous actions")
    must_not_pos = section.index("Must NOT do:")
    must_not_text = section[must_not_pos:]
    assert re.search(r"-\s+Rotate", must_not_text, re.IGNORECASE), (
        "The 'Must NOT do' list must prohibit autonomous secret/cert rotation."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 9. Factory config: ops block present and dia-* scoped
# ──────────────────────────────────────────────────────────────────────────────


def test_factory_config_ops_block_exists() -> None:
    text = _factory_text()
    assert "ops:" in text, (
        "factory.yml must contain an ops: block with this repo's environment targets."
    )


def test_factory_config_ops_namespace_prefix_is_dia() -> None:
    text = _factory_text()
    # namespace_prefix must be dia- so the agent reads the correct targets.
    assert "namespace_prefix" in text
    match = re.search(r"namespace_prefix:\s*(\S+)", text)
    assert match is not None, "namespace_prefix not found in factory.yml"
    value = match.group(1).strip('"').strip("'")
    assert value.startswith("dia-"), (
        f"namespace_prefix '{value}' must start with 'dia-'; the agent reads this "
        "value to scope its checks."
    )


def test_factory_config_ops_has_aks_cluster_target() -> None:
    text = _factory_text()
    assert "aks_cluster_nonprod" in text, (
        "factory.yml ops block must specify the nonprod AKS cluster name."
    )


def test_factory_config_ops_has_supabase_namespace() -> None:
    text = _factory_text()
    assert "supabase_namespace" in text, (
        "factory.yml ops block must specify the Supabase namespace for backup checks."
    )


def test_factory_config_ops_does_not_reference_selfheal_prod() -> None:
    text = _factory_text()
    # This repo's ops targets must not reference a production cluster.
    # aks_cluster_nonprod must be a staging/nonprod target, not a prod cluster name.
    match = re.search(r"aks_cluster_nonprod:\s*(\S+)", text)
    assert match is not None, "aks_cluster_nonprod not found in factory.yml"
    cluster_value = match.group(1).strip('"').strip("'")
    assert "prod" not in cluster_value.lower(), (
        f"aks_cluster_nonprod value '{cluster_value}' must not reference a production "
        "cluster — the nonprod target must be a staging cluster, not a prod one."
    )


# ──────────────────────────────────────────────────────────────────────────────
# 11. Agent prompt: check order enforces runner health before Azure checks
# ──────────────────────────────────────────────────────────────────────────────


def test_agent_prompt_check_order_runner_before_azure() -> None:
    """Runner health must be listed before Azure/AKS checks in the strict check order.

    This guards the triage flow: a runner problem is the most likely cause of
    false-negative private-lane results, so it must be diagnosed first.
    """
    section = _extract_prompt_section(_prompt_text(), "## Check order (strict)")
    runner_match = re.search(r"(\d+)\.\s+Runner health", section)
    azure_match = re.search(r"(\d+)\.\s+Azure", section)
    assert runner_match is not None, (
        "Check order must include a numbered 'Runner health' step."
    )
    assert azure_match is not None, (
        "Check order must include a numbered 'Azure' step."
    )
    runner_step = int(runner_match.group(1))
    azure_step = int(azure_match.group(1))
    assert runner_step < azure_step, (
        f"Runner health (step {runner_step}) must precede Azure checks "
        f"(step {azure_step}) in the strict check order."
    )
