from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PR_VALIDATION_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "pr-validation.yml"
MIRROR_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "mirror-temporal-ui-image.yml"


def test_pr_validation_checks_temporal_ui_acr_mirror_before_chart_tests() -> None:
    workflow_text = PR_VALIDATION_WORKFLOW.read_text()

    assert "Validate mirrored Temporal UI image in ACR" in workflow_text
    assert "bash ./.github/scripts/temporal-ui-image.sh validate" in workflow_text
    assert "docker/setup-buildx-action@v3" in workflow_text


def test_temporal_ui_mirror_workflow_runs_on_schedule_dispatch_and_main_changes() -> None:
    workflow_text = MIRROR_WORKFLOW.read_text()

    assert "workflow_dispatch:" in workflow_text
    assert "schedule:" in workflow_text
    assert "cron: '17 */6 * * *'" in workflow_text
    assert "push:" in workflow_text
    assert "branches: [main]" in workflow_text
    assert "charts/app/values.yaml" in workflow_text


def test_temporal_ui_mirror_workflow_invokes_shared_mirror_script_with_optional_dockerhub_auth() -> None:
    workflow_text = MIRROR_WORKFLOW.read_text()

    assert "Mirror Temporal UI image into ACR" in workflow_text
    assert "SOURCE_REGISTRY_USERNAME: ${{ secrets.DOCKERHUB_USERNAME }}" in workflow_text
    assert "SOURCE_REGISTRY_PASSWORD: ${{ secrets.DOCKERHUB_PASSWORD }}" in workflow_text
    assert "bash ./.github/scripts/temporal-ui-image.sh mirror" in workflow_text
