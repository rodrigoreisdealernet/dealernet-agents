---
description: Run the issue-to-merge pipeline — spec → approve → code → tests → test-review → code-review → PR. Humans gate only at spec approval and merge.
argument-hint: "<issue-number> [--approved] [--dry-run]"
---

You are now running the **issue-to-merge pipeline** (`/ship-issue`) against this
repository. This is the Day 2 / Session 4 capstone: filing an issue produces a
spec, then code, tests, a test review, and a code review — with humans stepping
in at only **two** moments: approving the spec and merging the PR.

> **Agents are the workers. Workflows chain them.** This command is the workflow.
> The four roles live in `.claude/agents/`: `spec`, `coder`, `tester`, `reviewer`.
> See **How agents are spawned** below for exactly how to run each one.

## How agents are spawned (important)

The files in `.claude/agents/` are **role specifications**, not reliable custom
`subagent_type`s in this environment — custom agent types here often fail to
invoke their tools. So wherever a step says "invoke the **`<role>`** subagent",
do this instead:

- **Spawn a built-in agent** with the Agent tool:
  - `coder`, `tester` → `subagent_type: general-purpose` (they read, edit, write, run bash).
  - `spec`, `reviewer` → `subagent_type: Explore` (read-only — Explore reads, greps,
    globs, and runs bash for `gh`, but cannot edit; exactly what these roles need).
- **Inject the role**: tell the subagent to first read its role file
  `.claude/agents/<role>.agent.md` and follow it, then give it the concrete inputs
  for this run (issue number/body, spec path, diff, PR number, reviewer mode, etc.).
  The subagent runs in an isolated context, so pass every path and value explicitly
  — never assume it can see this conversation.
- **Live progress (required)**: the orchestrator is *blocked* while a subagent
  runs, so it cannot update the dashboard mid-step. Therefore **pass the dashboard
  base path** (`docs/ship-issue/<issue-number>-<slug>`) to every subagent and
  instruct it to post short progress notes to the dashboard **as it works** (the
  built-in agents have Bash and repo access):
  `node .github/scripts/ship-issue-dashboard.mjs set <base> <stepId> running --note "<what I'm doing now>"`
  — once when it starts and again at each meaningful milestone (e.g. "reading
  index.tsx", "writing unit tests", "running vitest", "posting PR review"). Each
  call re-renders the HTML, so a watcher sees the step advance in real time instead
  of a frozen "running". The orchestrator still owns the `running`→`done` boundary
  transitions; the subagent only appends notes (never sets `done`/`failed`).

## Arguments

Parse `$ARGUMENTS`:
- **`<issue-number>`** (required) — the GitHub issue this pipeline ships.
- **`--approved`** — signals that a human has approved the draft spec. Without
  this flag the pipeline **stops at the spec gate** (step 02) and does not
  implement anything.
- **`--dry-run`** — walk the whole chain but make **no** commits, no PR, and post
  nothing; just print each artifact so the flow can be inspected. The status
  dashboard is **still** generated and updated (it is a local artifact, not a
  side effect on GitHub).

## The pipeline

```
ISSUE ─▶ 01 SPEC ─▶ 02 APPROVE ─▶ 03 CODE ─▶ 04 TESTS ─▶ 05 TEST REVIEW ─▶ 06 CODE REVIEW ─▶ MERGE
FILED    (spec)     human gate    (coder)    (tester)    (reviewer:tests)   (reviewer:diff)    human
```

Run the steps **in order**. Each agent hands its output to the next. Post every
artifact to the issue/PR so the run is fully traceable.

## Status dashboard (always on)

Every run **must** produce a live HTML status page so a dev/architect can follow
it step by step — this happens on **every** run, including `--dry-run`. The page
is driven by `.github/scripts/ship-issue-dashboard.mjs` (a dependency-free Node
script); you never hand-write HTML or JSON. Use a single base path per issue:

```
docs/ship-issue/<issue-number>-<slug>
```

The script maintains `<base>.json` (the status model) and re-renders
`<base>.html` after every change. Drive it with three commands:

- **init** — once, in Setup:
  `node .github/scripts/ship-issue-dashboard.mjs init <base> --issue <n> --title "<title>" --slug <slug> --branch <branch> --issue-url <url>`
- **set** — at every step transition (mark `running` when a step starts, then
  `done`/`failed`/`waiting`/`skipped` when it ends), attaching artifacts as they
  appear:
  `node .github/scripts/ship-issue-dashboard.mjs set <base> <stepId> <status> [--summary "..."] [--artifact "Label=href" ...] [--pr <n> --pr-url <url>] [--gate spec-approval|merge|none]`
- **render** — only if you need to force a re-render without a state change.

Step ids: `spec`, `approve`, `code`, `tests`, `test-review`, `code-review`,
`merge`. Statuses: `pending`, `running`, `done`, `waiting`, `failed`, `skipped`.
Print the path to `<base>.html` when you start so the user can open it and watch
it auto-refresh.

### Setup

1. Fetch the issue: `gh issue view <issue-number>`. Derive a short slug from the
   title.
2. Create and checkout the feature branch `feature/<issue-number>-<slug>` (skip
   on `--dry-run`).
3. **Initialize the status dashboard** (always, including `--dry-run`):
   `node .github/scripts/ship-issue-dashboard.mjs init docs/ship-issue/<issue-number>-<slug> --issue <issue-number> --title "<issue title>" --slug <slug> --branch feature/<issue-number>-<slug> --issue-url <issue url>`.
   Print the returned `.html` path to the user.

### Step 01 — SPEC  *(agent: `spec`)*

3. Dashboard: `set <base> spec running`.
4. Invoke the **`spec`** subagent with the issue number and body. It returns a
   short, testable spec (Overview, Problem/Context, 3–6 acceptance criteria in
   customer language, Non-Goals, Out-of-scope).
5. Save it to `docs/specs/<issue-number>-<slug>.md` and post it as a comment on
   the issue (skip writes on `--dry-run`).
6. Dashboard: `set <base> spec done --summary "<n> acceptance criteria drafted" --artifact "Spec=docs/specs/<issue-number>-<slug>.md"`.

### Step 02 — APPROVE  🚧 **HUMAN GATE #1**

5. If `--approved` was **not** passed: set the gate
   (`set <base> approve waiting --gate spec-approval`), then **STOP HERE.** Print
   the spec, the dashboard `.html` path, and this instruction, then end the run —
   do not proceed to any agent:

   > Spec drafted for issue #`<n>`. Review it, then re-run
   > `/ship-issue <n> --approved` to ship it, or comment your notes on the issue
   > to send it back.

   This is the first of only two human moments. **Never** auto-approve.
6. If `--approved` was passed, record the approval and clear the gate:
   `set <base> approve done --summary "Spec approved by human" --gate none`, then
   continue.

### Step 03 — CODE  *(agent: `coder`)*

7. Dashboard: `set <base> code running`. Invoke the **`coder`** subagent,
   pointing it at the approved spec file `docs/specs/<issue-number>-<slug>.md`
   (pass the path explicitly — the subagent runs in an isolated context and
   cannot see this conversation). It implements the minimal change that satisfies
   the acceptance criteria and confirms the build compiles. Commit the diff (skip
   on `--dry-run`). Then `set <base> code done --summary "<files changed>"`.

### Step 04 — TESTS  *(agent: `tester`)*

8. Dashboard: `set <base> tests running`. Invoke the **`tester`** subagent with
   the coder's diff and the approved spec file `docs/specs/<issue-number>-<slug>.md`
   (pass both explicitly — the subagent runs in an isolated context). It generates
   the unit / integration / e2e tests and runs them green. Commit the tests, then
   open a **draft PR** with `gh pr create`, linking the issue and the spec file
   (skip on `--dry-run`). Record the PR on the dashboard and close the step:
   `set <base> tests done --summary "<test counts>" --pr <pr-number> --pr-url <pr-url>`.

### Step 05 — TEST REVIEW  *(agent: `reviewer`, mode `tests`)*  ⟲

9. Dashboard: `set <base> test-review running`. Invoke the **`reviewer`**
   subagent in mode **`tests`**. It reports coverage gaps, vanity tests, and weak
   assertions. Post the findings on the PR.
10. **Loop:** if it flags real problems, send them back to the **`tester`** and
    re-review. Allow **at most 2 iterations**; if still unresolved after the
    second pass, `set <base> test-review failed --note "<what is unresolved>"`,
    escalate to a human with a written summary, and stop. On success,
    `set <base> test-review done --summary "<iterations> iteration(s)"`.

### Step 06 — CODE REVIEW  *(agent: `reviewer`, mode `diff`)*

11. Dashboard: `set <base> code-review running`. Invoke the **`reviewer`**
    subagent in mode **`diff`**. It reviews the full diff for correctness,
    security, and regression risk and **posts the review on the PR**
    (`gh pr review`). Mark the PR ready for review (`gh pr ready`). Then
    `set <base> code-review done --summary "<verdict>" --artifact "PR review=<pr-url>"`.

### MERGE  🚧 **HUMAN GATE #2**

12. Dashboard: `set <base> merge waiting --gate merge`. **STOP.** Do **not**
    merge. Print the dashboard `.html` path and the links — issue, spec, diff,
    tests, test review, code review — and this instruction:

    > Pipeline complete for issue #`<n>`. PR: `<url>`. Read the review and merge
    > when you're satisfied. This is the second and final human moment.

## When you finish

Print a one-line summary: the issue number, the PR URL, how many test-review
iterations ran, which gate the pipeline is waiting on (`spec approval` or
`merge`), and the path to the status dashboard
`docs/ship-issue/<issue-number>-<slug>.html`.
