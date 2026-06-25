# Spec: Create CLAUDE.md root documentation (10x template pattern)

## Overview

Create a root `CLAUDE.md` file that serves as the single entry point for developers, agents, and collaborators entering this repository. The file follows the "10x template" pattern (Anthropic dev-track training) — linking to existing docs instead of duplicating them, describing the real product and two-factory architecture, and directing readers to the canonical validation commands and development workflows.

## Problem / Context

Today, onboarding a new agent or developer requires stitching together `README.md` + `AGENTS.md` + scattered docs in `docs/`. There is no single file that Claude Code automatically loads as session context. The README still carries rental-ERP narrative (Wynne template) even though the real product is a DMS automotivo / BI agêntico DIA with two factories (software factory + Operations Factory). Developers need a concise, action-oriented map showing where to read first, how to validate changes, and how to ship work.

## Acceptance Criteria

1. **File exists and is readable** — `CLAUDE.md` exists at repository root and is valid Markdown, loadable by Claude Code as automatic session context.

2. **"Read First" section prioritizes entrypoints** — Begins with a "Start here" or "Comece por aqui" section listing, in order of likelihood, what to read before changing code: issue + acceptance criteria, relevant ADRs/specs in `docs/`, product docs (`README.md`, `DATABASE.md`), and `AGENTS.md` for agent/workflow details — each as a live link, not duplicated text.

3. **Product description is accurate** — Describes the real product (DMS automotivo / BI agêntico DIA, Portal DMS in React 18 + Vite + Tailwind, Temporal Python workers, self-hosted Supabase Postgres) and the two factories (software factory in `.github/` with role-based agents + GitHub Actions; Operations Factory with Temporal + Azure OpenAI), without copying or contradicting `README.md` or `AGENTS.md`.

4. **Repository map is concise and accurate** — Includes a short table (path → what's there) matching the real structure: `frontend-portal/`, `temporal/`, `supabase/`, `charts/`, `deploy/`, `scripts/`, `.github/`, `docs/`, with links to live docs where they exist.

5. **Development workflows are cited correctly** — Includes a "How to ship a change" or "Como entregar uma mudança" section that names `/ship-issue <n>` (in `.claude/commands/ship-issue.md`) and `/ship-batch` (in `.claude/commands/ship-batch.md`), describes the pipeline (spec → approve → code → tests → test-review → code-review → PR) and human gatekeeping (spec approval, merge), and lists at least two real gotchas (e.g., frontend is `frontend-portal/` not `frontend/`; contract tests are in `supabase/tests/`).

6. **Validation commands are real and complete** — Lists the actual commands developers run to validate a change:
   - Frontend: `cd frontend-portal && npm run lint && npm run build && npm test`
   - Temporal: `python -m pytest temporal/tests/ -v`
   - Supabase: `node --test --test-concurrency=1 supabase/tests/*.test.mjs`
   
   Commands are copy-paste ready and match what exists in the repo.

7. **File is concise** — Fits on roughly one screen (~500 words max); prioritizes links and actions over prose; does not duplicate content from `AGENTS.md`, `README.md`, or `DATABASE.md` where it overlaps.

## Non-Goals

- Rewrite `README.md` (product narrative corrections are issue #41).
- Create or modify agents or commands in `.claude/`.
- Change product code or database schemas.
- Provide a 350+ line heavy template (use the lightweight 10x pattern instead).

## Out-of-Scope

- Correcting the rental-ERP template narrative in `README.md` (tracked in issue #41).
- Updating `AGENTS.md` or `DATABASE.md` (those remain authoritative for their domains).
- Implementing product features or refactoring code; this is documentation only.

---

**DRAFT — requires human approval before any implementation.**
