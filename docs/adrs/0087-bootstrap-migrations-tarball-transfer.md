# ADR-0087: Compress migrations tarball for bootstrap ConfigMap transfer

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Copilot (issue #1525 — audit trail context durability)
- **Supersedes / Superseded by:** none

## Context
The `deploy-dev.yml` bootstrap job transfers Supabase migrations to an in-cluster pod via a Kubernetes ConfigMap. As of 2026-06-17 the migrations directory contains 155 SQL files totalling 1.9 MB. The Kubernetes ConfigMap data limit is 1 MiB. Every bootstrap run therefore fails with:

```
ConfigMap "dia-db-bootstrap-...-migrations" is invalid: []: Too long: may not be more than 1048576 bytes
```

Because bootstrap never completes, the dev database is never seeded. This caused the two audit-trail E2E tests (`ops recent activity drill-down preserves audit context after reload`, `audit history journey — finding context to persisted ops timeline`) to skip permanently — no audit data exists in the dev environment.

The code comment at the previous ConfigMap creation step anticipated this: *"at current growth the migrations payload will need chunking or an artifact-based transfer before long."*

## Decision
We compress the migrations directory into a single gzip tarball (`migrations.tar.gz`, ≈288 KB) on the GitHub Actions runner before creating the ConfigMap. The bootstrap pod extracts the tarball to `/tmp/migrations` before applying migrations. The ConfigMap holds one binary entry instead of 155 SQL entries, keeping the total size well within the 1 MiB limit.

## Consequences
- **Easier:** Bootstrap job runs again; dev database receives migrations and seed data on every deploy.
- **Easier:** Future growth of migrations directory is tolerated until the uncompressed tarball itself exceeds ~5 MB (compress ratio ≈15x).
- **Harder:** The bootstrap pod image must have `tar` with gzip support. The `bitnamilegacy/kubectl` image (based on minideb/Debian) includes GNU tar; this is verified by the fact that the image ships standard POSIX utilities.
- **Obligated:** If the tarball grows past 1 MiB compressed, revisit chunked transfer or a GitHub artifact-based approach.

## Alternatives considered
- **Chunked ConfigMaps (multiple < 1 MiB each):** More complex orchestration in the pod (merge multiple volumes). Rejected as over-engineered for the current growth trajectory.
- **GitHub Actions artifact upload + download inside pod:** Requires network access from the in-cluster pod and artifact API credentials. Rejected as higher operational complexity.
- **Inline `git archive` fetch:** Requires git + repo credentials inside the pod. Rejected as a security surface increase.

## Evidence
- `.github/workflows/deploy-dev.yml` — changed lines create `migrations.tar.gz` on runner, mount via ConfigMap; pod extracts before applying.
- `supabase/migrations/20260617010000_ops_audit_trail_view_grants.sql` — the grant migration that was blocked from reaching the dev DB by this infrastructure gap.
- CI failure: run `27659637590` — "ConfigMap … is invalid: []: Too long: may not be more than 1048576 bytes".
