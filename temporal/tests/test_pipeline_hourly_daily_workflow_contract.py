from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_HOURLY_PATH = REPO_ROOT / ".github" / "workflows" / "pipeline-hourly.yml"
PIPELINE_DAILY_PATH = REPO_ROOT / ".github" / "workflows" / "pipeline-daily.yml"


def _extract_on_block(workflow_text: str) -> list[str]:
    lines = workflow_text.splitlines()
    on_index = next((i for i, line in enumerate(lines) if line.strip() == "on:"), None)
    assert on_index is not None, "Unable to locate `on:` block."

    block: list[str] = []
    for line in lines[on_index + 1 :]:
        if line and not line.startswith(" "):
            break
        block.append(line)
    return block


def _assert_markers_in_order(text: str, markers: list[str]) -> None:
    cursor = -1
    for marker in markers:
        next_cursor = text.find(marker, cursor + 1)
        assert next_cursor != -1, f"Missing marker: {marker}"
        assert next_cursor > cursor, f"Out-of-order marker: {marker}"
        cursor = next_cursor


def test_pipeline_hourly_schedule_and_dispatch_contract() -> None:
    workflow_text = PIPELINE_HOURLY_PATH.read_text()
    on_text = "\n".join(_extract_on_block(workflow_text))

    assert "- cron: '30 * * * *'" in on_text
    assert "workflow_dispatch:" in on_text


def test_pipeline_hourly_stage_order_and_agent_wiring() -> None:
    workflow_text = PIPELINE_HOURLY_PATH.read_text()

    _assert_markers_in_order(
        workflow_text,
        [
            "- name: Stage — Factory Architect",
            "run: npx tsx src/run-agent.ts --agent factory-architect",
            "- name: Stage — QA Manager",
            "run: npx tsx src/run-agent.ts --agent qa-manager",
            "- name: Stage — Operations Manager",
            "run: npx tsx src/run-agent.ts --agent operations-manager",
            "pipeline_private:",
            "- name: Stage — Operations Manager (private)",
            "run: npx tsx src/run-agent.ts --agent operations-manager",
            "- name: Stage — Cluster Guardian",
            "run: npx tsx src/run-agent.ts --agent cluster-guardian",
        ],
    )

    assert "pipeline_private:\n    needs: private_lane_preflight" in workflow_text
    assert "continue-on-error: true" in workflow_text
    assert "timeout-minutes: 12" in workflow_text
    assert "timeout-minutes: 18" in workflow_text


def test_pipeline_daily_schedule_and_dispatch_contract() -> None:
    workflow_text = PIPELINE_DAILY_PATH.read_text()
    on_text = "\n".join(_extract_on_block(workflow_text))

    assert "- cron: '0 6 * * *'" in on_text
    assert "workflow_dispatch:" in on_text


def test_pipeline_daily_stage_order_failure_isolation_and_agent_wiring() -> None:
    workflow_text = PIPELINE_DAILY_PATH.read_text()

    _assert_markers_in_order(
        workflow_text,
        [
            "- name: Stage — Docs Improver",
            "continue-on-error: true",
            "timeout-minutes: 12",
            "run: npx tsx src/run-agent.ts --agent docs-improver",
            "- name: Stage — User Docs Manager",
            "continue-on-error: true",
            "timeout-minutes: 12",
            "run: npx tsx src/run-agent.ts --agent user-docs-manager",
        ],
    )
