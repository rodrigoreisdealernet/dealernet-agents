"""Regression tests for the tech-reviewer linked-issue enforcement logic.

Covers the fix introduced in PR #226: the Tech Reviewer must honour
GitHub's ``closingIssuesReferences`` before ever requesting a ``Fixes #N``
PR-body keyword, and must never emit empty linked-issue placeholders.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TECH_REVIEWER_PROMPT = REPO_ROOT / ".github" / "agents" / "tech-reviewer.agent.md"


def _prompt_text() -> str:
    return TECH_REVIEWER_PROMPT.read_text()


# ---------------------------------------------------------------------------
# 1.  The reviewer uses closingIssuesReferences as the authoritative check
# ---------------------------------------------------------------------------


def test_tech_reviewer_checks_closing_issues_references_authoritatively() -> None:
    """The linked-issue section must instruct the agent to query
    ``closingIssuesReferences`` — the GraphQL-resolved set of closing issues —
    not rely solely on body-text scanning for ``Fixes #N``.
    """
    text = _prompt_text()
    assert "closingIssuesReferences" in text, (
        "Tech Reviewer prompt must instruct checking `closingIssuesReferences` "
        "as the authoritative source of linked closing issues."
    )


def test_tech_reviewer_queries_closing_references_before_body_fallback() -> None:
    """The prompt must place the ``closingIssuesReferences`` query instruction
    before the body-fallback instruction so the agent evaluates it first.
    """
    text = _prompt_text()
    closing_ref_pos = text.find("closingIssuesReferences")
    body_fallback_pos = text.find("gh pr view <number> --json body")
    assert closing_ref_pos != -1, "closingIssuesReferences instruction must be present."
    assert body_fallback_pos != -1, "body fallback instruction must be present."
    assert closing_ref_pos < body_fallback_pos, (
        "The `closingIssuesReferences` check must appear before the body-grep "
        "fallback in the Tech Reviewer prompt."
    )


def test_tech_reviewer_body_fallback_only_when_closing_references_empty() -> None:
    """The fallback to body scanning must be gated on ``closingIssuesReferences``
    being empty — not an unconditional grep.
    """
    text = _prompt_text()
    # The condition should appear on the same logical instruction line / sentence
    # as the body-fallback directive.
    lower = text.lower()
    # Find the paragraph that contains the body-fallback instruction
    body_fallback_idx = lower.find("gh pr view <number> --json body")
    assert body_fallback_idx != -1, "body fallback instruction must be present."
    # Extract surrounding context (up to 400 chars either side)
    context = lower[max(0, body_fallback_idx - 400) : body_fallback_idx + 200]
    assert "empty" in context or "is empty" in context or "if `closingissuesreferences` is empty" in context, (
        "The body-grep fallback must be conditional on `closingIssuesReferences` "
        "being empty, not applied unconditionally."
    )


# ---------------------------------------------------------------------------
# 2.  The reviewer does NOT nag when closingIssuesReferences is non-empty
# ---------------------------------------------------------------------------


def test_tech_reviewer_does_not_request_fixes_keyword_when_already_linked() -> None:
    """When ``closingIssuesReferences`` is non-empty the reviewer must NOT
    request a ``Fixes #N`` body edit — doing so would be a false-positive nag
    that wedges already-linked Copilot PRs.
    """
    text = _prompt_text()
    lower = text.lower()
    assert "do not request" in lower or "do not" in lower, (
        "Tech Reviewer prompt must contain a 'do not request' guard against "
        "nagging PRs that are already linked via closingIssuesReferences."
    )
    # The guard must be specifically tied to closingIssuesReferences being non-empty
    closing_ref_pos = lower.find("closingissuesreferences")
    do_not_pos = lower.find("do not request")
    if do_not_pos == -1:
        # Try the bold variant
        do_not_pos = lower.find("do not")
    assert closing_ref_pos != -1 and do_not_pos != -1
    # At least one "do not" instruction must appear within 600 chars of a
    # closingIssuesReferences mention — i.e. they are logically connected.
    found_nearby = False
    search_start = 0
    while True:
        idx = lower.find("closingissuesreferences", search_start)
        if idx == -1:
            break
        window = lower[idx : idx + 600]
        if "do not" in window:
            found_nearby = True
            break
        search_start = idx + 1
    assert found_nearby, (
        "The 'do not (request)' guard must appear in close proximity to the "
        "`closingIssuesReferences` instruction so that its scope is clear."
    )


def test_tech_reviewer_flags_missing_link_only_when_genuinely_empty() -> None:
    """The prompt must restrict the 'flag missing linked issue' action to the
    case where ``closingIssuesReferences`` is **genuinely empty**, not just
    because a ``Fixes #N`` keyword is absent from the body.
    """
    text = _prompt_text()
    lower = text.lower()
    assert "genuinely empty" in lower, (
        "Tech Reviewer prompt must use the phrase 'genuinely empty' (or equivalent) "
        "to restrict missing-link complaints to PRs with no resolved closing reference."
    )


# ---------------------------------------------------------------------------
# 3.  The reviewer prompt is free of empty linked-issue placeholder text
# ---------------------------------------------------------------------------


def test_tech_reviewer_prompt_has_no_empty_linked_issue_placeholders() -> None:
    """The prompt must not contain stale empty-placeholder patterns such as
    ``(  /  )`` that appeared in review output before the fix — evidence of a
    template that was never filled in.
    """
    text = _prompt_text()
    # Match patterns like "(  /  )", "( / )", "(/ )", "( /)", etc.
    empty_placeholder_pattern = re.compile(r"\(\s*/\s*\)")
    matches = empty_placeholder_pattern.findall(text)
    assert not matches, (
        f"Tech Reviewer prompt contains empty linked-issue placeholder(s): {matches!r}. "
        "These must not appear in reviewer output."
    )


def test_tech_reviewer_prompt_has_no_unfilled_template_variables() -> None:
    """No ``{{ variable }}`` mustache placeholders should remain unresolved in
    the linked-issue enforcement section (except for the standard Jinja
    template variables that the agent runtime resolves like ``owner``, ``repo``,
    ``run_url``).
    """
    text = _prompt_text()
    known_runtime_vars = {"owner", "repo", "run_url", "default_branch"}
    placeholder_re = re.compile(r"\{\{\s*(\w+)\s*\}\}")
    unknowns = {m.group(1) for m in placeholder_re.finditer(text) if m.group(1) not in known_runtime_vars}
    assert not unknowns, (
        f"Tech Reviewer prompt contains unknown/unfilled template variables: {unknowns!r}. "
        "Only standard runtime variables are allowed."
    )
