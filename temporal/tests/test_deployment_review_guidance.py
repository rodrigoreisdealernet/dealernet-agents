from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PROMPTS = {
    "tech-reviewer": REPO_ROOT / ".github" / "agents" / "tech-reviewer.agent.md",
}


@pytest.mark.parametrize("agent_name", sorted(PROMPTS))
def test_reviewer_prompts_include_deployment_review_guidance(agent_name: str) -> None:
    text = PROMPTS[agent_name].read_text()

    assert "Deployment-review guidelines (deploy-risk paths)" in text
    assert "`temporal/src/**`" in text
    assert "`charts/**/values*.yaml`" in text
    assert "`deploy/k8s/**`" in text
    assert "`supabase/seed.sql`" in text
    assert "worker boot risks" in text
    assert "env/service/secret wiring" in text
    assert "RBAC verbs/resources" in text
    assert "digest-promotion wiring drift" in text
    assert "seed invariants the dev smoke E2E" in text
    assert "not a rigid checklist or new gate" in text
