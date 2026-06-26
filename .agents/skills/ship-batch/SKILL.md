---
name: ship-batch
description: Run the repository batch issue-to-merge pipeline in Codex, using `.claude/commands/ship-batch.md` as the authoritative workflow. Use when the user asks for `$ship-batch`, "ship batch", `/ship-batch`, or wants to ship multiple GitHub issues with isolated worktrees, dependency waves, reviews, and a serial merge queue while preserving the existing Claude rules.
---

# Ship Batch

## Overview

Execute the same multi-issue batch workflow defined for Claude, adapted to
Codex surfaces. The source of truth is `.claude/commands/ship-batch.md`; do not
reimplement or reinterpret the batch pipeline from memory.

## Workflow

1. Read `.claude/commands/ship-batch.md` end to end before taking any batch
   action.
2. Treat the user's text after `$ship-batch` as the Claude command's
   `$ARGUMENTS`.
3. Follow the Claude command exactly unless Codex platform mechanics require a
   direct tool-name adaptation.
4. Keep `.claude/` intact. Do not edit Claude commands, agents, or settings
   while executing this skill unless the user explicitly asks to modify the
   Claude setup.
5. Preserve every environment constraint, worktree rule, wave/dependency rule,
   database serialization rule, migration timestamp rule, dashboard behavior,
   PR behavior, human gate, merge queue rule, Phase 4 validation, and recovery
   command from the Claude command.

## Codex Adaptation

- The Claude batch command uses nested delegation: batch orchestrator -> one
  issue-agent per issue -> role subagents. Project config in `.codex/config.toml`
  raises Codex subagent depth for this workflow.
- For each issue-agent, spawn a Codex `worker` or equivalent writable agent.
  Instruct it to read `.claude/commands/ship-issue.md` and run that pipeline
  inside its assigned worktree, applying the batch-specific overrides from
  `.claude/commands/ship-batch.md`.
- When an issue-agent needs role workers, use the matching Codex project agent
  from `.codex/agents/` when available.
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
  dashboard base path, worktree path, PR number, mode, wave, dependency,
  migration timestamp, and constraint explicitly, matching the Claude command.

## Supported Arguments

Accept the same arguments as `.claude/commands/ship-batch.md`:

- optional `--only <list>`
- optional `--label <name>`
- optional `--dry-run`

If the user does not provide filters, run the full batch plan exactly as the
Claude command specifies.
