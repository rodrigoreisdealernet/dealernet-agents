---
slug: kebab-case-slug
title: One-line idea title
rung: signal                # signal | opportunity | idea | validated | ready
score:                      # RICE — populated by product-strategist at the `validated` rung
  reach: null
  impact: null              # 0.25 / 0.5 / 1 / 2 / 3
  confidence: null          # 0..1
  effort: null              # person-weeks
  rice: null                # (reach * impact * confidence) / effort
linked_issue: null          # GitHub issue number once promoted into the build funnel
initiative: null            # one of the standing Initiatives (#536–#541)
differentiator: ''          # why us, vs Renterra / RentalMan — required to reach `idea`
agentic_potential: unassessed   # unassessed | none | assist | automate (see docs/agentic-charter.md)
evidence_count: 0           # maintained by the helper; do not hand-edit
created: YYYY-MM-DD
last_reviewed: YYYY-MM-DD
---

# One-line idea title

## Problem / Opportunity
_What pain or market gap is this? Who feels it?_

## Hypothesis (the bet)
_If we build X, then Y. State the wager plainly._

## Evidence summary
_Synthesis of the evidence log. Every claim must trace to a record in evidence.jsonl._

## Differentiation (vs Renterra / RentalMan)
_Why us, why now, why better than the competition._

## Agentic angle
_Per docs/agentic-charter.md: what does a human decide/route here that the system could
investigate-and-propose (or safely act on with audit)? Name the insertion point, the
human-approval boundary, and the fallback-when-unsure — or 'none' + which anti-pattern._

## Scope sketch & open questions
_Rough boundaries + the questions that must be answered before design._

## Decision log
- YYYY-MM-DD — created at rung `signal`

<!--
Do NOT create or edit dossiers by hand. Use the helper:
  cd .github/tools/shared
  npx tsx src/discovery-store.ts new-idea <slug> "<title>" [--initiative N]
  npx tsx src/discovery-store.ts add-evidence <slug> <kind> <url> "<excerpt>"
  npx tsx src/discovery-store.ts set-rung <slug> <rung> --by <agent> --why "..."
The helper enforces the rung entry bars and maintains evidence_count / last_reviewed.
-->
