# ADR-0062: Human-gated promotion of a known-good digest, with per-environment data isolation

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** Owner (Ian), Factory Architect, Platform
- **Decision note:** Accepted in tech review on 2026-06-14 after the committed workflows, release-ledger wiring, and guardrail tests landed in this PR.
- **Supersedes/amends:** extends [ADR-0010](./0010-immutable-images-push-gating-digest-promotion.md) (digest promotion), [ADR-0012](./0012-aks-helm-multienv-gated-promotion.md) (gated promotion), [ADR-0021](./0021-azure-environment-topology.md) (Azure topology)

## Context

The delivery clock already promotes `dev → test → prod` carrying an immutable image
digest (ADR-0010/0012). Three gaps remained for a safe, owner-controlled release process:

1. **Promotion shipped whatever build you pointed at, with no notion of "known-good".**
   `deploy-test`/`deploy-prod` required a raw Build Images `run_id`; finding a build that
   had actually passed `pr-validation → deploy-dev → e2e-dev` smoke was manual archaeology.
   The head of `main` may carry a regression merged minutes ago; we frequently want to
   promote *yesterday's clean build*, not HEAD.
2. **The middle ("UAT") human gate was unconfigured.** `deploy-prod` has a protected
   `prod` Environment with required reviewers; `deploy-test` declared `environment: test`
   but no reviewers, so promotion to UAT wasn't actually gated.
3. **Environments shared one database.** All app namespaces pointed at the single
   `dia-supabase` stack, so "promoting to prod" would run prod against the same data
   dev mutates — making the promotion gate cosmetic where it matters most.

The owner's constraints: promotion `dev → UAT` and `UAT → prod` must be **human-approved**;
we should be able to promote a **specific older known-good commit**, not just HEAD; and we
want to **keep one AKS cluster with per-env namespaces** for cost/complexity now (splitting
clusters later is allowed). "UAT" is the existing `test` environment — kept named `test`
internally (namespace/secret/Environment churn isn't worth a rename); docs call it UAT.

## Decision

1. **Human gating is enforced by GitHub protected Environments + Required Reviewers** —
   the platform-native, audited mechanism, not labels. `deploy-test` (`environment: test`)
   and `deploy-prod` (`environment: prod`) both require a configured human reviewer before
   the deploy job runs. Dev stays auto-deploy; test/prod stay manual `workflow_dispatch`.
   Configuring reviewers on the `test` Environment is a repo-settings step (see the runbook).

2. **Promote a known-good commit by SHA.** When `e2e-dev` gating smoke passes on a build a
   Deploy Dev run just shipped, that exact commit is stamped **known-good** on an orphan
   `releases-ledger` branch (`known-good.jsonl` + `latest-known-good.txt`). `deploy-test`/
   `deploy-prod` take a `sha` input (preferred) and resolve the immutable digest **from ACR
   by the `:<sha>` tag** — images are tagged `:<sha>` permanently, so any past known-good
   build is promotable. The legacy `build_run_id` artifact path remains as a fallback;
   digest-artifact retention is raised 7 → 90 days as defense-in-depth, not a dependency.

3. **Compute stays on one cluster, separated by namespace** (`dia-dev`/`dia-test`/
   `dia-prod`) — the right cost/complexity trade-off now. Splitting prod onto its own
   cluster later (ADR-0021's `aks-selfheal-prod`) does not change the promotion model.

4. **Data is isolated per environment** — the real isolation boundary. Each environment
   gets its **own database/schema** (cheapest first step: distinct DB or schema in the one
   Postgres; each env's values + DB-bootstrap target only its own). A shared database across
   environments is not acceptable once UAT/prod carry meaningful data; this must be in place
   **before prod goes live** (prod values are still `example.com` placeholders today, so the
   timing is clean).

## Consequences

- The release decision is "pick a known-good SHA and approve" — a vetted artifact behind a
  platform-enforced human gate. **Rollback = re-promote the previous known-good SHA.**
- `deploy-test`/`deploy-prod` now need ACR pull creds (`ACR_USERNAME`/`ACR_PASSWORD`,
  `vars.ACR_LOGIN_SERVER`) to resolve digests on the `sha` path. The `build_run_id` path is
  unchanged for backward compatibility.
- A new orphan branch (`releases-ledger`) joins `ci-history`/`e2e-history` as machine-readable
  state; agents and a future promotion picker can read `latest-known-good.txt`.
- Per-env databases add operational surface (migrations/seed run per env) and a small cost,
  accepted as the price of a meaningful promotion gate.
- Known-good is only stamped on Deploy-Dev-triggered e2e runs (authoritative deployed SHA);
  hourly/dispatch e2e runs re-verify but don't stamp.

## Alternatives considered

- **Label/branch-based human gate** (e.g. `ready-for-release` + a merge) — rejected: not
  platform-enforced, an agent could self-advance it; Environments are auditable and external.
- **Promote by mutable tag (`latest`/`main`)** — rejected: violates ADR-0010 immutability and
  defeats "promote an older known-good build".
- **Depend on the digest artifact only** — rejected: 7/90-day retention caps how far back you
  can promote; ACR holds the digest permanently, so resolve-by-SHA is strictly more robust.
- **Separate cluster per environment now** — deferred: unnecessary cost/complexity; namespaces
  + per-env data give the isolation that matters. Revisit for prod per ADR-0021.
- **One shared database with row-level env tagging** — rejected: a deploy/migration mistake in
  one env would corrupt another; isolation must be physical (DB/schema).

## Evidence

- `.github/workflows/deploy-test.yml`, `deploy-prod.yml` — `sha` input + ACR digest resolution
- `.github/scripts/resolve-image-digest.sh` — digest-by-SHA from ACR
- `.github/scripts/release-ledger-record.mjs` + `e2e-dev.yml` (`Stamp known-good release`) — the ledger
- `.github/workflows/build-images.yml` — `:<sha>` tags; digest artifact retention 90d
- `docs/runbooks/promotion.md` — operator procedure + the Environment-reviewer setup step
- `docs/architecture/ci-cd-pipelines.md`, `deployment.md` — updated promotion path
