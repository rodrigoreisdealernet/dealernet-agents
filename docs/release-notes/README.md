# Release Notes

> **What this is:** the human-readable, end-user-facing record of *what was recently
> added to the Wynne rental platform*. It is the front door for the question "what's new,
> and how do I use it?" — written for the people who operate the system (admin,
> branch_manager, field_operator, read_only), not for engineers.
>
> **Companion docs:** [`docs/user-guide/`](../user-guide/) (the deep how-to guides this
> file links out to), [`MONITORING.md`](../../MONITORING.md) (the operational runbook for
> the factory that produces these notes).

These notes are produced **automatically every night** by the **Release Notes** sub-pipeline
inside [`pipeline-daily.yml`](../../.github/workflows/pipeline-daily.yml). No human writes
them day-to-day; they are derived from the pull requests the factory merged in the last 24h.

---

## How it works (the sub-pipeline)

A curator → marketer → publish chain, mirroring the discovery pipeline's "agents write
files, a deterministic step opens the PR" shape:

1. **`release-notes-curator`** — reads every PR **merged in the last 24h**, keeps the
   **user-facing** ones, and writes a plain-language entry for each into the current
   month's file. For every entry it checks whether an end-user guide exists; if not, it
   coordinates with the User Docs Manager's ticket lane and links the doc ticket so the
   entry always points somewhere a reader can learn more.
2. **`release-marketer`** — reads the day's new entries and drafts a **marketing plan**
   (`marketing/<date>.md`) so the team has ready-to-use promotional copy for what shipped.
3. **publish step** (`scripts/release-notes-publish.sh`) — commits everything under
   `docs/release-notes/` and opens/updates **one** nightly PR for owner review.

Because the source of truth is git-tracked, every night is a reviewable diff: *"what did
we ship, and how are we telling people about it?"*

---

## Layout

| Path | What it holds |
|------|---------------|
| `README.md` | This index. |
| `YYYY-MM.md` | **Monthly rolling file.** Each night appends the day's user-facing entries, newest day on top. The current month is where new releases land. |
| `marketing/YYYY-MM-DD.md` | One **marketing plan per day** of releases — value prop, audience, talking points, and per-channel copy drafts the team can use to promote that day's features. |

### Entry shape (in the monthly file)

Each day is a dated `##` section; each shipped feature is a bullet/sub-section carrying:

- **What's new** — one or two plain sentences about what a user can now do (benefit, not
  implementation).
- **Who it's for** — the role(s) affected.
- **Learn more (Docs)** — a link to the `docs/user-guide/` page if it exists, **or** the
  doc ticket tracking it (`#NNN`, "guide in progress") if it does not yet.
- **Shipped in** — the PR number(s) the entry is derived from.

### Documentation cross-check

The curator never lets a user-facing feature ship into the notes with a dead "Learn more"
link. For each feature it resolves the Docs link in this order:

1. An existing guide under [`docs/user-guide/`](../user-guide/) → link it.
2. An existing doc ticket (label `user-docs`, fingerprint `user-docs-<area>`) → link it.
3. Neither exists → file **one** doc ticket using the **same** `user-docs` label and
   `user-docs-<area>` fingerprint the User Docs Manager uses (so the two agents never file
   duplicates), then link it.

The result is a body of material that doubles as onboarding: a reader can follow any
release entry straight to a guide (or to the ticket that will become one).

---

## Months

<!-- index of monthly files; the curator keeps this list current -->
- [2026-06](./2026-06.md)
