# ADR-0029: Least-privilege runtime defaults for app workloads

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Security review + maintainers
- **Supersedes / Superseded by:** —

## Context
The `frontend` and `temporal-worker` Kubernetes workloads were previously rendered
without pod/container `securityContext` hardening in `charts/app`, leaving root
execution, writable root filesystems, and privilege escalation enabled by default.
The same hardening change also required preserving frontend runtime config startup
behavior when `readOnlyRootFilesystem: true` is enabled.

## Decision
We enforce least-privilege runtime defaults for `frontend` and
`temporal-worker` in the Helm chart:
- pod-level: `runAsNonRoot: true`, explicit non-root `runAsUser`/`runAsGroup`,
  and `seccompProfile: RuntimeDefault`.
- container-level: `allowPrivilegeEscalation: false`,
  `readOnlyRootFilesystem: true`, and `capabilities.drop: [ALL]`.

Where write access is still required, we mount explicit writable `emptyDir`
paths rather than relying on a writable root filesystem.

## Consequences
- App workloads now run with non-root, least-privilege defaults.
- Any required writable paths must be explicitly declared as mounts.
- Environment-specific values can still override chart defaults where needed.

## Alternatives considered
- Keep workload hardening unset and rely on namespace policy only — rejected
  because this leaves insecure defaults in rendered manifests and reduces
  deployment portability.
- Disable `readOnlyRootFilesystem` — rejected because writable roots increase
  tamper/write surface and weaken runtime hardening.

## Evidence
- PR [#517](https://github.com/Volaris-AI/dia/pull/517): **Harden frontend and temporal-worker deployments with non-root, read-only, least-privilege runtime defaults**.
- `charts/app/values.yaml`
- `charts/app/templates/frontend-deployment.yaml`
- `charts/app/templates/temporal-worker-deployment.yaml`
- `frontend/docker/entrypoint.sh`
- `frontend/nginx/default.conf`
- `charts/app/ci-test.sh`
