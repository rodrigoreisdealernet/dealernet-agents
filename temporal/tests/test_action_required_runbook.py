from __future__ import annotations

import functools
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MONITORING = REPO_ROOT / "MONITORING.md"
COPILOT_INSTRUCTIONS = REPO_ROOT / ".github" / "copilot-instructions.md"
FACTORY_SPEC = REPO_ROOT / "docs" / "specs" / "software-creation-factory.md"
INCIDENT_PROMPTS = {
    "actions-monitor": REPO_ROOT / ".github" / "agents" / "actions-monitor.agent.md",
    "platform-engineer": REPO_ROOT / ".github" / "agents" / "platform-engineer.agent.md",
    "cluster-guardian": REPO_ROOT / ".github" / "agents" / "cluster-guardian.agent.md",
    "operations-manager": REPO_ROOT / ".github" / "agents" / "operations-manager.agent.md",
    "security-reviewer": REPO_ROOT / ".github" / "agents" / "security-reviewer.agent.md",
}
PIPELINE_FAST = REPO_ROOT / ".github" / "workflows" / "pipeline-fast.yml"
PIPELINE_HOURLY = REPO_ROOT / ".github" / "workflows" / "pipeline-hourly.yml"
TIMEOUT_BUDGET_PROMPTS = {
    "project-manager": REPO_ROOT / ".github" / "agents" / "project-manager.agent.md",
    "qa-manager": REPO_ROOT / ".github" / "agents" / "qa-manager.agent.md",
    "tech-reviewer": REPO_ROOT / ".github" / "agents" / "tech-reviewer.agent.md",
}
CRITICAL_ESCALATION_QUEUES = {
    "actions-monitor": "queue:platform",
    "cluster-guardian": "queue:platform",
    "operations-manager": "queue:ops",
    "platform-engineer": "queue:platform",
    "security-reviewer": "queue:security",
}
# Historical references to the removed gate are allowed as long as the prompt
# explicitly says not to apply it.
HISTORICAL_GATE_MARKERS = ("removed", "do not apply", "no human merge gate", "hard gate was removed")
PROXIMITY_CHARS = 200


@functools.cache
def _prompt_text(agent_name: str) -> str:
    return INCIDENT_PROMPTS[agent_name].read_text().lower()


def _has_non_historical_gate_reference(prompt_text: str) -> bool:
    for match in re.finditer("requires-maintainer-review", prompt_text):
        context_start = max(0, match.start() - PROXIMITY_CHARS)
        context_end = min(len(prompt_text), match.end() + PROXIMITY_CHARS)
        context = prompt_text[context_start:context_end]
        if any(marker in context for marker in HISTORICAL_GATE_MARKERS):
            continue
        return True
    return False


def _contains_queue_priority_pair(prompt_text: str, queue_label: str) -> bool:
    pattern = rf"{re.escape(queue_label)}[\s\S]{{0,{PROXIMITY_CHARS}}}priority:critical|priority:critical[\s\S]{{0,{PROXIMITY_CHARS}}}{re.escape(queue_label)}"
    return re.search(pattern, prompt_text) is not None


def _contains_proximate_pair(text: str, lhs: str, rhs: str) -> bool:
    pattern = rf"{re.escape(lhs)}[\s\S]{{0,{PROXIMITY_CHARS}}}{re.escape(rhs)}|{re.escape(rhs)}[\s\S]{{0,{PROXIMITY_CHARS}}}{re.escape(lhs)}"
    return re.search(pattern, text) is not None


def test_monitoring_treats_action_required_as_settings_regression() -> None:
    monitoring_text = MONITORING.read_text().lower()

    assert "settings regression" in monitoring_text
    assert "one-time `gh run rerun` can be used only to verify" in monitoring_text
    assert "do **not** burn time on repeated reruns" in monitoring_text


def test_copilot_instructions_escalate_action_required_runs() -> None:
    instructions_text = COPILOT_INSTRUCTIONS.read_text().lower()

    assert "approval-path/settings regression" in instructions_text
    assert "escalate it to a maintainer or coordinator" in instructions_text
    assert "does **not** approve same-repo copilot pr workflows by itself" in instructions_text


def test_factory_spec_routes_action_required_backlogs_to_platform() -> None:
    spec_text = FACTORY_SPEC.read_text().lower()

    assert "investigate copilot pr workflows stuck in `action_required` and escalate persistent backlogs to platform/maintainers." in spec_text


def test_monitoring_merge_guardrails_match_autonomous_routing_policy() -> None:
    monitoring_text = MONITORING.read_text().lower()

    assert "needs-platform-review" in monitoring_text
    assert "scope anomalies as a reviewer heads-up" in monitoring_text
    assert "platform engineer" in monitoring_text  # owns the specialist lane
    assert "platform-reviewed" in monitoring_text  # label applied when lane is cleared
    assert "`requires-maintainer-review` label | — | **human only** |".lower() not in monitoring_text


def test_monitoring_distinguishes_conflict_rebase_from_contamination_rekick() -> None:
    monitoring_text = MONITORING.read_text().lower()

    assert "please rebase on main and resolve all conflicts" in monitoring_text
    assert "branch contamination" in monitoring_text
    assert "do **not** use the rebase flow above" in monitoring_text
    assert "fresh base checkout" in monitoring_text


def test_actions_monitor_checks_job_timeout_budget_before_flagging_hung() -> None:
    """The actions-monitor must check a job's declared timeout-minutes budget before
    raising a hang/shared-cause incident.  Jobs within their declared budget are
    normal expected behavior, not incidents.

    Incident reference: the Temporal worker tests job (90-min budget) was repeatedly
    flagged as a shared-cause hang when runs were only 32-60 minutes in progress
    (runs 27725192896, 27726264619, 27726111495, 27726810358, 27725990651).
    """
    prompt_text = _prompt_text("actions-monitor")

    assert "timeout-minutes" in prompt_text, (
        "Agent must reference timeout-minutes when evaluating stuck runs"
    )
    assert "temporal worker tests" in prompt_text, (
        "Agent must call out the Temporal worker tests job by name with its budget"
    )
    assert "within budget" in prompt_text or "within its declared" in prompt_text, (
        "Agent must explicitly state that jobs within budget are not hangs"
    )
    assert "do not raise" in prompt_text or "not a hang" in prompt_text, (
        "Agent must explicitly say not to raise incidents for within-budget runs"
    )


def test_actions_monitor_treats_sdk_session_idle_as_incident() -> None:
    prompt_text = _prompt_text("actions-monitor")

    assert "waiting for session.idle" in prompt_text
    assert "not a flake" in prompt_text
    assert "queue:development,ready-for-dev" in prompt_text


def test_pr_loop_sets_per_pr_timeout_budget() -> None:
    # The per-PR loop (and its budgets) moved from pipeline-fast to the
    # dedicated pr-loop.yml workflow on 2026-06-10.
    workflow_text = (PIPELINE_FAST.parent / "pr-loop.yml").read_text()

    assert "PER_PR_TIMEOUT_MIN:" in workflow_text


def test_hourly_pipeline_qa_manager_timeout_matches_agent_budget() -> None:
    workflow_text = PIPELINE_HOURLY.read_text()

    assert _contains_proximate_pair(workflow_text, "id: qa_manager", "timeout-minutes: 20")


@pytest.mark.parametrize(
    ("agent_name", "timeout_minutes"),
    [("project-manager", 10), ("qa-manager", 20), ("tech-reviewer", 20)],
)
def test_timeout_budget_agent_frontmatter(agent_name: str, timeout_minutes: int) -> None:
    prompt_text = TIMEOUT_BUDGET_PROMPTS[agent_name].read_text().lower()

    assert f"timeout_minutes: {timeout_minutes}" in prompt_text


@pytest.mark.parametrize("agent_name", sorted(INCIDENT_PROMPTS))
def test_incident_prompts_route_critical_follow_up_to_expected_queue(agent_name: str) -> None:
    prompt_text = _prompt_text(agent_name)
    expected_queue = CRITICAL_ESCALATION_QUEUES[agent_name]

    assert "priority:critical" in prompt_text
    if agent_name == "security-reviewer":
        assert expected_queue in prompt_text
    else:
        assert _contains_queue_priority_pair(prompt_text, expected_queue)
    assert not _has_non_historical_gate_reference(prompt_text)
