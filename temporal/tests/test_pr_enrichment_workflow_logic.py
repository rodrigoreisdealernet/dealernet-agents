from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "pr-enrichment.yml"
PROJECT_MANAGER_PROMPT = REPO_ROOT / ".github" / "agents" / "project-manager.agent.md"
TECH_REVIEWER_PROMPT = REPO_ROOT / ".github" / "agents" / "tech-reviewer.agent.md"
SECURITY_REVIEWER_PROMPT = REPO_ROOT / ".github" / "agents" / "security-reviewer.agent.md"
DATABASE_STEWARD_PROMPT = REPO_ROOT / ".github" / "agents" / "database-steward.agent.md"
PLATFORM_ENGINEER_PROMPT = REPO_ROOT / ".github" / "agents" / "platform-engineer.agent.md"
COPILOT_INSTRUCTIONS = REPO_ROOT / ".github" / "copilot-instructions.md"
CONFLICT_REBASE_CONTEXT_CHARS = 500
CONFLICT_REKICK_GUARDRAIL_CHARS = 350
CONFLICT_REKICK_LABEL_GUARDRAIL_CHARS = 250
GREEN_CHECK_CONCLUSIONS = {"success", "neutral", "skipped"}
HUMAN_ESCALATION_MARKERS = (
    "escalate to human",
    "escalate to the human",
    "escalate to owner",
    "escalate to maintainer",
    "human handoff",
    "parked for human",
)


def _extract_github_script() -> str:
    lines = WORKFLOW_PATH.read_text().splitlines()
    marker_index = next((i for i, line in enumerate(lines) if line.strip() == "script: |"), None)
    assert marker_index is not None, "Unable to locate `script: |` block in pr-enrichment workflow."
    marker_indent = len(lines[marker_index]) - len(lines[marker_index].lstrip(" "))
    content_indent = marker_indent + 2

    script_lines: list[str] = []
    for line in lines[marker_index + 1 :]:
        if line.startswith(" " * content_indent):
            script_lines.append(line[content_indent:])
            continue
        if line.strip() == "":
            script_lines.append("")
            continue
        break
    return "\n".join(script_lines)


def test_pr_enrichment_pull_request_token_uses_scoped_github_token_only() -> None:
    workflow_text = WORKFLOW_PATH.read_text()

    assert "github-token: ${{ github.token }}" in workflow_text
    assert "github-token: ${{ secrets.PROJECT_MANAGER_PAT || github.token }}" not in workflow_text


def _run_pr_enrichment_routing_logic(
    *,
    files: list[str | dict[str, str]],
    existing_labels: list[str],
    pr_body: str = "",
    issues: dict[int, dict[str, str]] | None = None,
) -> dict[str, object]:
    script = _extract_github_script()
    payload = json.dumps(
        {
            "files": files,
            "existingLabels": existing_labels,
            "prBody": pr_body,
            "issues": issues or {},
        }
    )
    harness = f"""
const input = {payload};
const normalizedFiles = input.files.map(file => (
  typeof file === 'string'
    ? {{ filename: file, status: 'added' }}
    : {{ filename: file.filename, status: file.status || 'modified' }}
));
const added = [];
const removed = [];
const fsMod = require('fs');
const osMod = require('os');
const pathMod = require('path');
const summaryPath = pathMod.join(osMod.tmpdir(), `pr-enrichment-${{process.pid}}-${{Math.random()}}.md`);
process.env.GITHUB_STEP_SUMMARY = summaryPath;
const context = {{
  payload: {{
    pull_request: {{
      number: 1,
      body: input.prBody,
      labels: input.existingLabels.map(name => ({{ name }})),
    }},
  }},
  repo: {{ owner: "o", repo: "r" }},
}};
const github = {{
  rest: {{
    pulls: {{
      listFiles: async () => ({{
        data: normalizedFiles,
      }}),
    }},
    issues: {{
      listLabelsOnIssue: async () => ({{
        data: input.existingLabels.map(name => ({{ name }})),
      }}),
      addLabels: async (args) => {{
        for (const label of args.labels) added.push(label);
      }},
      get: async (args) => {{
        const issue = input.issues[String(args.issue_number)];
        if (!issue) {{
          throw new Error(`Missing stub issue #${{args.issue_number}}`);
        }}
        return {{
          data: {{
            number: args.issue_number,
            title: issue.title || '',
            body: issue.body || '',
          }},
        }};
      }},
      removeLabel: async (args) => {{
        removed.push(args.name);
      }},
    }},
  }},
}};

(async () => {{
{script}
  const summaryText = fsMod.existsSync(summaryPath) ? fsMod.readFileSync(summaryPath, 'utf8') : '';
  process.stdout.write(JSON.stringify({{ added, removed, summary: summaryText }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
    result = subprocess.run(
        ["node", "-e", harness],
        text=True,
        capture_output=True,
        check=True,
        cwd=REPO_ROOT,
        timeout=60.0,
    )
    return json.loads(result.stdout)


def _line_contains_all_words(text: str, *words: str) -> bool:
    return any(all(word in line for word in words) for line in text.splitlines())


def _has_explicit_unchecked_task_list(pr_body: str) -> bool:
    fenced_code_block = re.compile(r"```.*?```", re.DOTALL)
    stripped_body = fenced_code_block.sub("", pr_body)
    return bool(re.search(r"(?m)^\s*-\s\[\s\]\s+\S", stripped_body))


def _project_manager_draft_transition(
    *,
    is_draft: bool,
    mergeable: str,
    checks: list[dict[str, str | None]],
    last_commit_age_minutes: int,
    pr_body: str = "",
) -> dict[str, str]:
    if not is_draft:
        return {"transition": "noop", "reason": "not-draft"}
    if mergeable == "CONFLICTING":
        return {"transition": "stay-draft", "reason": "merge-conflict"}

    normalized_checks = [
        {
            "state": (check.get("state") or "").lower(),
            "conclusion": (check.get("conclusion") or "").lower(),
        }
        for check in checks
    ]
    if any(check["state"] != "completed" for check in normalized_checks):
        return {"transition": "stay-draft", "reason": "checks-running"}
    if any(check["conclusion"] not in GREEN_CHECK_CONCLUSIONS for check in normalized_checks):
        return {"transition": "stay-draft", "reason": "checks-not-green"}
    if last_commit_age_minutes < 10:
        return {
            "transition": "stay-draft",
            "reason": "still-working" if _has_explicit_unchecked_task_list(pr_body) else "settling",
        }
    return {"transition": "ready", "reason": "settled-green"}


def test_low_risk_change_stays_autonomous_and_clears_stale_risk_labels() -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=["README.md"],
        existing_labels=["risk:medium", "risk:high"],
    )

    assert "risk:low" in outcome["added"]
    assert "requires-maintainer-review" not in outcome["added"]
    assert set(outcome["removed"]) == {"risk:medium", "risk:high"}


def test_medium_risk_change_stays_autonomous_and_relabels_risk_band() -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=["frontend/src/engine/renderer.ts"],
        existing_labels=["risk:low"],
    )

    assert "risk:medium" in outcome["added"]
    assert "requires-maintainer-review" not in outcome["added"]
    assert outcome["removed"] == ["risk:low"]


def test_high_risk_temporal_change_does_not_trigger_blanket_maintainer_gate() -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=["temporal/src/workflows/rental/rental_workflow.py"],
        existing_labels=["risk:low"],
    )

    assert "risk:high" in outcome["added"]
    assert "requires-maintainer-review" not in outcome["added"]
    assert outcome["removed"] == ["risk:low"]


def test_genuine_high_risk_change_routes_to_platform_review_without_human_gate() -> None:
    # The requires-maintainer-review hard human gate was removed 2026-06-07 at the
    # owner's direction. Even genuinely high-risk surfaces (e.g. a prod deploy
    # workflow) now route through the automated Platform Engineer lane, not a human
    # merge gate.
    outcome = _run_pr_enrichment_routing_logic(
        files=[".github/workflows/deploy-prod.yml"],
        existing_labels=[],
    )

    assert "risk:high" in outcome["added"]
    assert "needs-platform-review" in outcome["added"]
    assert "requires-maintainer-review" not in outcome["added"]


@pytest.mark.parametrize(
    "platform_path",
    [
        ".github/workflows/pipeline-fast.yml",
        ".github/workflows/pr-enrichment.yml",
        ".github/agents/platform-engineer.agent.md",
        ".github/tools/shared/package.json",
        "charts/app/values.yaml",
        "deploy/k8s/deployment.yaml",
    ],
)
def test_platform_sensitive_paths_trigger_needs_platform_review(platform_path: str) -> None:
    """All platform-sensitive paths must route to the Platform Engineer lane via
    needs-platform-review — not to a human gate."""
    outcome = _run_pr_enrichment_routing_logic(
        files=[platform_path],
        existing_labels=[],
    )
    assert "needs-platform-review" in outcome["added"], (
        f"{platform_path} must trigger needs-platform-review"
    )
    assert "requires-maintainer-review" not in outcome["added"]


def test_platform_reviewed_label_exempts_from_lane_reopen() -> None:
    """When platform-reviewed already exists on a PR, pr-enrichment must NOT
    re-open the needs-platform-review lane on subsequent commits.  Re-opening it
    would thrash the lane and permanently block merge after the Platform Engineer
    has cleared it."""
    outcome = _run_pr_enrichment_routing_logic(
        files=[".github/workflows/pipeline-fast.yml"],
        existing_labels=["platform-reviewed"],
    )
    assert "needs-platform-review" not in outcome["added"]
    assert "platform-reviewed" not in outcome["removed"]


@pytest.mark.parametrize(
    "non_platform_path",
    [
        "frontend/src/App.tsx",
        "temporal/src/workflows/rental/rental_workflow.py",
        "supabase/migrations/20260101000000_add_table.sql",
        "docs/architecture/README.md",
        "scripts/bootstrap-labels.sh",
        "README.md",
    ],
)
def test_non_platform_paths_do_not_trigger_needs_platform_review(non_platform_path: str) -> None:
    """Unrelated paths must NOT open the platform specialist lane."""
    outcome = _run_pr_enrichment_routing_logic(
        files=[non_platform_path],
        existing_labels=[],
    )
    assert "needs-platform-review" not in outcome["added"], (
        f"{non_platform_path} must NOT trigger needs-platform-review"
    )


def test_frontend_only_story_flags_temporal_scope_anomaly() -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=[
            "frontend/src/routes/dashboard.tsx",
            "temporal/src/workflows/rental/rental_workflow.py",
        ],
        existing_labels=[],
        pr_body="Fixes #195",
        issues={
            195: {
                "title": "Story: Tighten dashboard filters",
                "body": """
## Scope
Update the frontend dashboard filter UX only.

## Constraints
- Keep the implementation in `frontend/` plus matching frontend tests.
""",
            }
        },
    )

    # Scope-anomaly DETECTION is retained as a non-blocking reviewer heads-up
    # (issue #79), but it no longer applies the requires-maintainer-review human
    # gate — the Tech Reviewer confirms scope and approves or requests changes.
    assert "requires-maintainer-review" not in outcome["added"]
    assert "scope anomaly" in str(outcome["summary"]).lower()
    assert "frontend" in str(outcome["summary"]).lower()
    assert "temporal" in str(outcome["summary"]).lower()
    assert "tech reviewer" in str(outcome["summary"]).lower()
    assert "no human merge gate" in str(outcome["summary"]).lower()


def test_explicit_multi_surface_story_allows_legitimate_override() -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=[
            "frontend/src/routes/dashboard.tsx",
            "temporal/src/workflows/rental/rental_workflow.py",
        ],
        existing_labels=[],
        pr_body="Fixes #194",
        issues={
            194: {
                "title": "Story: Coordinate dashboard handoff",
                "body": """
## Scope
Update both the frontend dashboard UI and the Temporal rental workflow handoff.

## Constraints
- Touch only `frontend/`, `temporal/`, and tests needed for the handoff.
""",
            }
        },
    )

    assert "requires-maintainer-review" not in outcome["added"]
    assert "in declared issue scope" in str(outcome["summary"]).lower()


@pytest.mark.parametrize("database_path", ["supabase/migrations/20260606210000_add_rls.sql", "supabase/seed.sql"])
def test_database_sensitive_changes_route_to_database_review_when_not_precleared(database_path: str) -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=[
            {"filename": database_path, "status": "added"}
            if database_path.startswith("supabase/migrations/")
            else database_path
        ],
        existing_labels=[],
    )

    assert "needs-database-review" in outcome["added"]


@pytest.mark.parametrize("database_path", ["supabase/migrations/20260606210000_add_rls.sql", "supabase/seed.sql"])
def test_database_sensitive_changes_do_not_reopen_lane_when_already_reviewed(database_path: str) -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=[
            {"filename": database_path, "status": "added"}
            if database_path.startswith("supabase/migrations/")
            else database_path
        ],
        existing_labels=["database-reviewed"],
    )

    assert "needs-database-review" not in outcome["added"]
    assert "database-reviewed" not in outcome["removed"]


def test_unrelated_changes_do_not_route_to_database_review_or_clear_database_review() -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=["frontend/src/App.tsx"],
        existing_labels=["database-reviewed"],
    )
    assert "needs-database-review" not in outcome["added"]
    assert "database-reviewed" not in outcome["removed"]


def test_modified_historical_migration_reopens_database_steward_lane() -> None:
    # Use the originally drifted migration from issue #74 so this regression stays
    # tied to the real applied-migration-edit failure class.
    outcome = _run_pr_enrichment_routing_logic(
        files=[{"filename": "supabase/migrations/20260605154500_rental_master_data_foundation.sql", "status": "modified"}],
        existing_labels=["database-reviewed"],
    )

    assert "needs-database-review" in outcome["added"]
    assert "database-reviewed" in outcome["removed"]
    assert "applied-migration edit detected" in str(outcome["summary"]).lower()


def test_added_migration_remains_additive_and_does_not_clear_reviewed_label() -> None:
    outcome = _run_pr_enrichment_routing_logic(
        files=[{"filename": "supabase/migrations/20260618010000_new_feature.sql", "status": "added"}],
        existing_labels=["database-reviewed"],
    )

    assert "needs-database-review" not in outcome["added"]
    assert "database-reviewed" not in outcome["removed"]
    assert "additive-only migration changes" in str(outcome["summary"]).lower()


def test_agent_prompts_match_autonomous_no_human_gate_policy() -> None:
    # The requires-maintainer-review human merge gate was removed 2026-06-07. The
    # PM and Tech Reviewer prompts must encode fully-autonomous merge-on-approval,
    # not a maintainer-sign-off step.
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()
    tech_reviewer_text = TECH_REVIEWER_PROMPT.read_text().lower()

    assert "factory" in project_manager_text and "merge" in project_manager_text, (
        "Project Manager prompt must preserve autonomous merge-by-default behavior."
    )
    assert "no human merge gate" in project_manager_text, (
        "Project Manager prompt must state there is no human merge gate."
    )
    assert "scope-anomaly" in project_manager_text or "scope anomaly" in project_manager_text, (
        "Project Manager prompt must still handle scope anomalies (route to Tech Reviewer)."
    )
    # The gate label must no longer appear as an active blocker in the PM prompt
    # (only as the historical removal note).
    assert "do not merge or auto-rerun" not in project_manager_text, (
        "Project Manager prompt must not block merge/rerun on the removed gate."
    )
    assert _line_contains_all_words(tech_reviewer_text, "no", "human", "gate"), (
        "Tech Reviewer prompt must align with the no-human-gate autonomous merge policy."
    )
    assert "scope-anomaly" in tech_reviewer_text or "scope anomaly" in tech_reviewer_text, (
        "Tech Reviewer prompt must recognize scope anomalies and resolve them itself."
    )
    assert "maintainer approval" not in project_manager_text
    assert "maintainer approval" not in tech_reviewer_text


@pytest.mark.parametrize(
    ("agent_name", "prompt_path"),
    [
        ("project-manager", PROJECT_MANAGER_PROMPT),
        ("tech-reviewer", TECH_REVIEWER_PROMPT),
        ("security-reviewer", SECURITY_REVIEWER_PROMPT),
    ],
)
def test_reviewer_contract_settled_findings_end_with_in_lane_terminal_decision(
    agent_name: str, prompt_path: Path
) -> None:
    prompt_text = prompt_path.read_text().lower()

    assert "approve" in prompt_text, (
        f"{agent_name} must include an in-lane approval path for settled/green review outcomes."
    )
    assert "request changes" in prompt_text, (
        f"{agent_name} must keep in-lane changes-request decisions for unresolved findings."
    )
    assert not any(marker in prompt_text for marker in HUMAN_ESCALATION_MARKERS), (
        f"{agent_name} must not hand settled review decisions off to a human escalation path."
    )


def test_project_manager_prompt_routes_conflicts_to_rebase_and_contamination_to_rekick() -> None:
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()

    # Normal stale-base merge conflicts must be handled in-place (rebase), not
    # by asking for a throwaway branch/re-kick.
    assert re.search(
        rf"merge conflict[\s\S]{{0,{CONFLICT_REBASE_CONTEXT_CHARS}}}(rebase|in-place|in place|same branch|existing branch)",
        project_manager_text,
    ), "Expected merge-conflict guidance to mention in-place/same-branch recovery."
    assert not re.search(
        rf"merge conflict[\s\S]{{0,{CONFLICT_REKICK_GUARDRAIL_CHARS}}}close the pr and request a clean re-kick",
        project_manager_text,
    ), "Merge-conflict guidance should not instruct closing the PR for a clean re-kick."
    assert not re.search(
        rf"merge conflict[\s\S]{{0,{CONFLICT_REKICK_LABEL_GUARDRAIL_CHARS}}}\[factory-rekick\]",
        project_manager_text,
    ), "Merge-conflict guidance should stay distinct from the contamination re-kick marker."

    # Genuine contamination still requires a strict clean re-kick path.
    assert "[factory-rekick]" in project_manager_text
    assert "fresh {{ default_branch }} checkout" in project_manager_text
    assert 'baseref:"{{ default_branch }}"' in project_manager_text


def test_copilot_instructions_require_clean_rekick_not_rebase() -> None:
    instructions_text = COPILOT_INSTRUCTIONS.read_text().lower()

    assert "clean session bootstrap" in instructions_text
    assert "fresh checkout of the current base branch" in instructions_text
    assert "do **not** recover by rebasing" in instructions_text
    assert "close the pr and request a clean re-kick" in instructions_text


def test_project_manager_prompt_requires_settled_green_drafts_to_transition_ready() -> None:
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()

    assert "must be marked ready" in project_manager_text
    assert "ci is green" in project_manager_text
    assert "the pr has **settled**" in project_manager_text
    assert "gh pr ready <number>" in project_manager_text
    assert "a green, settled, mergeable draft is done — ready it." in project_manager_text


def test_project_manager_prompt_hard_skips_needs_design_assignment() -> None:
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()

    assert "hard assignment guard" in project_manager_text
    assert "never assign copilot to any issue labeled `needs-design`" in project_manager_text
    assert "design-in-progress" in project_manager_text


def test_database_and_platform_prompts_forbid_pr_architecture_dead_letter_routing() -> None:
    database_text = DATABASE_STEWARD_PROMPT.read_text().lower()
    platform_text = PLATFORM_ENGINEER_PROMPT.read_text().lower()

    assert "for **prs**, never add `needs-design` or `queue:architecture`" in database_text
    assert "always decide in this lane: approve when safe, or request changes" in database_text

    assert "never add `needs-design` or `queue:architecture` to a pr" in platform_text
    assert "terminal in-lane state" in platform_text


def test_platform_engineer_prompt_lane_contract_and_handoff() -> None:
    """The Platform Engineer prompt must carry the complete blocking-lane contract:
    it owns needs-platform-review, clears it with platform-reviewed on success, or
    keeps the block via changes-requested.  It must NOT claim final merge approval —
    that belongs to the Tech Reviewer which runs after the platform stage in the
    pipeline (guaranteed by test_pipeline_fast_stage_order_lanes_then_reviewer)."""
    platform_text = PLATFORM_ENGINEER_PROMPT.read_text().lower()

    # Lane-entry label the agent processes
    assert "needs-platform-review" in platform_text
    # Success terminal: clears the lane
    assert "platform-reviewed" in platform_text
    # Failure terminal: keeps the block
    assert "request changes" in platform_text or "changes-requested" in platform_text
    # Covers the queue:platform issue-triage lane as well
    assert "queue:platform" in platform_text
    # Must NOT claim merge approval authority — the platform engineer clears the
    # platform lane only; the Tech Reviewer produces the APPROVED verdict that the
    # PM merges on.  The agent may "block merges" via needs-platform-review, but
    # it does not approve PRs for merge.
    assert "queue:review" not in platform_text, (
        "Platform Engineer must not route PRs to queue:review — that is the Tech Reviewer's lane"
    )


def test_project_manager_prompt_recovers_prs_from_architecture_dead_letter_labels() -> None:
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()

    assert "if a pr carries `needs-design` or `queue:architecture`" in project_manager_text
    assert "dead-letter" in project_manager_text
    assert "misroute" in project_manager_text
    assert "queue:review" in project_manager_text
    assert "factory architect is issue-only" in project_manager_text


def test_project_manager_completes_stale_review_merges_itself() -> None:
    """Owner mandate (2026-06-10, after PR #848 burned five review rounds): when a
    changes-requested verdict is SUPERSEDED by newer commits (computed in code as
    `reviewSuperseded`) and the head is objectively clean (green, mergeable, no open
    lane), the PM verifies the reviewer's named blockers are resolved and completes
    the merge itself — no human, no extra review round. The rule must stay bounded:
    objective verification only, never against a standing (newer-than-head) review."""
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()

    assert "stale-review completion" in project_manager_text
    assert "reviewsuperseded" in project_manager_text
    # Bounded authority: mechanical verification, no standing-objection overrule.
    assert "objectively" in project_manager_text
    assert "never" in project_manager_text and "standing objection" in project_manager_text


def test_project_manager_has_bounded_escalation_ladder_for_stuck_prs() -> None:
    """Owner mandate (2026-06-10): the PM must RECOVER work from problematic states,
    not just route it. The orchestrator's stuck ledger (pr-state.ts) counts
    consecutive no-progress passes in code; the PM prompt must carry the bounded
    escalation ladder it executes when the ledger fires: different lever → re-kick
    (close + unassign + reassign — plain reassign after close is a no-op) → loud
    deduped factory-stuck incident. Silence on a stuck PR is the failure mode."""
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()

    assert "escalation ladder" in project_manager_text
    assert "stuck ledger" in project_manager_text
    # Rung 2 must encode the unassign-then-reassign gotcha.
    assert "unassign copilot, then reassign" in project_manager_text
    assert "no-op" in project_manager_text
    # Rung 3 must be a loud, deduped incident — never silence.
    assert "factory-stuck" in project_manager_text
    assert "never leave a stuck pr silent" in project_manager_text


def test_project_manager_rekick_path_handles_missing_linked_issue() -> None:
    """A clean re-kick cannot proceed if the closed PR had no linked issue.
    The prompt must require creating/identifying a development owner issue first."""
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()

    assert "if the pr has **no linked issue**" in project_manager_text
    assert "identify/create the development owner" in project_manager_text
    assert "currently open incident" in project_manager_text
    assert "same failure class" in project_manager_text
    assert "queue:development" in project_manager_text


def test_project_manager_merges_on_approval_and_routes_everything_else_to_tech_reviewer() -> None:
    """The PM does NOT review diffs. It is a binary: merge an APPROVED+green+mergeable
    PR with lanes cleared, or ensure it carries `queue:review` so the Tech Reviewer (the
    sole engineering approver) reviews it. No PM self-review carve-out, no human gate for
    any path (including .github/). This replaced the old narrow direct-merge carve-out
    (docs-only / additive-migration) that over-complicated the PM and stranded the queue."""
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text().lower()

    assert "queue:review" in project_manager_text
    assert "tech reviewer" in project_manager_text
    # Merge is gated on an APPROVED review, produced by the Tech Reviewer / specialist lane.
    assert "approved" in project_manager_text
    # The PM must NOT carry a self-review carve-out anymore — that was the over-complication.
    assert "docs-only changes" not in project_manager_text
    assert "narrow trivially-safe carve-out" not in project_manager_text
    # No human/owner gate for control-plane paths — the factory merges them autonomously.
    assert "no human merge gate" in project_manager_text
    assert "merges everything autonomously" in project_manager_text
    # .github/ is still named — as a path the factory merges autonomously (NOT a human gate).
    assert "`.github/`" in project_manager_text


def test_tech_reviewer_prompt_defers_database_signoff_to_database_steward() -> None:
    tech_reviewer_text = TECH_REVIEWER_PROMPT.read_text().lower()

    assert "database steward is the separate db reviewer and owns migration sign-off" in tech_reviewer_text
    assert "`needs-database-review` → database steward" in tech_reviewer_text


def test_project_manager_contract_marks_green_settled_copilot_draft_ready() -> None:
    outcome = _project_manager_draft_transition(
        is_draft=True,
        mergeable="MERGEABLE",
        checks=[
            {"name": "pr-validation", "state": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "pr-enrichment", "state": "COMPLETED", "conclusion": "NEUTRAL"},
        ],
        last_commit_age_minutes=11,
        pr_body="- implementation notes only",
    )

    assert outcome == {"transition": "ready", "reason": "settled-green"}


@pytest.mark.parametrize(
    ("is_draft", "mergeable", "expected"),
    [
        (
            False,
            "MERGEABLE",
            {"transition": "noop", "reason": "not-draft"},
        ),
        (
            True,
            "CONFLICTING",
            {"transition": "stay-draft", "reason": "merge-conflict"},
        ),
    ],
)
def test_project_manager_contract_handles_non_draft_and_conflicting_prs(
    is_draft: bool, mergeable: str, expected: dict[str, str]
) -> None:
    outcome = _project_manager_draft_transition(
        is_draft=is_draft,
        mergeable=mergeable,
        checks=[{"name": "pr-validation", "state": "COMPLETED", "conclusion": "SUCCESS"}],
        last_commit_age_minutes=12,
    )

    assert outcome == expected


@pytest.mark.parametrize(
    ("checks", "last_commit_age_minutes", "pr_body", "expected_reason"),
    [
        (
            [{"name": "pr-validation", "state": "IN_PROGRESS", "conclusion": None}],
            12,
            "",
            "checks-running",
        ),
        (
            [{"name": "pr-validation", "state": "COMPLETED", "conclusion": "FAILURE"}],
            12,
            "",
            "checks-not-green",
        ),
        (
            [{"name": "pr-validation", "state": "COMPLETED", "conclusion": "CANCELLED"}],
            12,
            "",
            "checks-not-green",
        ),
        (
            [{"name": "pr-validation", "state": "COMPLETED", "conclusion": "TIMED_OUT"}],
            12,
            "",
            "checks-not-green",
        ),
        (
            [{"name": "pr-validation", "state": "COMPLETED", "conclusion": "SUCCESS"}],
            4,
            "",
            "settling",
        ),
        (
            [{"name": "pr-validation", "state": "COMPLETED", "conclusion": "SUCCESS"}],
            4,
            "- [ ] finish final validation",
            "still-working",
        ),
    ],
)
def test_project_manager_contract_keeps_unready_drafts_blocked(
    checks: list[dict[str, str | None]],
    last_commit_age_minutes: int,
    pr_body: str,
    expected_reason: str,
) -> None:
    outcome = _project_manager_draft_transition(
        is_draft=True,
        mergeable="MERGEABLE",
        checks=checks,
        last_commit_age_minutes=last_commit_age_minutes,
        pr_body=pr_body,
    )

    assert outcome == {"transition": "stay-draft", "reason": expected_reason}


@pytest.mark.parametrize(
    ("pr_body", "expected"),
    [
        ("", False),
        ("   \n", False),
        ("- [ ] finish validation\n- [x] update tests", True),
        ("- [] malformed task syntax", False),
        ("- plain prose bullet\n- another note", False),
        ("```md\n- [ ] code block task\n```\n- plain prose bullet", False),
    ],
)
def test_project_manager_contract_only_counts_literal_unchecked_task_lists(
    pr_body: str, expected: bool
) -> None:
    assert _has_explicit_unchecked_task_list(pr_body) is expected


# ---------------------------------------------------------------------------
# Shared incident-family policy regressions (issue #1579)
#
# These tests verify that the shared TypeScript helpers required by the
# incident-family policy are present and correctly structured so callers
# (PM stuck ladder, workflow sentinels) can use a single canonical path
# instead of embedding bespoke shell snippets.
# ---------------------------------------------------------------------------

INCIDENT_UPSERT_TS = (
    REPO_ROOT / ".github" / "tools" / "shared" / "src" / "incident-upsert.ts"
)
PR_STATE_TS = REPO_ROOT / ".github" / "tools" / "shared" / "src" / "pr-state.ts"


def test_incident_upsert_helper_exists() -> None:
    """The shared incident-upsert helper must exist in the shared tools package."""
    assert INCIDENT_UPSERT_TS.exists(), (
        "incident-upsert.ts not found — the shared incident-family helper is required "
        "so callers stop inventing bespoke gh issue create/list shell snippets."
    )


def test_incident_upsert_exports_pr_local_and_shared_cause_kinds() -> None:
    """The helper must export both incident kind values: pr-local and shared-cause."""
    text = INCIDENT_UPSERT_TS.read_text()
    assert "pr-local" in text, "incident-upsert.ts must define the 'pr-local' incident kind"
    assert "shared-cause" in text, "incident-upsert.ts must define the 'shared-cause' incident kind"


def test_incident_upsert_routes_shared_cause_to_platform_not_development() -> None:
    """Shared-cause incidents must route to auto:alert + queue:platform.
    They must NOT be routed to queue:development — that fragments ownership
    during a shared CI/infra outage."""
    text = INCIDENT_UPSERT_TS.read_text()
    assert "auto:alert" in text, "shared-cause incidents must carry auto:alert label"
    assert "queue:platform" in text, "shared-cause incidents must route to queue:platform"
    assert "queue:development" not in text, (
        "incident-upsert.ts must NOT reference queue:development — shared CI blockers "
        "belong in the platform lane, not the development lane"
    )


def test_incident_upsert_shared_family_fingerprint_uses_stable_low_cardinality_inputs() -> None:
    """The shared-cause fingerprint must use stable, low-cardinality inputs
    (failure-class + scope) and must NOT include PR number, commit SHA, or run URL."""
    text = INCIDENT_UPSERT_TS.read_text()
    assert "buildSharedCauseFingerprint" in text, (
        "incident-upsert.ts must export buildSharedCauseFingerprint"
    )
    assert "failureClass" in text or "failure-class" in text or "failure_class" in text, (
        "buildSharedCauseFingerprint must accept a failureClass parameter"
    )


def test_incident_upsert_exports_classify_incident_function() -> None:
    """The classifier must be explicit and testable — not buried only in prompt text."""
    text = INCIDENT_UPSERT_TS.read_text()
    assert "classifyIncident" in text, (
        "incident-upsert.ts must export classifyIncident so callers can use the "
        "explicit, testable classification logic"
    )


def test_incident_upsert_exports_upsert_incident_function() -> None:
    """The canonical create-or-update path must be exported from the helper."""
    text = INCIDENT_UPSERT_TS.read_text()
    assert "upsertIncident" in text, (
        "incident-upsert.ts must export upsertIncident — the single create-or-update "
        "entry point for all factory incident filings"
    )


def test_incident_upsert_deduplication_uses_fingerprint_body_markers() -> None:
    """Deduplication must use fingerprint HTML comments as the search primitive —
    not label filters that are fragile after triage relabeling."""
    text = INCIDENT_UPSERT_TS.read_text()
    assert "fingerprintSearchToken" in text, (
        "incident-upsert.ts must use fingerprintSearchToken for dedup lookups "
        "so relabeled issues are still found"
    )
    assert "fingerprintComment" in text, (
        "incident-upsert.ts must embed fingerprint HTML comments in issue bodies"
    )


def test_pr_state_stuck_notice_includes_shared_cause_guidance() -> None:
    """The stuck notice injected into per-PR sessions must carry the shared-cause/
    pr-local classification rule so the PM uses the correct routing path."""
    text = PR_STATE_TS.read_text()
    assert "shared-cause" in text, (
        "pr-state.ts buildStuckNotice must mention shared-cause classification — "
        "the stuck notice is the mechanism that delivers the policy to each per-PR session"
    )
    assert "pr-local" in text, (
        "pr-state.ts buildStuckNotice must mention pr-local classification"
    )


def test_pr_state_stuck_notice_references_incident_upsert_module() -> None:
    """The stuck notice must reference the shared incident-upsert module so the
    PM agent knows which helper to call rather than inventing bespoke shell logic."""
    text = PR_STATE_TS.read_text()
    assert "incident-upsert" in text, (
        "pr-state.ts buildStuckNotice must reference incident-upsert.ts"
    )
    assert "upsertIncident" in text, (
        "pr-state.ts buildStuckNotice must reference the upsertIncident function"
    )


def test_pr_state_stuck_notice_directs_shared_cause_to_platform_queue() -> None:
    """The stuck notice must explicitly state that shared CI failures route to
    queue:platform and must NOT open a queue:development issue."""
    text = PR_STATE_TS.read_text()
    assert "queue:platform" in text, (
        "pr-state.ts buildStuckNotice must mention queue:platform for shared-cause routing"
    )
    assert "queue:development" in text, (
        "pr-state.ts buildStuckNotice must explicitly warn against opening queue:development "
        "issues for shared CI blockers"
    )


def test_pr_enrichment_detects_shared_file_overlap() -> None:
    """pr-enrichment must contain shared-file overlap detection logic (#58).

    The step must:
    - Scan open PRs for exact file-path overlap with the current PR.
    - Apply the 'shared-file-overlap' label when overlap is found.
    - Remove the 'shared-file-overlap' label when no overlap exists.
    - Include the overlapping PR numbers and shared files in the step summary.
    """
    script = _extract_github_script()

    assert "shared-file-overlap" in script, (
        "pr-enrichment must apply/remove the 'shared-file-overlap' label based on "
        "whether another open PR touches the same files (issue #58 guardrail)."
    )
    assert "github.rest.pulls.list" in script, (
        "pr-enrichment must list open PRs to find concurrent file-overlap candidates."
    )
    assert "overlapPrs" in script, (
        "pr-enrichment must collect the set of overlapping PRs for summary output."
    )
    assert "github.rest.pulls.listFiles" in script, (
        "pr-enrichment must fetch changed files from each sibling open PR to detect overlap."
    )
    assert "labelsToAdd.add('shared-file-overlap')" in script, (
        "pr-enrichment must add 'shared-file-overlap' to labelsToAdd when overlap is detected."
    )
    assert "labelsToRemove.add('shared-file-overlap')" in script, (
        "pr-enrichment must add 'shared-file-overlap' to labelsToRemove when no overlap is found "
        "so the label self-clears after a sibling PR merges."
    )
    assert "overlapScanComplete" in script, (
        "pr-enrichment must guard label mutation with a scan-completion flag so that "
        "API errors do not accidentally clear an existing 'shared-file-overlap' label."
    )


def test_pr_enrichment_overlap_api_error_leaves_label_unchanged() -> None:
    """On any GitHub API error during the overlap scan the 'shared-file-overlap'
    label must be left unchanged — neither added nor removed.

    When pulls.list() or any sibling's pulls.listFiles() fails the scan is
    incomplete: we cannot prove there is no overlap, so clearing the label would
    silently defeat the merge block.  The contract requires:

    - A scan-completion sentinel (overlapScanComplete / overlapScanHadErrors)
    - Label mutation gated on that sentinel
    - The error path does NOT reach labelsToRemove.add('shared-file-overlap')
      or labelsToAdd.add('shared-file-overlap') unconditionally.
    """
    script = _extract_github_script()

    # The sentinel variables must exist.
    assert "overlapScanComplete" in script, (
        "pr-enrichment must declare overlapScanComplete so API errors do not "
        "silently clear the blocking label."
    )
    assert "overlapScanHadErrors" in script, (
        "pr-enrichment must track per-sibling API errors separately so a partial "
        "scan (some listFiles calls failed) also suppresses label mutation."
    )

    # The label mutation must be guarded by the sentinel.
    # Both labelsToAdd and labelsToRemove for 'shared-file-overlap' must only be
    # reachable inside a block that checks overlapScanComplete.
    overlap_label_block_idx = script.find("overlapScanComplete")
    assert overlap_label_block_idx != -1, (
        "pr-enrichment must gate 'shared-file-overlap' label changes on overlapScanComplete."
    )
    # The guard must appear before the labelsToRemove call for the overlap label.
    remove_idx = script.find("labelsToRemove.add('shared-file-overlap')")
    assert remove_idx != -1, "labelsToRemove.add('shared-file-overlap') must still exist for the success path."
    assert overlap_label_block_idx < remove_idx, (
        "overlapScanComplete guard must appear before labelsToRemove.add('shared-file-overlap') "
        "so the removal is only reached when the scan completed without errors."
    )


def test_project_manager_treats_shared_file_overlap_as_blocking_gate() -> None:
    """The Project Manager must not merge a PR carrying 'shared-file-overlap'.

    This is the enforcement half of the guardrail: pr-enrichment detects the overlap
    and labels the PR; the PM refuses to merge it until the label is removed by the
    Platform Engineer after sequencing the conflicting PRs (issue #58 / ADR-0101).
    """
    project_manager_text = PROJECT_MANAGER_PROMPT.read_text()

    assert "shared-file-overlap" in project_manager_text, (
        "Project Manager prompt must reference the 'shared-file-overlap' label "
        "as a blocking gate so it never merges a PR with an unresolved same-file overlap."
    )
    # The blocking gate section must mention shared-file-overlap alongside the
    # specialist lane labels.
    blocking_section_lower = project_manager_text.lower()
    assert "blocking" in blocking_section_lower, (
        "Project Manager must have an explicit blocking-gate section."
    )


def test_platform_engineer_has_shared_file_overlap_sequencing_instructions() -> None:
    """The Platform Engineer must have explicit instructions for resolving
    'shared-file-overlap' labeled PRs (issue #58 / ADR-0101).

    The PE is the sequencing authority: it picks merge order and removes the label
    from the PR that should land first so the PM can proceed.
    """
    platform_text = PLATFORM_ENGINEER_PROMPT.read_text()

    assert "shared-file-overlap" in platform_text, (
        "Platform Engineer prompt must reference 'shared-file-overlap' so it "
        "knows to handle these PRs during its discovery sweep."
    )
    # The PE should be looking for these PRs in its discovery command
    assert "gh pr list" in platform_text, (
        "Platform Engineer prompt must include a gh pr list command to discover "
        "PRs with the shared-file-overlap label."
    )
