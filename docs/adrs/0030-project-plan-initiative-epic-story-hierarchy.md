# ADR-0030: Project plan is a three-level Initiative → Epic → Story hierarchy

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Repository owner + Product Owner agent
- **Supersedes / Superseded by:** Tooling clause superseded by [ADR-0070](0070-daily-roadmap-curator-workflow-gh-cli-direct.md) (linking via `scripts/project-sync.sh` → direct `gh` CLI + daily curator workflow)

## Context
The GitHub Project board (`{{ owner }}` org Project #15, "Wynne ERP Factory") had grown to
~285 items dominated by a flat list of 77 epics — most with no child stories, no top-level
grouping, and a tail of orphan tickets. A flat board hides what work belongs together,
makes prioritization and roll-up reporting impossible, and lets newly-created tickets drift
unparented.

Two factory agents create tickets and are therefore responsible for structure:
- **Product Owner** (`.github/agents/product-owner.agent.md`) — triages and grooms the board.
- **Factory Architect** (`.github/agents/factory-architect.agent.md`) — decomposes epics into
  child stories.

GitHub-native **sub-issues** (the `Parent issue` / `Sub-issues progress` fields) are the only
mechanism that creates real hierarchy. A `Part of #N` line in an issue body is **prose** — it
does not link anything. Both agents had drifted: the Product Owner modeled only a two-level
Epic → Story tree, and the Architect linked child stories via a `Part of #N` body edit, which
left every story it created as a board orphan.

## Decision
The project plan is a **three-level hierarchy: Initiative → Epic → Story**, built exclusively
with native sub-issue links via `scripts/project-sync.sh parent <child> <parent>`.

- **Initiatives** are the only top-level items, titled `Initiative:`. They are tracking
  containers, not units of work. The standing set:
  - Renterra competitive parity
  - Enterprise & RentalMan solution depth
  - Third-party integrations
  - Operations Factory (agentic ops)
  - Platform, security & delivery
  - Core ERP foundation & UX
- **Epics** (titled `Epic:`) each roll up under exactly one Initiative.
- **Stories / tasks / bugs** each roll up under exactly one Epic.
- `Phase` propagates down: stories inherit their epic's Phase; epics inherit their initiative's.

The Product Owner enforces this every grooming run; the Factory Architect links every story it
creates (and every epic it creates/handles) natively. The only acceptable top-level items are
`Initiative:` issues.

## Consequences
- Roll-up reporting, prioritization, and "what's in this initiative" become trivial on the board.
- New tickets stay connected: both creating agents now link natively, so the structure is
  self-maintaining rather than something a human re-fixes periodically.
- A small standing cost: the Product Owner must place each new epic under an initiative and each
  new story under an epic every run (idempotent, cheap — does not count against its action cap).
- Initiative membership is a judgment call; an epic that fits no initiative requires a new
  `Initiative:` issue rather than being force-fit or left orphaned.
- Issue numbers for the standing initiatives are referenced by name, not hard-coded as the source
  of truth — agents discover the live set with `gh issue list --search 'Initiative: in:title'`.

## Alternatives considered
- **Two-level Epic → Story (status quo):** rejected — 77 flat epics is unnavigable; there is no
  grouping above the feature level for a portfolio this size.
- **`Part of #N` text references / task lists in bodies:** rejected — not real hierarchy; the
  board cannot roll these up, and they were the source of the orphan drift.
- **A custom single-select "Initiative" project field instead of sub-issues:** rejected — would
  not nest on the board's hierarchy view, requires bespoke option management, and duplicates a
  capability GitHub provides natively via sub-issues.
- **Labels for grouping:** rejected — labels don't express parent/child or roll up progress.

## Evidence
- Hierarchy model + grooming rules: `.github/agents/product-owner.agent.md` ("Backlog grooming").
- Story/epic linking rules: `.github/agents/factory-architect.agent.md` ("Split into child
  stories", "Creating or placing an epic").
- Linking tool: `scripts/project-sync.sh` (`parent` subcommand → `addSubIssue` GraphQL mutation).
- Live structure: org Project #15; Initiatives created as issues titled `Initiative:`, every epic
  linked beneath one, the High-priority core epics decomposed into `Story:` sub-issues.
