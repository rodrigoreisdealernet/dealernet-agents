---
name: assign-copilot
description: Assign the GitHub Copilot coding agent to an issue in Codex, using `.claude/commands/assign-copilot.md` as the authoritative workflow. Use when the user asks for `$assign-copilot`, "assign Copilot", `/assign-copilot`, or wants Copilot assigned to a GitHub issue while preserving the existing Claude command rules.
---

# Assign Copilot

## Overview

Execute the same Copilot assignment command defined for Claude, adapted to
Codex surfaces. The source of truth is `.claude/commands/assign-copilot.md`;
do not reimplement or reinterpret the command from memory.

## Workflow

1. Read `.claude/commands/assign-copilot.md` end to end before taking any
   GitHub action.
2. Treat the user's text after `$assign-copilot` as the Claude command's
   `$ARGUMENTS`.
3. Follow the Claude command exactly unless Codex platform mechanics require a
   direct tool-name adaptation.
4. Keep `.claude/` intact. Do not edit Claude commands, agents, or settings
   while executing this skill unless the user explicitly asks to modify the
   Claude setup.
5. Use the GitHub CLI command from the Claude command as the operational
   implementation.

## Required Inputs

Require the same argument as `.claude/commands/assign-copilot.md`:

- `<issue-number>`

If the issue number is missing, ask for it before calling `gh`.
