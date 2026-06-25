# Domain Operating-Model — the north star

> **One question drives everything here: _"What does it take to operate an X?"_**
> (X = an enterprise equipment-rental business; or, to prove the method generalizes, a UK
> pub, a dental clinic, a 3PL warehouse…). Answer it by modelling the **real work** —
> the roles, their actual tasks, and the cadence of those tasks — and the product roadmap
> and the agentic program both fall out of it.

This is the layer **above** the [discovery pipeline](../README.md). Discovery (market-scout
→ strategist → critic) works *outside-in*: what are competitors shipping, what's trending.
This works *inside-out*: what does running the business actually require, regardless of what
any competitor does. The two meet — the operating model is the **frame**, market signal is
**evidence that prioritizes within it**.

## Why this is the north star

It unifies the two halves of this company in one question:

- **"What does it take to run an X?"** → the **product roadmap** (what to build).
- **"Which of those tasks should the system do instead of a human?"** → the **agentic program**
  (what to automate — the [agentic charter](../../agentic-charter.md) lens applied at the task grain).

You cannot ask the second question until you've answered the first. So the operating model is
the substrate the whole agentic strategy stands on.

## The method (reusable across verticals)

The **method is code; the vertical is data.** The same machinery
([`operating-model.ts`](../../../.github/tools/shared/src/operating-model.ts)) runs for any
industry — instantiate a vertical, decompose it, populate it from evidence:

1. **Decompose** the business into **capability areas** (functional areas it takes to operate).
2. **Identify the roles** that do the work in each area.
3. **Build a rich persona per role** (see below) — not just tasks, but who they are, their goals,
   their day, and their frustrations.
4. **Inventory each role's real tasks**, each with: `cadence` (daily/weekly/monthly/yearly/adhoc),
   `frequency`, `pain`, `tool_today`, `decision_content` (the judgment involved),
   `agentic_potential` (`none|assist|automate`), `capability`, and **evidence**.
5. **Assess the agentic angle** of each task (the charter lens at task grain).
6. **Surface the gaps** — high-pain, high-frequency, or strong-agentic-potential tasks — as
   **opportunities into the discovery pipeline** (never directly as build tickets).

## Personas are the collaboration surface (not fluff)

Each role is a **persona dossier**, and the persona is the point: it is the artifact a real
domain expert can read, recognise as their world, and then **correct, extend, and scope.** That
is why it carries the qualitative layer — **identity, goals & motivations, a day/week in the
life, frustrations & pains, tools-today, decisions-owned** — alongside the task table. Skip that
layer and you get a sterile task list no SME wants to engage with; include it and you get a
living document experts co-author.

- **Frustrations are where agentic opportunities are born** — an un-served frustration is an
  un-served job. The "why" (motivations) explains which tasks matter and where the pain is.
- **Evidence still rules the empirical claims.** Tasks must be cited; frustrations/motivations
  should cite where they can (review sites and SME interviews voice these directly) and are
  otherwise clearly a **draft pending domain-expert validation**.
- **Built for hand-off.** Every persona has a **Domain-expert review** section. The highest-value
  evidence kind is `sme-interview`; an expert's correction outranks anything the cartographer
  inferred. A persona is only as good as the experts who refine it.

### The iron rule: no citation, no task

A confidently-hallucinated operating model is worse than none — it *looks* authoritative.
Every task must carry ≥1 evidence reference, and `add-evidence` rejects records without a real
source URL + a verbatim excerpt. Sources, by value: **real Dealernet users / SME interviews** >
role postings & industry/association material > competitor docs > general web. The decomposition
(capability areas, roles) is *design* and may be authored directly; the **tasks** beneath it are
*empirical claims* and must be evidenced.

## Storage layout

```
docs/discovery/domain/<vertical>/
  _meta.yml                       — vertical config (slug, name, segment, north_star)
  operating-model.md              — the capability map: areas → roles (the decomposition)
  roles/<role>.md                 — role narrative + a rendered task table (human view)
  roles/<role>.tasks.jsonl        — structured task records (SOURCE OF TRUTH for coverage)
  evidence/<role>/evidence.jsonl  — cited evidence log
```

## The helper (`operating-model.ts`)

Run from `.github/tools/shared` (paths resolve to repo-root unless `DOMAIN_ROOT` is set):

```bash
npx tsx src/operating-model.ts new-vertical <slug> "<name>" --segment "…" --north-star "…"
npx tsx src/operating-model.ts new-role <vertical> <role-slug> "<title>" --capability a,b
npx tsx src/operating-model.ts add-evidence <vertical> <role> <kind> <url> "<excerpt>"
npx tsx src/operating-model.ts add-task <vertical> <role> --task "…" --cadence daily \
    --pain high --tool "…" --decision "…" --agentic assist --capability fleet --evidence <url>,<url>
npx tsx src/operating-model.ts render <vertical> <role>      # regenerate the md task table
npx tsx src/operating-model.ts coverage <vertical>           # roles, tasks by cadence, assessed %
```

`add-task` refuses a task with no evidence ref (`no citation, no task`). `coverage` is how we
see the gaps — roles × cadences covered, and the % of tasks whose agentic potential is assessed.

## Example: what a populated role looks like

> _Illustrative only — real entries are added by the cartographer with verified citations._

| Task | Cadence | Pain | Tool today | Agentic | Capability |
|------|---------|------|-----------|---------|-----------|
| Reconcile physical yard count vs. system of record | weekly | high | manual walk + spreadsheet | `automate` | fleet |
| Decide which idle units to transfer to a short branch | weekly | med | phone + gut | `assist` | multi-branch |

The first is a strong `automate` candidate (bounded, repetitive, auditable); the second is
`assist` (judgment + cross-branch context → propose, human disposes). Both flow to discovery
as opportunities — not as build tickets.

## How it feeds the roadmap: the ticket bridge + feedback loop

Research is doc-based (above); turning it into buildable work is a **deliberate, capped bridge**,
not a per-task firehose:

- **Ticket bridge — one epic per role** (`scripts/operating-model-epics.sh`, run in the pipeline).
  Each populated role becomes **one** epic in **`queue:product` + `needs-triage`** (never
  `ready-for-dev`), carrying the persona link, ROI pointer, and a task checklist (each item tagged
  `\`<task-id>\``). The PO/Architect split the high-value items into stories; **the owner gates
  what actually gets built.** One epic per role keeps tickets scarce and grounded — the opposite of
  the auto-ticket flood.
- **Feedback loop — coverage climbs as work ships** (`scripts/operating-model-reconcile.sh`). When a
  story tagged `<role>:<task-id>` closes, the matching task is advanced to `implementation:
  supported`, so **roadmap coverage % and captured ROI become a live burn-up**. (Architect: thread
  the `<role>:<task-id>` tag from the epic checklist into each story so the loop can close.)
- For *net-new* ideas (not yet in any role's task list), the cartographer still routes to the
  [discovery pipeline](../README.md) (signal → … → ready). The operating model **never** applies
  `ready-for-dev`/`queue:development` itself — it proposes; humans dispose.

> **Cadence note:** the operating-model pipeline is **temporarily daily** (in `pipeline-weekly.yml`)
> to build the roadmap quickly while getting going; revert the cron to weekly once the map is
> well-populated.

## Measuring coverage & ROI (Hubbard-style — and the doc is the deliverable)

Two questions make this roadmap *compelling to share*: **"what % of running the business have we
built?"** and **"what's the ROI of adopting it?"** Both are answered as reviewable prose in each
vertical's [`operating-model.md`](./equipment-rental-enterprise/operating-model.md) **Coverage &
ROI** block — the helper does the math, but **the artifact you share is the markdown doc**, not a
script output.

We follow Douglas Hubbard's *How to Measure Anything* so the numbers are credible, not fabricated:

- **Calibrated 90% confidence intervals, not point estimates.** Every value input
  (`minutes_per_occurrence`, `occurrences_per_year`, `loaded_hourly_rate`, `automation_capture_pct`)
  is a *range* you're 90% sure contains the truth. A wide range is honest — it says how little we
  know — and even a few real SME data points (the **rule of five**) tighten it fast.
- **Decompose, then roll up.** Annual labor per task = `minutes × occurrences ÷ 60 × rate`; ROI
  rolls these ranges up to an interval with an expected value. No magic single number.
- **Reduce uncertainty where it pays.** Value-weighting shows which tasks move the estimate most —
  measure those precisely, leave the trivial ones rough (Hubbard's value-of-information).
- **Three honest ROI numbers, not one.** The realized number is $0 until the product automates
  something — which *undersells* the opportunity — so we report the whole picture:
  - **Addressable opportunity** — annual labor on every `assist`+`automate` task (the size of the
    prize; non-zero the moment the work is mapped).
  - **Capturable** — addressable × each task's `automation_capture_pct` estimate (what's achievable
    if we automate the candidates), as ≈ FTE-equivalent.
  - **Captured today** — only tasks already `automated` in the product (realized; grows as the
    roadmap ships).
  Everything is labelled *directional estimate, pending SME validation*.

The roadmap coverage number is value-weighted-aware:
- **Roadmap coverage** = % of tasks `supported`+`automated` (raw **and** value-weighted by annual
  labor cost — so finishing the *valuable* tasks moves the number, not the trivial ones), plus an
  explicit note of *what fraction of tasks the $ model even covers* (the honest denominator).

`operating-model.ts render-model <vertical>` recomputes the block into the doc; the cartographer
runs it each pass so the shareable roadmap stays current.

## Verticals

| Vertical | Segment | Status |
|----------|---------|--------|
| [`equipment-rental-enterprise`](./equipment-rental-enterprise/operating-model.md) | Enterprise multi-branch + contractor/project (Dealernet ICP) | seeded — roles scaffolded, tasks + ROI pending cartographer |
