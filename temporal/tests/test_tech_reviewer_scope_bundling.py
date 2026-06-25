"""Regression tests for the Tech Reviewer scope-bundling approval policy.

Covers the behavioral contract introduced with PR #1060 (2026-06-10): the
Tech Reviewer must APPROVE sound work even when a PR bundles otherwise-correct
out-of-scope changes, rather than issuing blanket scope-based rejections that
stall the queue.

Acceptance criteria (issue #1099):
- A focused regression guard for the approve-despite-bundling decision path in
  `.github/agents/tech-reviewer.agent.md`.
- Preservation of the intended queue-recovery behavior without relying on manual
  PR inspection or spot-checking live runs.
"""
from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TECH_REVIEWER_PROMPT = REPO_ROOT / ".github" / "agents" / "tech-reviewer.agent.md"


def _prompt_text() -> str:
    return TECH_REVIEWER_PROMPT.read_text()


# ---------------------------------------------------------------------------
# 1.  Scope bundling: note it, don't wedge on it
# ---------------------------------------------------------------------------


def test_tech_reviewer_approves_sound_work_despite_scope_bundling() -> None:
    """Owner directive (2026-06-10): when a PR bundles extra changes that are
    themselves sound, the Tech Reviewer must verify the extra surface, note the
    bundling in the review body, and APPROVE — never issue a blanket rejection
    based on scope philosophy alone.

    A whole queue of green PRs rejected on scope grounds is a factory failure
    mode, not quality control.
    """
    text = _prompt_text().lower()

    # The prompt must encode the "note it, don't wedge" framing verbatim so the
    # policy intent is unambiguous and survives future edits.
    assert "note it" in text, (
        "Tech Reviewer prompt must include 'note it' in the scope directive so "
        "the approve-despite-bundling policy is explicit."
    )
    assert "wedge" in text, (
        "Tech Reviewer prompt must include 'don't wedge on it' (or equivalent) "
        "to forbid blanket scope rejection."
    )
    # The directive must explicitly instruct approval for sound bundled changes.
    assert "approve" in text, (
        "Tech Reviewer prompt must include an 'approve' instruction in the scope "
        "section so the agent has a clear terminal action for sound bundled PRs."
    )
    # The rationale (review body note) must be part of the instruction.
    assert "review body" in text or "review" in text, (
        "Tech Reviewer prompt must instruct noting the bundling in the review body "
        "so the approval decision is self-documenting."
    )


def test_tech_reviewer_scope_rejection_limited_to_harmful_changes_only() -> None:
    """Scope must only trigger a request-changes verdict when the out-of-scope
    change is actually harmful — breaks something, weakens security/data safety,
    or directly conflicts with other in-flight work.

    Being merely 'out of scope' is not a blocking reason (owner directive
    2026-06-10). This guardrail prevents the queue-starvation failure mode where
    philosophically-correct but operationally-harmful scope policing blocks the
    entire review queue.
    """
    # Normalise whitespace so line-wrapped phrases in the YAML are matched as
    # single-space-separated strings (the source wraps "security/data\n   safety").
    import re as _re
    raw = _prompt_text().lower()
    text = _re.sub(r"\s+", " ", raw)

    assert "harmful" in text, (
        "Tech Reviewer prompt must restrict scope-based rejections to cases where "
        "the out-of-scope change is actually harmful, not merely out of scope."
    )
    assert "breaks something" in text, (
        "Tech Reviewer prompt must name 'breaks something' as a scope-rejection "
        "trigger so harmless bundling is never blocked."
    )
    assert "security" in text, (
        "Tech Reviewer prompt must name 'security' (weakened security/data safety) "
        "as a scope-rejection trigger."
    )
    # "security/data safety" wraps lines in the source file; check the components.
    assert "safety" in text, (
        "Tech Reviewer prompt must name 'data safety' (or 'safety') as a "
        "scope-rejection trigger alongside security."
    )


def test_tech_reviewer_references_2026_06_10_queue_stall_as_scope_policy_rationale() -> None:
    """The scope-approval directive must embed the 2026-06-10 queue-stall as the
    explicit rationale — 121 open PRs, zero approvals — so the policy context
    survives future prompt edits and the antipattern cannot be reinstated silently.
    """
    text = _prompt_text().lower()

    assert "2026-06-10" in text, (
        "Tech Reviewer prompt must reference 2026-06-10 in the scope directive "
        "to preserve the owner rationale against inadvertent removal."
    )
    assert "121" in text, (
        "Tech Reviewer prompt must reference the 121-PR stall as the concrete "
        "scope-rejection antipattern so the policy is self-documenting."
    )
    assert "zero approvals" in text, (
        "Tech Reviewer prompt must reference 'zero approvals' — the outcome of "
        "the 2026-06-10 scope-rejection antipattern — as the policy anchor."
    )


# ---------------------------------------------------------------------------
# 2.  Approve-ready sweep runs first (STEP 0)
# ---------------------------------------------------------------------------


def test_tech_reviewer_approve_ready_sweep_is_step_0_before_deep_review() -> None:
    """The approve-ready fast-pass (STEP 0) must appear in the prompt BEFORE
    any deep per-PR review section.

    Placing the fast-pass first ensures trivially-ready PRs get approved in
    every session, even when a deep review later consumes the rest of the budget.
    Inverting the order would recreate the 'one PR per session' bottleneck that
    starved merge-ready work.
    """
    text = _prompt_text()

    step0_pos = text.find("STEP 0")
    assert step0_pos != -1, (
        "Tech Reviewer prompt must label the approve-ready sweep as 'STEP 0' "
        "so its ordering relative to deep review is unambiguous."
    )

    deep_review_pos = text.find("For each PR (that needs a real review)")
    if deep_review_pos == -1:
        deep_review_pos = text.find("For each PR")
    assert deep_review_pos != -1, (
        "Tech Reviewer prompt must have a 'For each PR' deep-review section."
    )
    assert step0_pos < deep_review_pos, (
        "STEP 0 approve-ready sweep must appear BEFORE the deep per-PR review "
        "section in the Tech Reviewer prompt."
    )


def test_tech_reviewer_approve_ready_sweep_covers_all_queue_review_prs() -> None:
    """The approve-ready sweep must cover ALL open non-draft queue:review PRs,
    not just a fixed first few.

    Covering all of them (not just the first) is what prevents the starvation
    pattern where one long deep-review session blocks the rest of the queue.
    The prompt must also prohibit ending a run with merge-ready PRs unapproved.
    """
    text = _prompt_text().lower()

    # Must instruct covering all, not just the first.
    assert "all" in text or "every" in text, (
        "Tech Reviewer prompt must direct the approve-ready sweep to cover ALL "
        "queue:review PRs, not just the first one encountered."
    )
    # Must prohibit leaving merge-ready PRs unapproved at end of run.
    assert "never end" in text, (
        "Tech Reviewer prompt must prohibit ending a run with merge-ready "
        "queue:review PRs left unapproved."
    )


def test_tech_reviewer_approve_ready_sweep_is_described_as_first_every_run() -> None:
    """The prompt must explicitly mark the approve-ready sweep as the FIRST
    action performed every run, not optional or conditional.

    This ensures the queue-convergence benefit is realised on every execution,
    regardless of how the deeper review sections evolve.
    """
    text = _prompt_text().lower()

    # The prompt must say "do this FIRST" or equivalent near the sweep description.
    assert "do this first" in text or "first, every run" in text, (
        "Tech Reviewer prompt must describe the approve-ready sweep as 'do this "
        "FIRST, every run' so it cannot be deprioritised."
    )
