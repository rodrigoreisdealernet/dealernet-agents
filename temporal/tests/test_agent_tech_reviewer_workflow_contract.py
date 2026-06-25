from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "agent-tech-reviewer.yml"


# NOTE: parse as plain text (no PyYAML dependency in temporal test env).


def _extract_on_block() -> str:
    lines = WORKFLOW_PATH.read_text().splitlines()
    on_index = next((i for i, line in enumerate(lines) if line.strip() == "on:"), None)
    assert on_index is not None, "Unable to locate `on:` block."

    block: list[str] = []
    for line in lines[on_index + 1 :]:
        if line and not line.startswith(" "):
            break
        block.append(line)
    return "\n".join(block)


def test_agent_tech_reviewer_workflow_exists() -> None:
    assert WORKFLOW_PATH.exists(), "agent-tech-reviewer.yml must exist"


def test_agent_tech_reviewer_subscribes_to_build_images_completion() -> None:
    """Review should start as soon as PR CI finishes, not only on throttled cron.

    Contract: tech-reviewer must subscribe to Build Images completion via
    `workflow_run` with `types: [completed]`.
    """
    on_text = _extract_on_block()

    assert "workflow_run:" in on_text, "must include workflow_run trigger"
    assert re.search(r"workflows:\s*\[\s*\"Build Images\"\s*\]", on_text), (
        "workflow_run must watch the Build Images workflow by exact name"
    )
    assert re.search(r"types:\s*\[\s*completed\s*\]", on_text), (
        "workflow_run must keep types: [completed] so review starts right after CI completion"
    )


def test_agent_tech_reviewer_keeps_schedule_and_manual_backstops() -> None:
    on_text = _extract_on_block()

    assert "schedule:" in on_text, "cron backstop must remain configured"
    assert "workflow_dispatch:" in on_text, "manual dispatch trigger must remain available"
