from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "monitor-deploy.yml"
AGENT_PATH = REPO_ROOT / ".github" / "agents" / "deploy-sentinel.agent.md"

# NOTE: parse via plain text (no PyYAML — it is not installed in the temporal test env;
# the sibling pipeline-fast contract test follows the same text-only convention).


def test_monitor_deploy_workflow_exists() -> None:
    assert WORKFLOW_PATH.exists(), "monitor-deploy.yml must exist"


def test_monitor_deploy_is_event_driven_on_deploy_and_e2e_completion() -> None:
    text = WORKFLOW_PATH.read_text()
    assert "workflow_run:" in text, "must be event-driven via workflow_run (not polling)"
    assert '"Deploy Dev"' in text, "must watch the Deploy Dev workflow"
    assert '"E2E (dev environment)"' in text, "must watch the dev E2E workflow"
    assert "types: [completed]" in text


def test_monitor_deploy_only_acts_on_failure() -> None:
    text = WORKFLOW_PATH.read_text()
    # The job must be gated so it only investigates FAILED runs (plus manual dispatch).
    assert "github.event.workflow_run.conclusion == 'failure'" in text


def test_monitor_deploy_runs_the_deploy_sentinel_agent_with_issue_write() -> None:
    text = WORKFLOW_PATH.read_text()
    assert "--agent deploy-sentinel" in text, "must invoke the deploy-sentinel agent"
    assert "FAILED_RUN_ID:" in text, "must pass the failed run id to the agent"
    assert "issues: write" in text, "needs issues:write to raise incidents"


def test_deploy_sentinel_agent_exists_with_frontmatter() -> None:
    assert AGENT_PATH.exists(), "deploy-sentinel.agent.md must exist"
    text = AGENT_PATH.read_text()
    assert text.startswith("---"), "agent file needs YAML frontmatter"
    assert "name: deploy-sentinel" in text
    # Contract: it must always end at a deduped priority:critical incident.
    assert "priority:critical" in text
    assert "auto:deploy" in text
