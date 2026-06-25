"""Tests for Cluster Guardian preflight gating, read-only/remediation isolation,
namespace scoping, and incident-dedupe invariants.

These tests are purely static — they read workflow YAML and agent prompt text as
plain text so they run in CI without any live-cluster access.

NOTE: Workflow and config files are read as plain text (no PyYAML — it is not
installed in the temporal test env; see test_monitor_deploy_workflow_contract.py
for the same convention).

Coverage targets (per issue requirements):
  1. agent-cluster-guardian.yml enforces preflight gate for:
       - kubernetes-app profile enablement
       - wynne-* namespace allowlist
       - dedicated runner label availability
  2. Manual remediation path requirements:
       - workflow_dispatch trigger required
       - cluster-remediation approval environment required
       - cluster-remediator agent identity (not cluster-guardian)
  3. Namespace scoping and incident-dedupe/search constrained to wynne-* / auto:cluster.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

GUARDIAN_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "agent-cluster-guardian.yml"
FACTORY_CONFIG = REPO_ROOT / ".github" / "factory.yml"
GUARDIAN_PROMPT = REPO_ROOT / ".github" / "agents" / "cluster-guardian.agent.md"
REMEDIATOR_PROMPT = REPO_ROOT / ".github" / "agents" / "cluster-remediator.agent.md"


def _workflow_text() -> str:
    return GUARDIAN_WORKFLOW.read_text()


def _factory_text() -> str:
    return FACTORY_CONFIG.read_text()


# ──────────────────────────────────────────────────────────────────────────────
# 1. Preflight gate: profile enablement
# ──────────────────────────────────────────────────────────────────────────────


def test_guardian_workflow_exists() -> None:
    assert GUARDIAN_WORKFLOW.exists(), (
        "agent-cluster-guardian.yml must exist; the dedicated cluster guardian "
        "workflow was expected to be added by PR #186."
    )


def test_preflight_checks_kubernetes_app_profile() -> None:
    text = _workflow_text()
    # The preflight script must reference both the deployment_profiles key and the
    # kubernetes-app value so that a misconfigured profile is detected before
    # any cluster-facing job executes.
    assert "deployment_profiles" in text
    assert "kubernetes-app" in text


def test_preflight_emits_missing_when_profile_absent() -> None:
    text = _workflow_text()
    # A gap in the profile check must route to the shared missing-requirements
    # accumulator that eventually blocks the cluster jobs.
    assert "missing" in text
    assert "deployment_profiles must include kubernetes-app" in text or (
        "deployment_profiles" in text and "missing" in text
    )


# ──────────────────────────────────────────────────────────────────────────────
# 2. Preflight gate: namespace allowlist
# ──────────────────────────────────────────────────────────────────────────────


def test_preflight_checks_allowed_namespaces() -> None:
    text = _workflow_text()
    assert "allowed_namespaces" in text


def test_preflight_rejects_non_wynne_namespace() -> None:
    text = _workflow_text()
    # The script must validate the wynne-* prefix so out-of-scope namespaces
    # are caught at preflight time rather than during live cluster commands.
    assert "wynne-" in text
    assert "out-of-scope" in text or "missing" in text


def test_preflight_fails_when_namespace_allowlist_empty() -> None:
    text = _workflow_text()
    assert "allowed_namespaces must be non-empty" in text or (
        "allowed_namespaces" in text and "missing" in text
    )


# ──────────────────────────────────────────────────────────────────────────────
# 3. Preflight gate: dedicated runner availability
# ──────────────────────────────────────────────────────────────────────────────


def test_preflight_checks_runner_label_config() -> None:
    text = _workflow_text()
    assert "factory-cluster-guardian" in text


def test_preflight_checks_runner_api_availability() -> None:
    text = _workflow_text()
    assert "/actions/runners?per_page=100" in text


# ──────────────────────────────────────────────────────────────────────────────
# 4. Remediation path: dispatch + approval environment + separate identity
# ──────────────────────────────────────────────────────────────────────────────


def test_remediation_job_requires_workflow_dispatch() -> None:
    text = _workflow_text()
    assert "github.event_name == 'workflow_dispatch'" in text, (
        "The remediate job must be gated on github.event_name == 'workflow_dispatch' "
        "so scheduled runs can never trigger cluster-mutating operations."
    )


def test_remediation_job_requires_run_remediation_true() -> None:
    text = _workflow_text()
    assert "run_remediation" in text
    assert "== 'true'" in text or '== "true"' in text


def test_remediation_job_has_approval_environment() -> None:
    text = _workflow_text()
    assert "environment: cluster-remediation" in text, (
        "The remediate job must use 'environment: cluster-remediation' so a human "
        "approval gate is required before any mutating cluster action can proceed."
    )


def test_remediation_job_uses_cluster_remediator_not_guardian() -> None:
    text = _workflow_text()
    assert "--agent cluster-remediator" in text, (
        "The remediate job must invoke the cluster-remediator agent, not cluster-guardian, "
        "to ensure the read-only detection identity never gains write authority."
    )


def test_remediation_job_depends_on_preflight_and_detect() -> None:
    text = _workflow_text()
    # The remediate job's needs block must reference both preflight and detect.
    # The YAML inline-list form is: needs: [preflight, detect]
    # Use a regex to find the needs line within the remediate job section so we
    # don't match "preflight" / "detect" that appear in other jobs or comments.
    remediate_section = re.search(
        r"remediate:.*?(?=^\s{2}\w|\Z)",
        text,
        re.DOTALL | re.MULTILINE,
    )
    assert remediate_section is not None, "remediate job not found in workflow"
    section = remediate_section.group(0)
    needs_match = re.search(r"needs:\s*(.+)", section)
    assert needs_match is not None, "remediate job is missing a 'needs:' declaration"
    needs_value = needs_match.group(1)
    assert "preflight" in needs_value, "remediate job must depend on preflight"
    assert "detect" in needs_value, "remediate job must depend on detect"


def test_run_remediation_input_defaults_to_false() -> None:
    text = _workflow_text()
    # The run_remediation dispatch input default must be 'false' so that
    # dispatch runs are never accidentally remediating.
    assert "run_remediation" in text
    assert "default: 'false'" in text or 'default: "false"' in text


# ──────────────────────────────────────────────────────────────────────────────
# 5. Preflight output gates detection and degraded jobs
# ──────────────────────────────────────────────────────────────────────────────


def test_detect_job_gated_by_cluster_ready_true() -> None:
    text = _workflow_text()
    assert "cluster_ready" in text
    assert "== 'true'" in text


def test_detect_degraded_job_fires_when_cluster_ready_not_true() -> None:
    text = _workflow_text()
    assert "cluster_ready" in text
    assert "!= 'true'" in text


def test_detect_degraded_job_emits_degraded_status() -> None:
    text = _workflow_text()
    # detect_degraded must surface the degraded state clearly; it must NOT exit 1
    # on a schedule because that would turn the repository red when the runner is
    # simply not yet registered (expected during rollout).
    assert "degraded" in text
    assert "::warning::" in text or "GITHUB_STEP_SUMMARY" in text


# ──────────────────────────────────────────────────────────────────────────────
# 6. Namespace scoping: guardian and remediator prompts stay within wynne-*
# ──────────────────────────────────────────────────────────────────────────────


def test_guardian_prompt_scopes_to_allowed_namespaces() -> None:
    prompt = GUARDIAN_PROMPT.read_text()
    assert "allowed_namespaces" in prompt
    assert "wynne-" in prompt


def test_guardian_prompt_forbids_out_of_scope_operations() -> None:
    prompt = GUARDIAN_PROMPT.read_text()
    assert "No operations outside configured" in prompt


def test_remediator_prompt_scopes_to_allowed_namespaces() -> None:
    prompt = REMEDIATOR_PROMPT.read_text()
    assert "allowed_namespaces" in prompt
    assert "wynne-" in prompt


def test_remediator_prompt_forbids_out_of_scope_operations() -> None:
    prompt = REMEDIATOR_PROMPT.read_text()
    assert "No operations outside configured" in prompt


def test_factory_config_allowed_namespaces_all_wynne_prefixed() -> None:
    text = _factory_text()
    # Extract the allowed_namespaces list items from the cluster_guardian section.
    # Pattern: match from "cluster_guardian:" through the "allowed_namespaces:" block
    # and capture all content until the next top-level (unindented) key or end of file.
    # Expected factory.yml format (block sequence, one item per line):
    #   cluster_guardian:
    #     allowed_namespaces:
    #       - wynne-dev
    #       - wynne-prod
    match = re.search(
        r"cluster_guardian:.*?allowed_namespaces:(.*?)(?=^\S|\Z)",
        text,
        re.DOTALL | re.MULTILINE,
    )
    assert match is not None, "cluster_guardian.allowed_namespaces not found in factory.yml"
    ns_section = match.group(1)
    # Match block-sequence items: optional leading whitespace, a dash, whitespace,
    # then one or more non-whitespace characters (the namespace name).
    namespaces = re.findall(r"^\s+-\s+(\S+)", ns_section, re.MULTILINE)
    assert len(namespaces) > 0, "cluster_guardian.allowed_namespaces must be non-empty"
    for ns in namespaces:
        assert ns.startswith("wynne-"), (
            f"Namespace '{ns}' in cluster_guardian.allowed_namespaces does not "
            "start with 'wynne-'; the cluster guardian must stay scoped to "
            "wynne-* namespaces only."
        )


# ──────────────────────────────────────────────────────────────────────────────
# 7. Incident dedupe and search-before-create invariants
# ──────────────────────────────────────────────────────────────────────────────


def test_guardian_prompt_uses_fingerprint_cli_for_dedupe() -> None:
    prompt = GUARDIAN_PROMPT.read_text()
    assert "fingerprint-cli.ts" in prompt


def test_guardian_prompt_enforces_search_before_create() -> None:
    prompt = GUARDIAN_PROMPT.read_text()
    assert "search before create" in prompt


def test_guardian_prompt_uses_auto_cluster_label() -> None:
    prompt = GUARDIAN_PROMPT.read_text()
    assert "auto:cluster" in prompt


def test_guardian_prompt_caps_new_issues_per_run() -> None:
    prompt = GUARDIAN_PROMPT.read_text()
    # The guardian must have an explicit per-run cap to prevent issue flooding.
    assert re.search(r"max\s+\d+\s+new\s+issues?\s+per\s+run", prompt, re.IGNORECASE)


def test_factory_config_issue_label_matches_guardian_prompt() -> None:
    text = _factory_text()
    # The issue_label under cluster_guardian must be "auto:cluster" and must be
    # referenced in the guardian prompt.
    assert "issue_label" in text
    assert "auto:cluster" in text
    prompt = GUARDIAN_PROMPT.read_text()
    assert "auto:cluster" in prompt


def test_guardian_prompt_searches_open_auto_cluster_issues_before_creating() -> None:
    prompt = GUARDIAN_PROMPT.read_text()
    # The guardian should call gh issue list with the auto:cluster label as part
    # of its dedupe-before-create workflow.
    assert "gh issue list" in prompt
    assert "--label" in prompt and "auto:cluster" in prompt
