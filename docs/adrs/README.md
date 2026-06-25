# Architecture Decision Records (ADRs)

This directory records the significant architectural decisions made on this project, **why** they were made, and what we traded away. ADRs are the reference point for reviews: when we evaluate a change, a spec, or a deploy, we check it against these records to confirm we are still making the right decisions — and we add or supersede a record when we make a new one.

## Why we keep these

The first ~99 commits of this project executed many architectural decisions (the entity model, Temporal, the software factory, AKS/Helm deployment, self-hosted Supabase, Azure Front Door) **without** any of them being written down. That is exactly the failure mode these records exist to prevent: Azure Front Door was activated in front of the app before anyone recorded the decision, its origins, or its TLS contract. A review has nothing to check against if the decision was never articulated.

## Process

- **One decision per file**, named `NNNN-short-slug.md`, numbered sequentially.
- Use [`TEMPLATE.md`](./TEMPLATE.md). Keep each record short and concrete; cite **evidence** (commit hashes, PR numbers, file paths, live resource names).
- **Status** is one of: `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Deprecated`.
- An ADR is **immutable once Accepted** — to change a decision, write a new ADR that supersedes it and update the old one's status. Do not silently rewrite history.
- **When to write one:** any decision that is costly to reverse, shapes more than one component, picks one technology/pattern over alternatives, or changes a security/data/deploy boundary. When in doubt, write it.
- **Who:** the Factory Architect owns ADR authorship for designs it produces; the Tech Reviewer should flag any PR that makes an architectural decision without a corresponding ADR (see the maintenance note at the bottom).

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-generic-entity-model-scd2.md) | Generic entity model with SCD2 versioning | Accepted |
| [0002](./0002-additive-migrations-tech-reviewer-owns.md) | Additive-only migrations; Tech Reviewer owns migration review | Superseded by ADR-0031 |
| [0003](./0003-temporal-workflow-orchestration.md) | Temporal for workflow orchestration | Accepted |
| [0004](./0004-signal-driven-human-in-the-loop.md) | Signal-driven human-in-the-loop approval gates | Accepted |
| [0005](./0005-azure-openai-chat-with-tools-adapter.md) | Azure OpenAI `chat_with_tools` agentic adapter | Accepted |
| [0006](./0006-autonomous-software-factory.md) | Autonomous software factory via GitHub Actions + file-based agents | Accepted |
| [0007](./0007-copilot-implements-sdk-agents-orchestrate.md) | Copilot cloud agent implements; SDK agents orchestrate | Accepted |
| [0008](./0008-runner-placement-policy.md) | GitHub-hosted runners default; self-hosted for cluster/private ops | Accepted |
| [0009](./0009-label-driven-work-routing.md) | Queue/state label work-routing model | Accepted |
| [0010](./0010-immutable-images-push-gating-digest-promotion.md) | Immutable image builds, push gating, digest promotion | Accepted |
| [0011](./0011-k8s-manifest-validation-in-ci.md) | Kubernetes manifest validation in CI (helm lint + kubeconform) | Accepted |
| [0012](./0012-aks-helm-multienv-gated-promotion.md) | AKS + Helm chart + per-env values + gated promotion | Accepted |
| [0013](./0013-self-host-supabase-in-cluster.md) | Self-host open-source Supabase in-cluster (overrides managed) | Accepted |
| [0014](./0014-namespace-scoped-deploy-rbac.md) | Namespace-scoped RBAC for deploy runners | Accepted |
| [0015](./0015-azure-front-door-external-edge.md) | Azure Front Door as external edge + TLS termination; AKS LoadBalancer `:80` origins | Accepted |
| [0016](./0016-json-driven-ui-engine.md) | JSON-driven UI engine | Accepted |
| [0017](./0017-frontend-data-layer-supabase-anon.md) | Frontend data layer: TanStack + Supabase PostgREST, unauthenticated anon client | Accepted |
| [0018](./0018-real-environment-e2e.md) | Real-environment E2E (Playwright): gating smoke + non-gating experience tests | Accepted |
| [0019](./0019-app-layer-tenant-scoping-rls-deferred.md) | Application-layer tenant scoping; Postgres RLS deferred | Accepted |
| [0020](./0020-operations-factory-agentic-ops.md) | Operations Factory: Temporal-scheduled agentic ops workflows (config-in-DB) | Accepted |
| [0021](./0021-azure-environment-topology.md) | Azure environment topology (reference) | Accepted |
| [0022](./0022-frontend-prod-bundle-runtime-config.md) | Frontend production bundle serving with runtime browser config | Proposed |
| [0023](./0023-dev-db-bootstrap-in-cluster-job-boundary.md) | Dev DB bootstrap via in-cluster Job boundary | Accepted |
| [0024](./0024-authenticated-write-path-security-definer-rls.md) | Authenticated write path via SECURITY DEFINER RPCs + RLS role policies | Accepted |
| [0025](./0025-agent-cadence-pipelines.md) | Consolidate agents into staged cadence pipelines | Accepted |
| [0026](./0026-no-human-escalation-reviewers-terminal-decisions.md) | Factory reviewers reach terminal decisions in-lane — no human escalation, even for control-plane PRs | Accepted |
| [0027](./0027-standing-architecture-audits-and-behavioral-review.md) | Standing whole-repo architecture audits + behavior-over-existence review | Accepted |
| [0028](./0028-user-docs-manager-lane.md) | User Docs Manager lane for proactive end-user coverage | Accepted |
| [0029](./0029-least-privilege-runtime-defaults-app-workloads.md) | Least-privilege runtime defaults for app workloads | Accepted |
| [0030](./0030-project-plan-initiative-epic-story-hierarchy.md) | Project plan is a three-level Initiative → Epic → Story hierarchy | Accepted |
| [0031](./0031-pr-routing-db-signoff-and-needs-design-assignment-guard.md) | PR routing stays in PR lanes; Database Steward owns DB sign-off; PM skips `needs-design` assignment | Accepted |
| [0032](./0032-deploy-risk-prs-use-judgment-based-deployment-review-guidance.md) | Deploy-risk PRs use judgment-based deployment-review guidance in the existing reviewer handoff | Accepted |
| [0033](./0033-project-manager-owns-per-pr-pipeline-loop.md) | Project Manager owns the bounded per-PR PR loop; Tech Reviewer is the escalation reviewer | Accepted |
| [0034](./0034-admin-observability-ingress-oidc-boundary.md) | External admin observability ingress stays behind oauth2-proxy OIDC group gating | Superseded by ADR-0036 |
| [0035](./0035-enterprise-org-hierarchy.md) | Enterprise org hierarchy | Accepted |
| [0036](./0036-keycloak-platform-idp-supabase-federation.md) | Keycloak is the platform IdP while Supabase brokers app sessions | Accepted |
| [0037](./0037-integration-connector-framework.md) | Shared connector framework for third-party integrations | Accepted |
| [0038](./0038-provider-hosted-payments-token-boundary.md) | Provider-hosted payment collection and token-only saved methods | Accepted |
| [0039](./0039-portal-intake-bearer-token-boundary.md) | Portal intake bearer token stays client-only and tenant-bound | Accepted |
| [0040](./0040-e2e-portal-schedule-url-resolution-optional-without-service-key.md) | E2E portal schedule URL resolution is optional without service key | Accepted |
| [0041](./0041-mobile-field-runtime-capacitor-shell.md) | Capacitor shell for the field-mobile runtime | Accepted |
| [0042](./0042-quote-fee-engine-reset-path-ci-gate.md) | Dedicated reset-path CI gate for quote fee engine + tax presets | Accepted |
| [0043](./0043-customer-portal-passwordless-session-boundary.md) | Customer portal uses passwordless Supabase sessions with explicit access grants | Proposed |
| [0044](./0044-reporting-semantic-layer-query-boundary.md) | AI and BI reporting query a tenant-scoped semantic layer, not raw operational tables | Proposed |
| [0046](./0046-fleet-availability-calendar-reset-path-ci-gate.md) | Fleet availability calendar reset-path validation is a required PR gate | Accepted |
| [0048](./0048-maintenance-analytics-reset-path-ci-gate.md) | Dedicated CI gate for maintenance analytics migration reset-path validation | Accepted |
| [0049](./0049-inventory-item-type-reset-path-ci-gate.md) | Inventory item-type reset-path validation is a required PR gate | Accepted |
| [0051](./0051-public-storefront-anonymous-read-server-side-submit-boundary.md) | Public storefront uses curated anonymous reads and server-side submission | Proposed |
| [0062](./0062-gated-promotion-known-good-digest-per-env-data-isolation.md) | Human-gated promotion of a known-good digest; per-environment data isolation | Accepted |
| [0064](./0064-non-gating-quality-and-ux-observability-lanes.md) | Non-gating quality/coverage/UX observability lanes with ratchet-to-gate policy | Accepted |
| [0101](./0101-shared-file-overlap-detection-pr-enrichment.md) | Shared-file overlap detection in pr-enrichment as concurrent-PR drift guardrail | Accepted |

## Maintenance note

Keeping this index honest is the whole point. Factory policy enforcement:
- Tech Reviewer ADR-gate: a PR that adds/changes infra, swaps a library/service, introduces a new service, or changes a deploy/security/data boundary must link an ADR (or `docs/adrs/`) in the PR. If missing, request changes and add `needs-adr`.
- Factory Architect ADR authorship: when an architecture design/spec introduces or changes a decision, the Architect publishes the corresponding ADR(s) in `docs/adrs/` using `TEMPLATE.md`.
- Copilot implementation rule: when approved implementation changes introduce an architectural decision, include/update the ADR in `docs/adrs/` and reference it in the PR.
- Accepted ADRs are immutable. Changed decisions must be recorded via a new superseding ADR plus status/history updates to the prior ADR.
