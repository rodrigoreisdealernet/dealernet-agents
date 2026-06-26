---
name: ship-issue
description: Run the repository issue-to-merge pipeline for one GitHub issue in Codex, using `.claude/commands/ship-issue.md` as the authoritative workflow. Use when the user asks for `$ship-issue`, "ship issue", `/ship-issue`, or wants to take one issue through spec, approval gate, code, tests, reviews, and PR while preserving the existing Claude rules.
---

# Ship Issue

## Overview

Execute the same single-issue delivery workflow defined for Claude, adapted to
Codex surfaces. The source of truth is `.claude/commands/ship-issue.md`; do not
reimplement or reinterpret the pipeline from memory.

## Workflow

1. Read `.claude/commands/ship-issue.md` end to end before taking any pipeline
   action.
2. Treat the user's text after `$ship-issue` as the Claude command's
   `$ARGUMENTS`.
3. Follow the Claude command exactly unless Codex platform mechanics require a
   direct tool-name adaptation.
4. Keep `.claude/` intact. Do not edit Claude commands, agents, or settings
   while executing this skill unless the user explicitly asks to modify the
   Claude setup.
5. Preserve every gate, dashboard update, worktree rule, repo gotcha, dry-run
   behavior, PR behavior, and stop condition from the Claude command.

## Codex Adaptation

- When the Claude command says to invoke the `spec`, `coder`, `tester`, or
  `reviewer` role, spawn the matching Codex project agent from `.codex/agents/`
  when available.
- If a named project agent is unavailable, use Codex `explorer` for read-only
  roles (`spec`, `reviewer`) and Codex `worker` for editing roles (`coder`,
  `tester`), passing the role file path and concrete inputs explicitly.
- When passing role instructions, always tell the subagent to read the matching
  `.claude/agents/<role>.agent.md` file first and to treat that file as
  authoritative.
- Translate Claude tool names to the equivalent Codex actions: file reads,
  `rg` searches, shell commands, `apply_patch` edits, GitHub CLI calls, and
  Codex subagent spawning.
- Subagents have isolated context. Pass every required path, issue number,
  dashboard base path, worktree path, PR number, mode, and constraint
  explicitly, matching the Claude command.

## Required Inputs

Require the same arguments as `.claude/commands/ship-issue.md`:

- `<issue-number>`
- optional `--approved`
- optional `--dry-run`

If the issue number is missing, ask for it before doing any GitHub or filesystem
side effects.
