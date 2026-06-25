# Agentic Workflow Charter

> **A living definition of what makes a *great* agentic workflow.** Not a fixed standard —
> a document that evolves as the market evolves and as we learn from our own practice. The
> [`agentic-reflector`](.github/agents/agentic-reflector.agent.md) reviews recent tickets,
> discovery dossiers, market evidence, and the factory's own outcomes each week and
> **proposes** refinements; a human reviews and merges them. (Fittingly: agents propose,
> humans dispose — even here.)
>
> **Seeded from:** ADR-0020 + `docs/specs/operations-factory-agentic-workflows.md`.
> **Used by:** `factory-architect` and `product-strategist` apply it as a design lens; the
> discovery dossier "Agentic angle" section records the result.

_Charter version: 12 (2026-06-20)._

---

## Why this exists

Both halves of this system are the same bet: **take work that routes to a human, and insert
agency at the decision point so the system handles it.** The software factory does it with the
Copilot SDK at points in GitHub Actions; the Operations Factory does it with LLM agents inside
Temporal workflows for the rental back-office. The pattern is general. This charter is our
current, best, *evolving* answer to: when is that a good idea, and what does doing it well look
like?

## The floor (non-negotiable, from ADR-0020)

> **Agents propose; humans dispose.**

Every **money-moving, customer-facing, or status-changing** action waits for an explicit human
approval signal. Schedules run automatically and produce findings continuously; nothing
actionable is auto-applied. This is the floor the charter may build on but must never lower.

## The canonical loop

A well-formed agentic workflow runs a deterministic orchestration around a bounded agent step:

```
load-config → scope → investigate → gate → human-approve → write → audit
```

- **load-config** — prompt, model, enabled tools, thresholds, bounds come from config (per
  tenant), never hard-coded.
- **scope** — bound the work-list and the blast radius before any agent runs.
- **investigate** — the agent reasons over a **read-only tool-belt** against the real model.
- **gate** — deterministic checks/thresholds decide what even becomes a proposal.
- **human-approve** — the disposition signal for anything that crosses the floor.
- **write / audit** — the approved action is applied and every step is durably recorded.

## The agentic-angle lens (apply at design time)

For any workflow or feature, ask:

1. **What does a human decide or request here today, and which actor tier owns it?** List the
   judgment calls and the routing/escalation steps, naming whether they sit with an external
   customer, field/mobile user, day-to-day operator, system administrator, manager, or executive.
   Those are the candidate insertion points. *(Evidence: PR #1679;
   `docs/discovery/ideas/self-service-rental-customer-portals.md`;
   https://getrenterra.com/blog-posts/what-is-a-customer-portal----and-why-your-rental-business-needs-one)*
2. **Which are investigate-and-propose vs. safe-to-act?** Most are *propose* (cross the floor →
   human approves). A few are reversible/low-stakes enough to *act* with audit only.
3. **Is the input bounded, authorized, and the model legible?** An agent needs a scoped,
   read-only view of real state, enforced at the data boundary for the actor/session in question,
   and a clear definition of "done"/"unsure." *(Evidence: PRs #1871, #1888, #1889;
   `docs/discovery/ideas/nl-operational-reporting.md`;
   `docs/discovery/ideas/self-service-rental-customer-portals.md`;
   https://getrenterra.com/manage-financials-reporting/ai-powered-reporting;
   https://getrenterra.com/manage-financials-reporting/customer-portal)*
4. **What is the fallback when the agent is unsure?** There must be a graceful escalation to a
   human, not a silent guess.
5. **What is the unit of intervention, and how do duplicates collapse?** Supervisory/monitoring
   agents need a fingerprint and a roll-up path so one shared outage becomes one owned thread,
   not N sibling tickets. *(Evidence: trend issue #1579; PR #1563.)*
6. **Can the human dispose from the proposal itself?** The proposal should survive drill-down,
   queue hops, and reload with the scoped context, evidence, and next action intact so review is
   an approve/reject/edit decision, not a fresh investigation. *(Evidence: PRs #1544, #1556,
   #1568, #1620.)*
7. **What does the receiving human need on day one to use this workflow without implementation
   context?** Human-facing queues, packs, and review surfaces should ship with the user guide or
   runbook that explains the states, source-gap warnings, approval boundaries, and return-to-
   context behavior the human will actually see. If the workflow relies on tribal knowledge or PR
   archaeology, it is not ready. *(Evidence: trend issue #2426; issues #2423, #2422, #2254,
   #2253, #2252.)*
8. **What shared queue, scheduler, or reviewer lane can this jam, and how does stale/superseded
   work get retired?** Expensive paths need path-scoping, cancellation, or equivalent back-pressure
   so one wedged run does not block unrelated work. *(Evidence: trend issue #1633; PR #1615.)*
9. **What is the no-op condition, what counts as genuinely new signal, and what re-wake budget is
   allowed for a known incident?** A healthy workflow leaves good-enough artifacts alone, updates
   the canonical thread instead of spraying siblings, and wakes humans again only when new
   evidence, a material delta, or a defined escalation threshold exists. *(Evidence: PRs #1563,
   #1668, #1676, #2069; trend issue #1973; alert issues #2092, #2093, #2095, #2096, #2105,
   #2108, #2111.)*
10. **What shared prerequisite must be true before the workflow can help, and where does that fail
   once?** Secrets, linked owner artifacts, and other enabling state should be checked at the
   chokepoint and routed to one canonical owner/thread so the system does not rediscover the same
   missing dependency per run. *(Evidence: trend issue #1790; PR #1750.)*
11. **What upstream feeds or edge inputs make this credible, and how are missing, stale, or
   partial sources surfaced?** If telemetry, route boards, tax engines, operator-entered scans,
   or other grounding inputs are absent, lagging, or conflicted, the workflow should say so
   explicitly, reduce confidence or block the proposal accordingly, and never render
   clean-looking zeros, empty states, or "all clear" placeholders that imply the source was
   healthy. *(Evidence: PRs #2196, #2228, #2230;
   `docs/discovery/ideas/dispatch-and-driver-mobile-visibility.md`;
   `docs/discovery/ideas/embedded-telematics-usage-billing.md`;
   `docs/discovery/ideas/multi-state-rental-tax-automation.md`;
   https://getrenterra.com/streamline-operations/dispatch;
   https://getrenterra.com/damage-rental-protection/gps-tracking;
   https://getrenterra.com/learn-more/integrations;
   https://taxjar.com/product)*
12. **Where is the evidence captured, and does it arrive as a durable proof bundle rather than a
   scavenger hunt?** If the workflow depends on photos, signatures, meter readings, checklists,
   or other edge evidence, capture it at the point of work, preserve it across offline/reload
   paths, and package it into one scoped artifact the reviewer can dispose from. *(Evidence: PRs
   #1922, #1943, #1944, #1958; `docs/discovery/ideas/damage-loss-evidence-workflows.md`;
   `docs/discovery/ideas/automated-fuel-charge-recovery.md`;
   https://getrenterra.com/damage-rental-protection/mobile-inspections;
   https://getrenterra.com/damage-rental-protection/contract-esignatures;
   https://getrenterra.com/blog-posts/rising-fuel-costs-are-eating-into-rental-margins-are-you-recovering-every-dollar)*
13. **How is it audited?** If you can't reconstruct *why* the agent proposed what it did, it's
   not ready.

Record the answer in the ticket/dossier's **Agentic angle** section, and classify the
`agentic_potential` as `automate` (safe to act + audit), `assist` (investigate→propose→human),
or `none`.

## Properties of a *great* agentic workflow (the current rubric)

- **Bounded** — explicit work-list, count caps, and blast radius; can't run away.
- **Config-driven** — behavior lives in config, so it tunes without code changes.
- **Read-only by default** — writes only behind the gate + approval.
- **Scope-safe** — authorization and actor/customer scope are enforced at the data boundary, fail
  closed when scope is missing or ambiguous, and never degrade permission problems into
  success-shaped defaults. *(Evidence: PRs #1871, #1888, #1889;
  `docs/discovery/ideas/nl-operational-reporting.md`;
  `docs/discovery/ideas/self-service-rental-customer-portals.md`;
  https://getrenterra.com/manage-financials-reporting/ai-powered-reporting;
  https://getrenterra.com/manage-financials-reporting/customer-portal)*
- **Actor-grounded** — anchored in a named actor tier (customer, field/mobile user, operator,
  administrator, manager, or executive), task, and frustration from the operating model, so the
  workflow serves a real job instead of "agentic" novelty or operator-only tunnel vision.
  *(Evidence: PRs #1629, #1679; `docs/discovery/ideas/nl-operational-reporting.md`;
  `docs/discovery/ideas/self-service-rental-customer-portals.md`;
  https://getrenterra.com/blog-posts/what-is-a-customer-portal----and-why-your-rental-business-needs-one)*
- **Disposition-ready** — the proposal survives handoff/reload with labeled context, evidence,
  and a clear next action so the human can dispose from the artifact itself instead of
  reconstructing the case. *(Evidence: PRs #1544, #1556, #1568, #1620.)*
- **Adoption-ready** — the human-facing queue, pack, or review surface ships with the guide or
  runbook needed to use it on day one: key states, source-gap warnings, approval boundaries, and
  return-to-context behavior are explained without requiring tribal knowledge or PR archaeology.
  *(Evidence: trend issue #2426; issues #2423, #2422, #2254, #2253, #2252.)*
- **Queue-safe** — scopes expensive work to the items that need it, retires stale/superseded runs,
  and fails closed when scope is indeterminate so one wedged run cannot block unrelated work.
  *(Evidence: trend issue #1633; PR #1615.)*
- **Churn-resistant** — leaves stable artifacts untouched, appends only genuinely new evidence,
  prefers updating one canonical thread over opening a fresh spray of near-duplicate work, and
  does not re-page a known outage on every schedule tick when nothing material changed. *(Evidence:
  PRs #1563, #1668, #1676, #2069; trend issue #1973; alert issues #2092, #2093, #2095, #2096,
  #2105, #2108, #2111.)*
- **Prerequisite-aware** — validates shared secrets, ownership links, and other enabling state at
  the chokepoint, then routes failures to one canonical owner/thread so missing prerequisites fail
  once instead of resurfacing per run. *(Evidence: trend issue #1790; PR #1750.)*
- **Source-gap honest** — treats missing, stale, partial, or conflicting upstream inputs as
  first-class state: it calls out the gap, lowers confidence or blocks the proposal when needed,
  and never rounds feed failures or loading ambiguity into clean-looking numbers, empty success,
  or "all clear" UI. *(Evidence: PRs #2196, #2228, #2230;
  `docs/discovery/ideas/dispatch-and-driver-mobile-visibility.md`;
  `docs/discovery/ideas/embedded-telematics-usage-billing.md`;
  `docs/discovery/ideas/multi-state-rental-tax-automation.md`;
  https://getrenterra.com/streamline-operations/dispatch;
  https://getrenterra.com/damage-rental-protection/gps-tracking;
  https://getrenterra.com/learn-more/integrations;
  https://taxjar.com/product)*
- **Evidence-native** — captures the facts at the edge in structured, scoped, reviewer-ready
  bundles (photos, signatures, readings, checklist deltas, timestamps), preserves them across
  offline/reload paths, and avoids asking the approver to reconstruct the case from scattered
  systems. *(Evidence: PRs #1922, #1943, #1944, #1958;
  `docs/discovery/ideas/damage-loss-evidence-workflows.md`;
  `docs/discovery/ideas/automated-fuel-charge-recovery.md`;
  https://getrenterra.com/damage-rental-protection/mobile-inspections;
  https://getrenterra.com/damage-rental-protection/contract-esignatures;
  https://getrenterra.com/blog-posts/rising-fuel-costs-are-eating-into-rental-margins-are-you-recovering-every-dollar)*
- **Legible** — every proposal carries its evidence and reasoning; auditable after the fact.
- **Graceful under uncertainty** — knows when to escalate instead of guessing.
- **Measurable** — there is a number it moves (toil removed, $ recovered, latency cut) so we
  can tell if the insertion actually helped.
- **Idempotent / replay-safe** — re-running is safe; partial failure doesn't corrupt state.

## Anti-patterns (when NOT to make it agentic)

- **High-irreversibility, low-frequency** work — the human cost is small and the blast radius
  of a wrong call is large. Keep it manual.
- **Judgment that needs context the agent can't see** — relationship history, verbal
  agreements, intent. Don't fake it.
- **Cheaper-to-do-than-to-supervise** — if reviewing the agent's proposal costs more than just
  doing the task, the agent is negative ROI.
- **Locally correct, systemically noisy** — per-item agents that open sibling tickets for one
  shared blocker instead of collapsing to a canonical, correctly owned thread. *(Evidence: trend
  issue #1579; duplicate alerts #1547/#1548, #1566/#1567.)*
- **Scope bleed / permission mirage** — a workflow that looks role- or customer-scoped but leaks
  cross-account data, or collapses denied/missing access into plausible-looking empties, zeros, or
  "all clear" UI. If scope is uncertain, fail closed and say so. *(Evidence: PRs #1871, #1888,
  #1889; `docs/discovery/ideas/nl-operational-reporting.md`;
  `docs/discovery/ideas/self-service-rental-customer-portals.md`;
  https://getrenterra.com/manage-financials-reporting/ai-powered-reporting;
  https://getrenterra.com/manage-financials-reporting/customer-portal)*
- **Handoff amnesia** — a proposal that loses scoped context, evidence, or selection state across
  drill-down, back-navigation, or reload, forcing the human to re-investigate before they can
  dispose. *(Evidence: PRs #1544, #1556, #1568, #1620.)*
- **Ship-and-explain-later** — an operator-facing workflow that ships without the end-user guide
  or runbook needed to interpret its states, source-gap warnings, approval boundary, or next
  action, leaving the human dependent on tribal knowledge or implementation context. *(Evidence:
  trend issue #2426; issues #2423, #2422, #2254, #2253, #2252.)*
- **Shared-queue wedging** — workflows that run the heaviest path for every item or leave stale
  `in_progress` work behind, so unrelated items sit blocked behind a run that can never reach a
  terminal state. *(Evidence: trend issue #1633; PR #1615; alerts #1644, #1652.)*
- **Artifact churn / ticket firehose** — agents that rewrite good-enough outputs, reopen settled
  threads without new evidence, re-page a known outage on every unchanged run, or emit one
  task/ticket per micro-finding when a canonical roll-up or role-level thread would do. Reviewer
  attention is a shared resource; don't burn it. *(Evidence: PRs #1563, #1668, #1676, #2069;
  trend issue #1973; alert issues #2092, #2093, #2095, #2096, #2105, #2108, #2111.)*
- **Precondition rediscovery** — each run re-discovers the same missing secret, missing linked
  owner artifact, or other shared prerequisite because the workflow checks too late or routes to a
  fresh sibling thread each time. Fail once, under canonical ownership. *(Evidence: trend issue
  #1790; PR #1750.)*
- **Clean-looking source-gap masking** — workflows that silently convert missing telemetry,
  disconnected integrations, stale route data, or unresolved loading into plausible-looking zeroes,
  blank charts, empty success states, or confident recommendations. If the workflow cannot tell
  whether the world is quiet or the feed is missing, it is not ready to guide human action.
  *(Evidence: PRs #2196, #2228, #2230;
  `docs/discovery/ideas/dispatch-and-driver-mobile-visibility.md`;
  `docs/discovery/ideas/embedded-telematics-usage-billing.md`;
  `docs/discovery/ideas/multi-state-rental-tax-automation.md`;
  https://getrenterra.com/streamline-operations/dispatch;
  https://getrenterra.com/damage-rental-protection/gps-tracking;
  https://getrenterra.com/learn-more/integrations;
  https://taxjar.com/product)*
- **Evidence scavenger hunt** — proposals that depend on photos, notes, signatures, readings, or
  checklists spread across screens, lost on reload, or hidden behind the wrong scope boundary, so
  the human must reconstruct the case before they can decide. If the proof bundle is brittle, the
  agent is faking certainty. *(Evidence: PRs #1922, #1943, #1944, #1958;
  `docs/discovery/ideas/damage-loss-evidence-workflows.md`;
  `docs/discovery/ideas/automated-fuel-charge-recovery.md`;
  https://getrenterra.com/damage-rental-protection/mobile-inspections;
  https://getrenterra.com/damage-rental-protection/contract-esignatures;
  https://getrenterra.com/blog-posts/rising-fuel-costs-are-eating-into-rental-margins-are-you-recovering-every-dollar)*
- **"Agentic" as decoration** — inserting an LLM where a deterministic rule is simpler, cheaper,
  and more reliable. Prefer the rule.
- **Auto-applying across the floor** — never, in any version, without an explicit human signal.

## How this charter evolves

This is the point. Our definition of "great agentic" is expected to *move*:

- **Evidence-driven, not fashion.** Changes must cite evidence — internal outcomes (which agent
  insertions removed toil vs. created noise — the factory's own run history is the best corpus)
  and external signal (what competitors automate, what patterns become table-stakes).
- **Weekly reflection, human disposition.** The `agentic-reflector` proposes charter edits as a
  PR on the weekly cadence; a human merges. The git history of this file *is* the record of how
  our thinking changed.
- **The floor is sacred.** Reflection can raise the bar, add properties, retire anti-patterns —
  but never lowers "agents propose; humans dispose."

## Changelog

- **v12 (2026-06-20)** — Added a first-use/adoption lens question, an **Adoption-ready** rubric
  property, and a **Ship-and-explain-later** anti-pattern. This week's internal evidence shows a
  recurring blind spot: operator-facing agentic surfaces are shipping faster than the user guidance
  around them. Trend issue #2426 groups five post-ship documentation gaps across maintenance work
  orders, safety/compliance operations, transport analytics, technician queue, and account-health
  review (#2423, #2422, #2254, #2253, #2252). The lesson is not just "document the feature"; it
  is that a workflow is not great if the human it routes to cannot interpret the states,
  source-gap warnings, approval boundary, and next action without implementation context. No
  change to the non-negotiable floor.
- **v11 (2026-06-19)** — Added a source-freshness lens question, a **Source-gap honest** rubric
  property, and a **Clean-looking source-gap masking** anti-pattern. This week's internal work
  kept landing on the same lesson: once agentic workflows depend on live feeds, the quality bar is
  not just "use the source" but "say when the source is missing." PR #2228 explicitly flags
  missing or disagreeing transport inputs instead of defaulting to clean-looking KPI numbers; PR
  #2230 forces technician-queue findings to surface `insufficient_data:*` reasons and zero
  confidence when live state is stale or incomplete; PR #2196 removed a silent blank reporting
  region and replaced it with explicit loading/empty states. Discovery and market signal say this
  blind spot will matter more, not less: new feed-dependent opportunities this week center on
  driver mobile visibility, telematics-grounded billing, and cross-state tax automation
  (`docs/discovery/ideas/dispatch-and-driver-mobile-visibility.md`;
  `docs/discovery/ideas/embedded-telematics-usage-billing.md`;
  `docs/discovery/ideas/multi-state-rental-tax-automation.md`), while competitors now market
  dispatch boards, integrated telematics, and tax automation as baseline workflow surfaces
  (https://getrenterra.com/streamline-operations/dispatch;
  https://getrenterra.com/damage-rental-protection/gps-tracking;
  https://getrenterra.com/learn-more/integrations;
  https://taxjar.com/product). No change to the non-negotiable floor.
- **v10 (2026-06-18)** — Sharpened the no-op / genuine-new-signal lens question, the
  **Churn-resistant** rubric property, and the **Artifact churn / ticket firehose** anti-pattern
  to require a re-wake budget for known incidents: once an outage already has a canonical thread,
  recurring runs should append there and wake humans again only on material deltas or an explicit
  escalation threshold. This week's evidence says our current bar was still too soft. PR #2069
  added regression contracts for fingerprint-based E2E incident dedupe, but the monitoring corpus
  still shows repeated unchanged outage pages: trend issue #1973 documents persistent
  deduplication failures across open `auto:alert` / `auto:ops` incidents, and alert issues
  #2092, #2093, #2095, #2096, #2105, #2108, and #2111 all reopened the same E2E dev smoke
  failure family instead of converging on one canonical history. No change to the non-negotiable
  floor.
- **v9 (2026-06-17)** — Added an edge-evidence / proof-bundle lens question, an
  **Evidence-native** rubric property, and an **Evidence scavenger hunt** anti-pattern after this
  week's shipped field/mobile work and discovery signal converged on the same lesson: great
  agentic workflows do not just show evidence somewhere, they capture it at the point of work and
  preserve it as one scoped artifact the reviewer can actually dispose from. Internal evidence:
  PR #1922 created scoped proof-of-delivery bundles, PR #1943 collapsed repeated route exceptions
  into one review bundle, PR #1944 kept queued replay evidence visible across reload, and PR
  #1958 aligned tenant checklist capture with downstream comparison. Discovery + market evidence
  point the same way: damage-loss recovery, fuel recovery, and rental e-signatures are all being
  sold around reviewable proof trails and customer-shareable records
  (`docs/discovery/ideas/damage-loss-evidence-workflows.md`;
  `docs/discovery/ideas/automated-fuel-charge-recovery.md`;
  https://getrenterra.com/damage-rental-protection/mobile-inspections;
  https://getrenterra.com/damage-rental-protection/contract-esignatures;
  https://getrenterra.com/blog-posts/rising-fuel-costs-are-eating-into-rental-margins-are-you-recovering-every-dollar;
  https://www.pointofrental.com/esignature-software/). No change to the non-negotiable floor.
- **v8 (2026-06-16)** — Sharpened the input-legibility lens question to require authorization at
  the data boundary, added **Scope-safe** to the rubric, and added the **Scope bleed / permission
  mirage** anti-pattern. This week's shipped customer/reporting work repeated the same lesson:
  portal and operator-facing agentic surfaces must fail closed on missing scope and must not turn
  permission gaps into success-shaped defaults. Internal evidence: PR #1871 added portal-scoped
  rental/invoice visibility with explicit stale/missing-source gaps, PR #1888 locked the read-only
  ops finding alert to auth-only conditions across loading/error states, and PR #1889 fixed a
  permission gap that had been silently flattening KPI cards to zero. External and discovery
  evidence point the same way: self-service portals and AI-backed reporting are moving toward
  expected surfaces, so scope safety is part of the quality bar
  (`docs/discovery/ideas/nl-operational-reporting.md`;
  `docs/discovery/ideas/self-service-rental-customer-portals.md`;
  https://getrenterra.com/manage-financials-reporting/ai-powered-reporting;
  https://getrenterra.com/manage-financials-reporting/customer-portal). No change to the
  non-negotiable floor.
- **v7 (2026-06-15)** — Added a shared-prerequisite lens question, a **Prerequisite-aware**
  rubric property, and a **Precondition rediscovery** anti-pattern after this week's factory
  evidence surfaced the same failure shape twice: the dev E2E / deploy recovery path kept
  rediscovering a missing shared secret instead of failing once under a canonical incident
  (trend issue #1790), and stuck-PR recovery needed an explicit no-linked-issue branch so the
  workflow could identify/create the owning development issue before re-kicking (PR #1750). No
  change to the non-negotiable floor.
- **v6 (2026-06-14)** — Sharpened the first lens question to require naming the owning actor
  tier, and renamed **Operator-grounded** to **Actor-grounded** so the charter covers the full
  stakeholder spectrum rather than only internal operators. The evidence was this week's discovery
  prompt update expanding the operating model across external customers, field/mobile users,
  administrators, managers, and executives (#1679), plus the customer-portal dossier and
  competitor signal showing self-service customer workflows moving toward expected
  (`docs/discovery/ideas/self-service-rental-customer-portals.md`;
  https://getrenterra.com/blog-posts/what-is-a-customer-portal----and-why-your-rental-business-needs-one).
  No change to the non-negotiable floor.
- **v5 (2026-06-14)** — Added a no-op / genuine-new-signal lens question, a **Churn-resistant**
  rubric property, and an **Artifact churn / ticket firehose** anti-pattern after this week's
  discovery/factory workflow changes converged on the same lesson: healthy agents should leave
  good-enough artifacts alone, update canonical threads in place, and avoid per-task spray. The
  evidence came from the Trend Analyst's roll-up-only contract (#1563), the operating-model
  bridge's one-epic-per-role design that replaced auto-ticket flood (#1668), and the Domain
  Cartographer's explicit no-churn refinement rule (#1676). No change to the non-negotiable floor.
- **v4 (2026-06-14)** — Added a shared-queue / stale-run lens question, a **Queue-safe** rubric
  property, and a **Shared-queue wedging** anti-pattern after the factory surfaced a repo-wide
  queue-blocking failure mode: the `Temporal worker tests` required check never reached terminal
  state, wedging unrelated PRs until path-scoping and stale-run cancellation were added (#1633,
  #1615; alerts #1644, #1652). No change to the non-negotiable floor.
- **v3 (2026-06-14)** — Added a **Can the human dispose from the proposal itself?** lens
  question, a **Disposition-ready** rubric property, and a **Handoff amnesia** anti-pattern after
  repeated fixes showed that proposal context was getting lost across queue/filter/detail/reload
  transitions (#1544, #1556, #1568, #1620). No change to the non-negotiable floor.
- **v2 (2026-06-14)** — Added **Operator-grounded** to the rubric after the operating-model work
  grounded Product Owner, QA Manager, and Factory Architect in named role/task/frustration flows
  instead of abstract agentic opportunity (#1629). Added a lens question and anti-pattern for
  duplicate-collapse / ownership routing after the Trend Analyst surfaced repeated
  `factory-stuck` duplicate incidents and misrouted shared CI blockers (#1579, #1563; duplicate
  alerts #1547/#1548 and #1566/#1567). No change to the non-negotiable floor.
- **v1 (2026-06-14)** — Seed. Codified the floor, canonical loop, the design lens, the rubric,
  and anti-patterns from ADR-0020 + the Operations Factory spec.
