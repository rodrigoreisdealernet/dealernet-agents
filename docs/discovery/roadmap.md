# Discovery Roadmap

> The rolling, human-readable view of the discovery funnel. The
> [`product-strategist`](../../.github/agents/product-strategist.agent.md) regenerates the
> tables below each night from the dossiers in [`ideas/`](ideas/). The canonical data is
> the dossiers + Project #15; this file is the at-a-glance digest.
>
> See [`README.md`](README.md) for the maturity ladder, storage model, and approval chains.

_Last updated: 2026-06-20 07:46 UTC_

## Funnel snapshot

| Rung | Count | Notes |
|------|-------|-------|
| `signal` | 5 | after-hours self-service handoffs remain the only single-source signal; customer onboarding/compliance, dispatch visibility, job-level profitability, and multi-state tax automation now have corroboration but still need fuller framing before promotion |
| `opportunity` | 2 | digital contract eSignatures and embedded telematics usage billing are now framed enterprise workflow problems with corroborating evidence |
| `idea` | 2 | integrated rental accounting automation and multi-location scaling now hold the active differentiated solution bets awaiting later sizing |
| `validated` | 6 | scored + evidenced ideas in operational reporting, fuel recovery, damage/loss, customer self-service, re-rent orchestration, and demand generation are closest to critic review |
| `ready` | 0 | design-ready; awaiting owner go/no-go into the build funnel |

## Validated & above (closest to build-ready)

| Idea | Rung | RICE | Initiative | Dossier |
|------|------|------|------------|---------|
| Natural-language operational reporting | `validated` | 210 | #536 Renterra parity | [`nl-operational-reporting`](ideas/nl-operational-reporting.md) |
| Automated fuel charge recovery | `validated` | 195 | #541 Agentic workflows | [`automated-fuel-charge-recovery`](ideas/automated-fuel-charge-recovery.md) |
| Damage-loss evidence workflows | `validated` | 171 | #536 Renterra parity | [`damage-loss-evidence-workflows`](ideas/damage-loss-evidence-workflows.md) |
| Self-service rental customer portals | `validated` | 162 | #541 Agentic workflows | [`self-service-rental-customer-portals`](ideas/self-service-rental-customer-portals.md) |
| Integrated re-rent workflows | `validated` | 141 | #538 Fleet network coordination | [`integrated-rerent-workflows`](ideas/integrated-rerent-workflows.md) |
| Integrated rental demand generation | `validated` | 135 | #536 Renterra parity | [`integrated-rental-demand-generation`](ideas/integrated-rental-demand-generation.md) |

## Nightly run summary

- **Dossiers enriched:** `embedded-telematics-usage-billing`, `after-hours-self-service-rental-handoffs`, and `integrated-rental-accounting-automation` were refreshed with tighter problem framing, clearer actor coverage, and stronger agentic-angle sections tied back to their evidence logs.
- **Scores set:** `self-service-rental-customer-portals` now carries `reach=900`, `impact=3`, `confidence=0.6`, `effort=10`, `RICE=162`.
- **Promotions made:** `embedded-telematics-usage-billing` (`signal` → `opportunity`) because two corroborating telematics signals now frame a clear usage-data workflow problem; `integrated-rental-accounting-automation` (`opportunity` → `idea`) because the differentiated enterprise accounting-automation bet is now explicit; `self-service-rental-customer-portals` (`idea` → `validated`) because the dossier now pairs strong demand evidence with a computed RICE score.
- **Stale dossiers still needing evidence:** `after-hours-self-service-rental-handoffs` remains a single-source signal and still needs corroboration; `customer-self-serve-onboarding-and-document-compliance`, `dispatch-and-driver-mobile-visibility`, `job-level-rental-profitability-visibility`, and `multi-state-rental-tax-automation` now have two-source corroboration but still need fuller framing before they should climb.

## Critic run summary

- **Ideas reviewed:** `automated-fuel-charge-recovery`, `damage-loss-evidence-workflows`, `integrated-rental-demand-generation`, `integrated-rerent-workflows`, `nl-operational-reporting`, and `self-service-rental-customer-portals`.
- **Citations checked:** 24 evidence records reviewed; 22 source URLs resolved, 2 returned HTTP 403 (`g2.com/categories/equipment-rental-software`, `gartner.com/en/topics/generative-ai`), and 3 resolved pages still failed excerpt/claim support (`integrated-rental-demand-generation`'s Integra record, plus the homepage and PostgreSQL feasibility records in `nl-operational-reporting`).
- **Promotions to `ready`:** none. No dossier cleared citations, claim support, distinctness, resolved open questions, and score sanity together.
- **Refutations recorded:** `automated-fuel-charge-recovery` still lacks resolved workflow decisions and defensible sizing; `damage-loss-evidence-workflows` overlaps epic #441 and story #2128; `integrated-rental-demand-generation` duplicates epics #427/#428 and still contains a paraphrased evidence record; `integrated-rerent-workflows` still lacks a resolved v1 wedge and approval boundary; `nl-operational-reporting` still has dead/unsupported evidence and duplicates epics #438/#450; `self-service-rental-customer-portals` overlaps epic #439 (and storefront boundary #427) and still has blocking scope questions.

## How an idea leaves this roadmap

A `ready` idea does **not** auto-enter the build pipeline. It waits here, fully dossiered,
until the owner gives the go/no-go — at which point it is linked to a tracked epic and
handed to the Factory Architect with `queue:architecture`. Everything below `ready` keeps
maturing a little every night.
