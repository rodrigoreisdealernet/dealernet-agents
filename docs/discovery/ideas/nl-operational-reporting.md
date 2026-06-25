---
slug: nl-operational-reporting
title: Natural-language operational reporting
rung: validated
score:
  reach: 800
  impact: 3
  confidence: 0.7
  effort: 8
  rice: 210
linked_issue: null
initiative: 536
differentiator: >-
  Renterra targets SMB rental houses; we can ground NL reporting in the enterprise multi-branch +
  contractor/project model (RentalMan), querying live tenant-scoped entities rather than a generic
  warehouse
agentic_potential: assist
evidence_count: 5
created: '2026-06-14'
last_reviewed: '2026-06-20'
---

# Natural-language operational reporting

> **Worked example dossier.** This shows what a `validated`-rung dossier looks like once
> the crew has matured it. It is real research (the Renterra signal is genuine) but is not
> yet linked to a build ticket — exactly the state the pipeline is meant to produce.

## Problem / Opportunity
Rental operators live in reports — utilization, overdue returns, branch P&L, fleet ROI —
but building them is slow and IT-mediated. Ad-hoc questions ("which branches had idle
excavators >14 days last quarter?") require an analyst or a saved-report request. The
people who feel it most are branch managers and ops leads who need an answer *now*, not a
ticket to BI.

## Hypothesis (the bet)
If we let operators ask questions in plain language and get a grounded, tenant-scoped
answer (table + chart + the SQL it ran), then self-serve reporting replaces a meaningful
share of analyst-mediated requests and becomes a visible differentiator in deals.

## Evidence summary
- Renterra already markets AI natural-language reporting as a headline feature → it is a
  competitive expectation, not a moonshot (`competitor`).
- Operators repeatedly cite manual report-building as a pain in category reviews (`review`).
- Natural-language BI is moving to table-stakes in vertical SaaS per analyst coverage (`market`).
- Feasibility: our Supabase/Postgres entity model already exposes the structured
  rental/billing entities an NL-to-SQL layer would target (`feasibility`).

_(Every bullet traces to a record in `../evidence/nl-operational-reporting/evidence.jsonl`.)_

## Differentiation (vs Renterra / RentalMan)
Renterra targets SMB rental houses. Our edge is grounding NL reporting in the **enterprise
multi-branch + contractor/project model** (RentalMan) and querying **live tenant-scoped
entities** with RLS enforced — not a generic warehouse — so answers respect branch/role
boundaries out of the box.

## Agentic angle
`agentic_potential: assist`. The whole feature *is* an agentic insertion: today a human (or
analyst) translates a question into a query and assembles the report. The agent investigates
(NL → grounded, RLS-safe SQL over real entities), proposes the answer **with the query it ran**,
and the human disposes — reads, refines, or escalates. It stays firmly on the **assist** side of
the charter floor: read-only, never writes, always shows its work. Fallback-when-unsure: if the
model can't ground the question confidently, it declines and offers the closest saved report
rather than guessing. A natural v2 explores *proactive* findings ("3 branches breached idle
thresholds this week") — still propose-only.

## Scope sketch & open questions
- **Scope sketch:** NL → SQL over a curated, RLS-safe view set; render table + chart;
  always show the generated query; never write.
- **Open questions (must resolve before `ready`):**
  - Which entity/view surface is safe to expose, and how do we bound it?
  - How do we guarantee RLS/tenant scoping survives the generated SQL?
  - Accuracy bar + fallback when the model is unsure?
  - Build vs. buy for the NL-to-SQL layer?

## Decision log
- 2026-06-20 — critic review kept rung at `validated` — Re-verified that `https://getrenterra.com/manage-financials-reporting/ai-powered-reporting` resolves and supports the newer AI-reporting competitor record, but the original homepage evidence (`https://getrenterra.com`) still does not support its recorded excerpt, `https://www.g2.com/categories/equipment-rental-software` and `https://www.gartner.com/en/topics/generative-ai` still return HTTP 403, and `https://www.postgresql.org/docs/current/textsearch.html` remains generic PostgreSQL documentation rather than evidence for a safe tenant-scoped NL-to-SQL surface. The idea is still a near-duplicate of epic #438 and epic #450, and the blocking open questions on safe query surface, RLS preservation, accuracy/fallback, and build-vs-buy remain unresolved.
- 2026-06-19 — critic review kept rung at `validated` — Re-verified that `https://getrenterra.com/manage-financials-reporting/ai-powered-reporting` resolves and supports only the newer AI-reporting competitor record, but the original homepage evidence (`https://getrenterra.com`) still does not support its recorded excerpt, `https://www.g2.com/categories/equipment-rental-software` and `https://www.gartner.com/en/topics/generative-ai` still return HTTP 403, and `https://www.postgresql.org/docs/current/textsearch.html` remains generic PostgreSQL documentation rather than evidence for a safe tenant-scoped NL-to-SQL surface. The idea is still a near-duplicate of epic #438, epic #450, and child stories #579/#580/#581/#583, and the blocking open questions on safe query surface, RLS preservation, accuracy/fallback, and build-vs-buy remain unresolved.
- 2026-06-16 — critic review kept rung at `validated` — Re-verified that `https://getrenterra.com/manage-financials-reporting/ai-powered-reporting` resolves and supports the newer competitor record, but `https://www.g2.com/categories/equipment-rental-software` and `https://www.gartner.com/en/topics/generative-ai` still return HTTP 403, `https://www.postgresql.org/docs/current/textsearch.html` remains generic PostgreSQL documentation rather than evidence for a safe tenant-scoped NL-to-SQL surface, the idea is still a near-duplicate of epic #438 plus child stories #579/#580/#581/#582/#583 and adjacent reporting epic #450, and the blocking open questions on safe surface, RLS preservation, accuracy/fallback, and build-vs-buy remain unresolved.
- 2026-06-15 — critic review kept rung at `validated` — Re-verified that `https://getrenterra.com/manage-financials-reporting/ai-powered-reporting` resolves and supports only the newer competitor record, but `https://www.g2.com/categories/equipment-rental-software` and `https://www.gartner.com/en/topics/generative-ai` still return HTTP 403, `https://www.postgresql.org/docs/current/textsearch.html` remains generic PostgreSQL documentation rather than evidence for our tenant-scoped entity surface, the idea is still a near-duplicate of epic #438 plus adjacent reporting epic #450, and the blocking open questions on safe surface, RLS preservation, accuracy/fallback, and build-vs-buy remain unresolved.
- 2026-06-14 — critic review kept rung at `validated` — re-verified refutation: source_url `https://www.g2.com/categories/equipment-rental-software` returned HTTP 403, so the recorded review excerpt could not be re-verified; source_url `https://www.gartner.com/en/topics/generative-ai` returned HTTP 403, so the recorded market excerpt could not be re-verified; `https://getrenterra.com` resolves but the verifiable page text is "AI-Powered Reporting" / "Ask questions and get instant answers backed by live data", not the recorded claim that Renterra markets "AI natural-language reporting as a headline capability in its Financials & Reporting pillar"; `https://www.postgresql.org/docs/current/textsearch.html` is generic PostgreSQL full-text-search documentation and does not evidence that our tenant-scoped rental/billing entity model is already exposed for NL-to-SQL; the idea remains a near-duplicate of epic #438, child stories #579/#580/#581/#583, and adjacent reporting epic #450; the dossier still lists blocking open questions on safe query surface, RLS preservation, accuracy/fallback, and build-vs-buy, so design is not `ready`.
- 2026-06-14 — critic review kept rung at `validated` — refuted for `ready`: source_url `https://www.g2.com/categories/equipment-rental-software` returned HTTP 403 so the excerpt could not be re-verified; source_url `https://www.gartner.com/en/topics/generative-ai` returned HTTP 403 so the excerpt could not be re-verified; `https://getrenterra.com` resolves but the page text verified was "AI-Powered Reporting", not the recorded excerpt about "AI natural-language reporting as a headline capability"; `https://www.postgresql.org/docs/current/textsearch.html` does not support the claim that our rental/billing entity model is already exposed to an NL-to-SQL layer; the idea duplicates epic #438 and child stories #579/#580/#581/#583; open questions in the dossier remain unresolved, so design is not yet ready.
- 2026-06-14 — rung `idea` → `validated` by product-strategist — RICE computed; 4 evidence records
- 2026-06-14 — rung `opportunity` → `idea` by product-strategist — differentiator framed
- 2026-06-14 — rung `signal` → `opportunity` by product-strategist — two corroborating signals
- 2026-06-14 — created at rung `signal`
