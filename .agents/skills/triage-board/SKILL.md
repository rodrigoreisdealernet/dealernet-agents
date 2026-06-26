---
name: triage-board
description: Audit and repair GitHub project board hierarchy and metadata gaps in Codex, using `.claude/commands/triage-board.md` as the authoritative workflow. Use when the user asks for `$triage-board`, "triage board", `/triage-board`, or wants to detect orphaned issues, missing project items, missing fields, duplicate epics, or stale parent links while preserving the existing Claude rules.
---

# Triage Board

## Overview

Execute the same GitHub project board triage workflow defined for Claude,
adapted to Codex surfaces. The source of truth is
`.claude/commands/triage-board.md`; do not reimplement or reinterpret the
workflow from memory.

## Workflow

1. Read `.claude/commands/triage-board.md` end to end before taking any GitHub
   action.
2. Treat the user's text after `$triage-board` as the Claude command's
   `$ARGUMENTS`.
3. Follow the Claude command exactly unless Codex platform mechanics require a
   direct tool-name adaptation.
4. Keep `.claude/` intact. Do not edit Claude commands, agents, or settings
   while executing this skill unless the user explicitly asks to modify the
   Claude setup.
5. Preserve the Claude command's audit phases, fix phases, dry-run behavior,
   default repo/project values, field IDs, epic mappings, output report, and
   "needs human review" boundaries.

## Supported Arguments

Accept the same forms as `.claude/commands/triage-board.md`:

- no arguments
- `--repo <owner/name> --project <number>`
- `--dry-run`

If the user omits repo/project arguments, use the Claude command defaults.
