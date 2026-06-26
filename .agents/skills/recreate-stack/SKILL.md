---
name: recreate-stack
description: Destroy, rebuild and bring up the entire local stack from scratch with clean data (seed only) and verify everything works, using `.claude/commands/recreate-stack.md` as the authoritative workflow. Use when the user asks for `$recreate-stack`, "recreate stack", "reset the stack", `/recreate-stack`, or wants a clean reproducible local environment (teardown + rebuild + reseed + health check) while preserving the existing Claude rules.
---

# Recreate Stack

## Overview

Execute the same full local-stack recreation workflow defined for Claude,
adapted to Codex and Copilot surfaces. The source of truth is
`.claude/commands/recreate-stack.md`, which in turn delegates all real work to
the executable script `scripts/recreate-stack.sh`. Do not reimplement or
reinterpret the teardown/rebuild/seed/verify steps from memory.

## Workflow

1. Read `.claude/commands/recreate-stack.md` end to end before running anything.
2. Treat the user's text after `$recreate-stack` as the Claude command's
   `$ARGUMENTS`.
3. Run the authoritative script, passing the arguments through verbatim:

   ```bash
   bash scripts/recreate-stack.sh $ARGUMENTS
   ```

4. Do not re-implement the phases inline. The script is idempotent, robust and
   self-verifying; let it own teardown, rebuild, Supabase reset, demo-user
   seeding, stack start-up and health checks.
5. Keep `.claude/` intact. Do not edit Claude commands, agents, or settings
   while executing this skill unless the user explicitly asks to modify the
   Claude setup.
6. Preserve the script's destructive-by-design behavior, default full rebuild,
   `--no-build` / `--with-frontend` flags, and its non-zero exit on failed
   verification. Surface the final endpoint summary back to the user.

## Codex / Copilot Adaptation

- This skill is a thin wrapper: the only required action is invoking
  `scripts/recreate-stack.sh` via the shell tool and relaying its output.
- Translate Claude tool names to the equivalent Codex/Copilot actions: a single
  shell command execution. No subagents are required.
- If the script fails preflight (missing `.env`, `frontend-portal/.env.local`,
  Docker daemon, or the `supabase` CLI), report the exact error to the user and
  stop — do not attempt to patch the environment unless asked.
- Never print or echo secret values (passwords, service-role key); the script
  already reads them from gitignored dotenv files without exposing them.

## Supported Arguments

Accept the same forms as `.claude/commands/recreate-stack.md`:

- no arguments — full rebuild (`--no-cache`) + verification
- `--no-build` — skip the image rebuild (reuse current `dia-ops-app:local`)
- `--with-frontend` — also start the `frontend-portal` Vite dev server

## Safety

This workflow is **destructive**: every run wipes the local Supabase data and
recreates a clean seed-only environment. Confirm intent if the user seems to
expect their local data to be preserved, and never run it in parallel with
another session that depends on the same local Supabase.
