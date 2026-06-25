# Discovery Pipeline

> The factory has a strong **delivery** pipeline (idea → triage → design → Copilot →
> review → merge). This is the missing **discovery** pipeline that sits *in front* of it:
> it researches the market, captures evidence, and matures product ideas over days and
> weeks so that — when there is time to build — the tickets are already exceptional.
>
> **Companion docs:** [`MONITORING.md`](../../MONITORING.md) (operational runbook),
> the GitHub Project board #15 "Dealernet ERP Factory" (the roadmap scoreboard).

An idea is not the final state — it is the *start*. The job of this pipeline is to take
a raw spark and, a little every night, validate it, enrich it, refine it, and let it
reflect, until it has earned its place on the roadmap.

> **The north-star layer above this pipeline:** [`domain/`](domain/README.md) answers
> *"what does it take to operate an X?"* by mapping the target business into roles and their
> real, cited tasks. The `domain-cartographer` turns high-value tasks into **opportunities**
> that enter the ladder below — so much of the funnel's top is fed inside-out from the actual
> work, not just outside-in from market signal.

---

## The idea-maturity ladder

Every idea climbs the same five rungs. It moves **one rung at a time**, and only when it
has met that rung's **entry bar**. The bars are enforced in code by
[`discovery-store.ts`](../../.github/tools/shared/src/discovery-store.ts) — not just asked
for in a prompt — so an idea cannot leap from spark to "ready" on a single hallucinated night.

| Rung | What it is | Entry bar (enforced) |
|------|------------|----------------------|
| `signal` | A raw, dated observation (a competitor shipped X; a review complains about Y; a market trend). | A real source URL + retrieval date + verbatim excerpt. |
| `opportunity` | A framed *problem*, clustered from corroborating signals. | ≥ 2 evidence records. |
| `idea` | A proposed *solution* to an opportunity — a stated bet. | A differentiator vs Renterra / RentalMan is written down. |
| `validated` | Enriched with sizing, demand evidence, feasibility, and a score. | ≥ 3 evidence records **and** a computed RICE score. |
| `ready` | A crisp, design-ready epic: problem, evidence, scope, metrics, risks, open questions resolved. | Was `validated`; passes the `discovery-critic` review. |

Because evidence accumulates across nights and a critic must bless each promotion, a good
idea naturally takes days or weeks to reach `ready` — which is the point.

---

## Storage model — three surfaces, one source of truth

| Surface | Role | Lives in |
|---------|------|----------|
| **Dossier** | Canonical source of truth: reasoning + evidence + decision history. Git-tracked, so every nightly change is a reviewable diff and the full evolution of an idea is a `git log`. | `docs/discovery/ideas/<slug>.md` |
| **Evidence log** | Append-only record of every captured citation (URL + retrieval timestamp + verbatim excerpt + kind). | `docs/discovery/evidence/<slug>/evidence.jsonl` |
| **Issue / epic** | The actionable handle the rest of the factory consumes once an idea is promoted into the build funnel. | GitHub issue (`linked_issue` in the dossier) |
| **Project board** | The sortable scoreboard (Discovery Rung, Idea Score, Last Researched, Evidence Count). | Project #15 fields |

The dossier is canonical. The issue is the thin handle. The board is the lens. Keep them
in sync via the helper — never hand-edit dossier frontmatter.

### Evidence integrity — *no citation, no evidence*

This is the single most important rule. A web-research agent with no citation discipline
will confidently invent a market. Every evidence record **must** carry a resolvable
`source_url`, a `retrieved_at` timestamp, and a verbatim `excerpt`. `add-evidence` rejects
records that lack them; the `discovery-critic` re-verifies that cited URLs resolve before
blessing any promotion to `validated` or `ready`.

---

## The helper: `discovery-store.ts`

Agents call this CLI rather than editing files by hand. Run from `.github/tools/shared`:

```bash
npx tsx src/discovery-store.ts new-idea <slug> "<title>" [--rung R] [--initiative N]
npx tsx src/discovery-store.ts add-evidence <slug> <kind> <url> "<excerpt>" [--by who]
npx tsx src/discovery-store.ts set-field <slug> <dotted.key> <value>
npx tsx src/discovery-store.ts set-rung <slug> <rung> [--by who] [--why "..."] [--force]
npx tsx src/discovery-store.ts list [--rung R] [--stale-first] [--json]
npx tsx src/discovery-store.ts meets-bar <slug> <target-rung>      # exit 0 = met, 2 = not
npx tsx src/discovery-store.ts evidence-count <slug>
```

- `kind` ∈ `competitor | review | news | market | feasibility | customer`
- `set-rung` refuses an unmet bar (exit 2) unless `--force`; a forced promotion is stamped
  `FORCED` in the dossier's decision log.
- `--initiative` ties the idea to one of the standing Initiatives (#536–#541).

---

## The discovery crew (runs nightly in `pipeline-daily.yml`)

A proposer → curator → approver pipeline, mirroring the delivery side's PM / Architect /
Tech-Reviewer separation:

1. **`market-scout`** — *gather (divergent).* Scans the configured source list, captures
   **new** signals as evidence records, dedups by listing the store. Never decides the roadmap.
2. **`product-strategist`** — *synthesize & advance (the brain).* Clusters signals into
   opportunities, enriches dossiers (scoring, sizing, differentiation), and advances **at
   most a few ideas exactly one rung per night**, re-touching the stalest dossiers first.
   This is the "a little better every night" engine.
3. **`discovery-critic`** — *the gate (adversarial).* Verifies citations resolve, checks
   distinctness vs existing epics, and is the **only** actor that stamps `discovery:validated`
   / `discovery:ready`. Weak ideas get kicked back with `needs-more-evidence`.

---

## Review & approval chains

- **Internal gate (agent → agent):** the strategist *proposes* a promotion; the critic
  *blesses* it. Only the critic sets `discovery:validated` / `discovery:ready`.
- **Build gate stays human (agent → owner):** the crew **never** applies `ready-for-dev` or
  `queue:development`. A finished idea parks at `discovery:ready` with a complete dossier;
  promoting it into the *build* funnel is the owner's go/no-go. This is the same
  `hold-for-triage` discipline already used for the Renterra parity epics.
- **Roadmap changes flow through PRs:** because the store is git-tracked, every night
  produces a reviewable diff — "what changed in the roadmap last night."

---

## Labels

| Label | Meaning | Who sets it |
|-------|---------|-------------|
| `discovery:signal` / `discovery:opportunity` / `discovery:idea` | Current rung of a tracked idea | product-strategist |
| `discovery:validated` | Passed validation review | **discovery-critic only** |
| `discovery:ready` | Design-ready; awaiting owner go/no-go into the build funnel | **discovery-critic only** |
| `needs-more-evidence` | Kicked back by the critic | discovery-critic |
| `queue:product` | In the discovery lane | product-owner / crew |
