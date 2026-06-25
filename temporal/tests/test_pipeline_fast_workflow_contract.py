from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "pipeline-fast.yml"


def _extract_step_run_script(step_name: str) -> str:
    lines = WORKFLOW_PATH.read_text().splitlines()
    marker = f"- name: {step_name}"
    step_index = next((i for i, line in enumerate(lines) if line.strip() == marker), None)
    assert step_index is not None, f"Unable to locate workflow step `{step_name}`."

    run_index = next((i for i in range(step_index + 1, len(lines)) if lines[i].strip() == "run: |"), None)
    assert run_index is not None, f"Unable to locate `run: |` block for step `{step_name}`."

    marker_indent = len(lines[run_index]) - len(lines[run_index].lstrip(" "))
    content_indent = marker_indent + 2
    script_lines: list[str] = []

    for line in lines[run_index + 1 :]:
        if line.startswith(" " * content_indent):
            script_lines.append(line[content_indent:])
            continue
        if line.strip() == "":
            script_lines.append("")
            continue
        break

    return "\n".join(script_lines)


def _extract_on_block() -> list[str]:
    lines = WORKFLOW_PATH.read_text().splitlines()
    on_index = next((i for i, line in enumerate(lines) if line.strip() == "on:"), None)
    assert on_index is not None, "Unable to locate `on:` block."

    block: list[str] = []
    for line in lines[on_index + 1 :]:
        if line and not line.startswith(" "):
            break
        block.append(line)
    return block


def test_pipeline_fast_documents_single_pass_contract() -> None:
    workflow_text = WORKFLOW_PATH.read_text()

    assert "Runs a SINGLE pass per scheduled invocation (no long-running loop)" in workflow_text
    assert "Fast pipeline pass (single sweep)" in workflow_text


def test_pipeline_fast_trigger_surface_is_timer_only() -> None:
    """pipeline-fast must run on schedule + workflow_dispatch only.
    The workflow_run trigger was intentionally removed (2026-06-08) because
    it caused self-cancellation thrash (69% of runs cancelled) that starved
    the PR review queue. Do NOT reintroduce event-driven triggering."""
    on_block = _extract_on_block()
    on_text = "\n".join(on_block)

    assert "schedule:" in on_text
    assert "workflow_dispatch:" in on_text
    # Event-driven triggers must NOT be present.
    assert "workflow_run:" not in on_text, (
        "workflow_run trigger was intentionally removed — it caused self-cancellation thrash. "
        "Shorten the cron interval instead of reintroducing event-driven triggering."
    )
    assert "push:" not in on_text
    assert "pull_request:" not in on_text


def test_pipeline_fast_concurrency_is_single_group_no_cancel() -> None:
    """Timer-only pipeline must use a single concurrency group with
    cancel-in-progress: false so scheduled runs queue rather than cancel."""
    workflow_text = WORKFLOW_PATH.read_text()

    # Single fixed group name (no per-branch/event expression).
    # Check group and value are present (robust to whitespace variations).
    assert re.search(r"^\s*group:\s*pipeline-fast\s*$", workflow_text, re.MULTILINE), (
        "Concurrency group must be the fixed string 'pipeline-fast' (not per-branch/event)."
    )
    assert "cancel-in-progress: false" in workflow_text


def test_pipeline_fast_job_has_60_minute_timeout() -> None:
    """Job must have a hard 1-hour self-terminate cap."""
    workflow_text = WORKFLOW_PATH.read_text()
    assert "timeout-minutes: 60" in workflow_text


def test_pipeline_fast_single_pass_script_has_no_inner_looping() -> None:
    script = _extract_step_run_script("Fast pipeline pass (single sweep)")

    assert "set -uo pipefail" in script
    assert 'run_stage "enrich-triage (Product Owner)" "product-owner"' in script
    # The per-PR loop lives in run-pr-pipeline.ts (TypeScript), NOT in this shell
    # script. The shell stays a single sweep — no shell loop/sleep constructs.
    assert not re.search(r"^\s*(while|until|for)\b", script, re.MULTILINE), (
        "Fast pipeline pass must execute one sweep per run; shell loop constructs reintroduce multi-pass behavior."
    )
    assert not re.search(r"^\s*sleep\s+\d+", script, re.MULTILINE), (
        "Fast pipeline pass must not include internal sleep-based cadence loops."
    )


def test_pipeline_fast_wires_tech_reviewer_and_defers_pr_loop_to_dedicated_workflow() -> None:
    """The Tech Reviewer is the engineering APPROVER and MUST run as its own
    bounded stage: the PM merges on its `APPROVED` verdict, so without this stage
    every PR routed to `queue:review` dead-letters (no agent ever produces the
    approval).

    The per-PR loop does NOT live here any more (2026-06-10): as a tail stage of
    this shared 60-minute job it got ~15 sessions per pass and the queue grew to
    121 open PRs. It moved to the dedicated pr-loop.yml workflow (own concurrency
    group, multi-hour budget, one SDK session per open PR). The retired monolithic
    `merge-assign` Project Manager stage must also stay gone."""
    script = _extract_step_run_script("Fast pipeline pass (single sweep)")

    assert 'run_stage "tech-review (Tech Reviewer)" "tech-reviewer"' in script
    # The per-PR loop must NOT be re-embedded here — it starves at queue scale.
    assert "run-pr-pipeline.ts" not in script, (
        "The per-PR loop lives in pr-loop.yml (dedicated workflow with a whole-queue "
        "budget); embedding it back into the shared 60-minute pipeline-fast job caps "
        "it at ~15 PR sessions per pass and the queue grows unboundedly."
    )
    assert 'run_stage "merge-assign (Project Manager)" "project-manager"' not in script


def test_pipeline_fast_stage_order_lanes_then_reviewer() -> None:
    """Specialist lanes must clear their needs-* labels BEFORE the Tech Reviewer
    sweeps, so a lane-blocked PR can be approved in the same pass."""
    script = _extract_step_run_script("Fast pipeline pass (single sweep)")
    ordered_markers = [
        'run_stage "enrich-triage (Product Owner)" "product-owner"',
        'if labeled_work_exists "needs-database-review" "queue:database"; then',
        'run_stage "db-steward (Database Steward)" "database-steward"',
        'if labeled_work_exists "needs-security-review" "queue:security"; then',
        'run_stage "security-review (Security Reviewer)" "security-reviewer"',
        'if labeled_work_exists "needs-platform-review" "queue:platform"; then',
        'run_stage "platform (Platform Engineer)" "platform-engineer"',
        'run_stage "tech-review (Tech Reviewer)" "tech-reviewer"',
    ]

    cursor = -1
    for marker in ordered_markers:
        next_cursor = script.find(marker, cursor + 1)
        assert next_cursor != -1, f"Missing or out-of-order stage marker: {marker}"
        assert next_cursor > cursor, f"Out-of-order stage marker: {marker}"
        cursor = next_cursor


PR_LOOP_PATH = REPO_ROOT / ".github" / "workflows" / "pr-loop.yml"


def test_pr_loop_workflow_is_the_dedicated_per_pr_agentic_loop() -> None:
    """Owner-mandated architecture (2026-06-10): a real workflow provides the
    coded structure that loops over every open PR, invoking the Copilot SDK once
    per PR with the project-manager agent prompt. It must have its OWN concurrency
    group (so multi-hour sweeps never block the 15-minute agent cadence), queue
    rather than cancel, and carry a whole-queue budget."""
    text = PR_LOOP_PATH.read_text()

    assert "src/run-pr-pipeline.ts" in text, "pr-loop must invoke the per-PR loop orchestrator."
    assert re.search(r"^\s*group:\s*pr-loop\s*$", text, re.MULTILINE), (
        "pr-loop needs its own fixed concurrency group, independent of pipeline-fast."
    )
    assert "cancel-in-progress: false" in text
    assert "schedule:" in text and "workflow_dispatch:" in text
    # Event-driven sweep (2026-06-12): GitHub throttles the */30 cron to
    # ~75-100 min between firings while a sweep takes only minutes, so the
    # cron alone leaves every CI-green PR waiting most of an hour to merge.
    # workflow_run on CI completion + the queue-don't-cancel group above is
    # the proven agent-tech-reviewer coalescing pattern (at most one running
    # + one pending sweep). NOTE: pipeline-fast stays timer-only — its thrash
    # came from cancel-in-progress: true, which pr-loop does not use.
    assert "workflow_run:" in text, (
        "pr-loop must keep its event-driven workflow_run trigger — without it "
        "every CI completion waits for a throttled cron tick before the queue "
        "is swept (merge latency regressed to ~80 min per step on 2026-06-12)."
    )
    assert 'workflows: ["Build Images"]' in text
    # Whole-queue budget: the job cap and loop budget must be multi-hour.
    timeout = re.search(r"timeout-minutes:\s*(\d+)", text)
    assert timeout is not None and int(timeout.group(1)) >= 120, (
        "pr-loop must carry a multi-hour job budget so a full-queue sweep "
        "(one session per open PR) is never truncated to a dozen PRs."
    )
    budget = re.search(r"PR_PIPELINE_BUDGET_MIN:\s*'(\d+)'", text)
    assert budget is not None and int(budget.group(1)) >= 120

    # Same step-scoped credential posture as the cadence pipelines.
    assert "persist-credentials: false" in text
    assert "token: ${{ secrets.PROJECT_MANAGER_PAT }}" not in text
    assert (
        'git config --local url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf'
        in text
    )


def test_pr_loop_ci_retrigger_cap_wakes_whole_dark_queue_in_one_sweep() -> None:
    """CI_RETRIGGER_CAP must be high enough (>=75) to wake an entire dark queue
    in a SINGLE pr-loop pass.

    A 'dark queue' is a set of Copilot-authored PRs gated at action_required
    with zero reported checks — they can never go green, be readied, or be
    approved until a trusted-actor push clears the gate. A low cap (e.g. 10)
    rations that wakeup across many runs: PRs at the back of the queue wait
    hours for their first CI result, the review queue stalls, and the open
    Copilot PR count grows unboundedly.

    CI runs queue on GitHub's infrastructure once triggered, so waking more
    heads per pass costs nothing extra. The cap must never ration the dark-queue
    wakeup across multiple sweeps.
    """
    text = PR_LOOP_PATH.read_text()
    cap_match = re.search(r"CI_RETRIGGER_CAP:\s*'(\d+)'", text)
    assert cap_match is not None, (
        "pr-loop.yml must set CI_RETRIGGER_CAP so the dark-queue wakeup is "
        "bounded and explicit."
    )
    cap = int(cap_match.group(1))
    assert cap >= 75, (
        f"CI_RETRIGGER_CAP is {cap} — must be >=75 so a full dark queue is woken "
        "in ONE sweep, not rationed over multiple hourly runs."
    )


def _extract_pr_loop_run_script() -> str:
    """Extract the shell script body from the 'Per-PR loop' step in pr-loop.yml."""
    lines = PR_LOOP_PATH.read_text().splitlines()
    step_marker = "- name: Per-PR loop (one agent session per open PR)"
    step_index = next(
        (i for i, line in enumerate(lines) if line.strip() == step_marker), None
    )
    assert step_index is not None, f"Unable to find pr-loop step: {step_marker}"

    run_index = next(
        (i for i in range(step_index + 1, len(lines)) if lines[i].strip() == "run: |"),
        None,
    )
    assert run_index is not None, "Unable to locate `run: |` block in the per-PR loop step."

    marker_indent = len(lines[run_index]) - len(lines[run_index].lstrip(" "))
    content_indent = marker_indent + 2
    script_lines: list[str] = []
    for line in lines[run_index + 1 :]:
        if line.startswith(" " * content_indent):
            script_lines.append(line[content_indent:])
        elif line.strip() == "":
            script_lines.append("")
        else:
            break
    return "\n".join(script_lines)


def test_pr_loop_run_step_has_no_shell_loop_constructs() -> None:
    """The shell run step in pr-loop must not contain while/for/until loop
    constructs.

    The per-PR looping lives in run-pr-pipeline.ts (TypeScript). Re-embedding
    a shell loop would recreate the 'oldest dozen per pass' starvation pattern
    that caused the queue to reach 121 open PRs — each shell-looped pass
    would touch only as many PRs as fit inside the loop timeout, leaving the
    rest unstalled indefinitely.

    Any timeout wrapper (e.g. the POSIX `timeout` command) is fine; only
    looping constructs that iterate PRs are prohibited.
    """
    script = _extract_pr_loop_run_script()

    assert not re.search(r"^\s*(while|until|for)\b", script, re.MULTILINE), (
        "pr-loop run step must not contain shell loop constructs. "
        "The per-PR loop lives in run-pr-pipeline.ts so a full-queue sweep "
        "is never capped at the shell level."
    )
    assert not re.search(r"^\s*sleep\s+\d+", script, re.MULTILINE), (
        "pr-loop run step must not use sleep-based cadence loops."
    )
    # The TypeScript orchestrator must still be the entry point.
    assert "src/run-pr-pipeline.ts" in script, (
        "pr-loop run step must invoke src/run-pr-pipeline.ts as the per-PR loop orchestrator."
    )


def test_cadence_pipelines_checkout_uses_persist_credentials_false() -> None:
    """Every cadence pipeline must check out with persist-credentials: false.

    Security guard: persisting PROJECT_MANAGER_PAT through actions/checkout exposes the
    write-capable token to all steps for the full job duration. Checkout must use
    persist-credentials: false; the PAT is injected only in the narrow re-trigger push
    path (pipeline-fast) via GH_TOKEN already scoped to that step.
    """
    workflows_dir = REPO_ROOT / ".github" / "workflows"
    for name in ("pipeline-fast.yml", "pipeline-hourly.yml", "pipeline-daily.yml"):
        text = (workflows_dir / name).read_text()
        assert "actions/checkout@v4" in text, f"{name}: expected a checkout step"
        assert "persist-credentials: false" in text, (
            f"{name}: checkout must use persist-credentials: false — do not bake "
            f"PROJECT_MANAGER_PAT into the git credential store for the full job."
        )
        assert "token: ${{ secrets.PROJECT_MANAGER_PAT }}" not in text, (
            f"{name}: PROJECT_MANAGER_PAT must not be set on actions/checkout — "
            f"inject it only in the narrow step that performs the re-trigger push."
        )


def test_pipeline_fast_injects_git_credential_in_push_step() -> None:
    """pipeline-fast must configure git credentials inside the push step, not at checkout.

    The write-capable PAT (GH_TOKEN) is injected via git URL rewrite at the start of the
    'Fast pipeline pass' step so only that step's push operations have write access.
    """
    script = _extract_step_run_script("Fast pipeline pass (single sweep)")
    expected = (
        'git config --local url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf'
        ' "https://github.com/"'
    )
    assert expected in script, (
        "Fast pipeline pass must configure git credentials via GH_TOKEN at the step level "
        "(--local, scoped to current repo), not via a checkout-persisted token for the full job."
    )


def test_pipeline_fast_cron_schedule_is_15_minute_single_pass_with_manual_dispatch() -> None:
    on_text = "\n".join(_extract_on_block())

    assert "- cron: '*/15 * * * *'" in on_text
    assert "workflow_dispatch:" in on_text


def test_pipeline_fast_specialist_label_queue_gates_are_exact() -> None:
    script = _extract_step_run_script("Fast pipeline pass (single sweep)")

    assert script.count('if labeled_work_exists "needs-database-review" "queue:database"; then') == 1
    assert script.count('run_stage "db-steward (Database Steward)" "database-steward"') == 1

    assert script.count('if labeled_work_exists "needs-security-review" "queue:security"; then') == 1
    assert script.count('run_stage "security-review (Security Reviewer)" "security-reviewer"') == 1

    assert script.count('if labeled_work_exists "needs-platform-review" "queue:platform"; then') == 1
    assert script.count('run_stage "platform (Platform Engineer)" "platform-engineer"') == 1
