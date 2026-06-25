from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "monitor-ops.yml"
AGENT_PATH = REPO_ROOT / ".github" / "agents" / "ops-monitor.agent.md"

# NOTE: parse via plain text (no PyYAML — it is not installed in the temporal test env;
# the sibling pipeline-fast/monitor-deploy contract tests follow the same text-only
# convention).


# ---------------------------------------------------------------------------
# Workflow file — trigger contract
# ---------------------------------------------------------------------------


def test_monitor_ops_workflow_exists() -> None:
    assert WORKFLOW_PATH.exists(), "monitor-ops.yml must exist"


def test_monitor_ops_has_schedule_every_15_minutes() -> None:
    text = WORKFLOW_PATH.read_text()
    assert "schedule:" in text, "must have a scheduled trigger"
    assert "*/15 * * * *" in text, "schedule must fire every 15 minutes (spec §11)"


def test_monitor_ops_has_manual_dispatch_trigger() -> None:
    text = WORKFLOW_PATH.read_text()
    assert "workflow_dispatch" in text, "must support manual dispatch for ad-hoc runs"


# ---------------------------------------------------------------------------
# Workflow file — agent invocation and permissions
# ---------------------------------------------------------------------------


def test_monitor_ops_runs_the_ops_monitor_agent() -> None:
    text = WORKFLOW_PATH.read_text()
    assert "--agent ops-monitor" in text, "must invoke the ops-monitor agent"


def test_monitor_ops_passes_github_repository_context() -> None:
    text = WORKFLOW_PATH.read_text()
    assert "GITHUB_REPOSITORY" in text, (
        "must pass GITHUB_REPOSITORY so the agent knows which repo it is monitoring"
    )


def test_monitor_ops_has_required_permissions() -> None:
    text = WORKFLOW_PATH.read_text()
    assert "issues: write" in text, "needs issues:write to raise/update incidents"
    assert "actions: read" in text, "needs actions:read to inspect workflow run history"
    assert "contents: read" in text, "needs contents:read to fetch runbook and config"


def test_monitor_ops_has_concurrency_group() -> None:
    text = WORKFLOW_PATH.read_text()
    assert "concurrency:" in text, "must define a concurrency group"
    assert "monitor-ops" in text, "concurrency group must be named monitor-ops"
    assert "cancel-in-progress: false" in text, (
        "must not cancel in-progress runs to avoid dropped incident checks"
    )


# ---------------------------------------------------------------------------
# Agent file — frontmatter and identity
# ---------------------------------------------------------------------------


def test_ops_monitor_agent_exists_with_frontmatter() -> None:
    assert AGENT_PATH.exists(), "ops-monitor.agent.md must exist"
    text = AGENT_PATH.read_text()
    assert text.startswith("---"), "agent file must begin with YAML frontmatter"
    assert "name: ops-monitor" in text, "agent name in frontmatter must be ops-monitor"


# ---------------------------------------------------------------------------
# Agent file — queue / label routing (guardrail: scope must not silently widen)
# ---------------------------------------------------------------------------


def test_ops_monitor_agent_scopes_issues_to_auto_ops_label() -> None:
    text = AGENT_PATH.read_text()
    assert "auto:ops" in text, (
        "agent must label issues auto:ops — changing this widens or silences the ops backlog"
    )


def test_ops_monitor_agent_routes_to_queue_ops() -> None:
    text = AGENT_PATH.read_text()
    assert "queue:ops" in text, (
        "incidents must route to queue:ops so the ops lane picks them up"
    )


# ---------------------------------------------------------------------------
# Agent file — deduplication contract
# ---------------------------------------------------------------------------


def test_ops_monitor_agent_has_fingerprint_scheme() -> None:
    text = AGENT_PATH.read_text()
    assert "fingerprint" in text.lower(), (
        "agent must document a fingerprint scheme to deduplicate incidents"
    )
    # The three expected fingerprint kinds from spec §10
    assert "run-failure" in text, "fingerprint scheme must cover run-failure checks"
    assert "approval-sla" in text, "fingerprint scheme must cover approval-sla checks"
    assert "zero-finding-anomaly" in text, (
        "fingerprint scheme must cover zero-finding-anomaly checks"
    )


def test_ops_monitor_agent_dedupe_search_before_create() -> None:
    text = AGENT_PATH.read_text()
    # The agent spec must instruct: search by fingerprint first, update if found.
    assert "existing" in text.lower(), (
        "agent must instruct searching for an existing open incident before creating a new one"
    )


# ---------------------------------------------------------------------------
# Agent file — guardrails (read-only + issue cap)
# ---------------------------------------------------------------------------


def test_ops_monitor_agent_is_read_only_except_for_issue_writes() -> None:
    text = AGENT_PATH.read_text()
    assert "read-only" in text.lower() or "read only" in text.lower(), (
        "agent must declare its read-only stance — the only permitted writes are issue create/update"
    )


def test_ops_monitor_agent_caps_new_issues_per_run() -> None:
    text = AGENT_PATH.read_text()
    # The spec §10 guardrail: max 3 new issues per run to prevent issue spam.
    assert "3" in text, (
        "agent must document the per-run new-issue cap (max 3) to prevent incident spam"
    )
