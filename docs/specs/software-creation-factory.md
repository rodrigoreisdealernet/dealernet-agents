# Software Creation Factory Specification

## Overview
Create a reusable `.github` automation layer that turns this template repository into a software creation factory. The factory will use GitHub Actions as the control plane, Copilot SDK agents as orchestration/review/monitoring workers, Copilot cloud agent as the implementation worker, and GitHub-hosted plus self-hosted runners for isolated execution.

The baseline is the upstream repository's `.github`. When that repository's active workflows disagree with its README or agent docs, the active workflow files are treated as the source of truth.

## Metadata
- **Feature Name**: Software Creation Factory
- **Status**: Draft
- **Priority**: P0 - Critical
- **Target Repository**: `Volaris-AI/dia`
- **Target Release**: Incremental factory rollout
- **Owner**: TBD
- **Stakeholders**: Engineering, platform operations, product owner, QA
- **Created**: 2026-06-05
- **Last Updated**: 2026-06-05

## Target Repository
This factory will be implemented in `Volaris-AI/dia`.

Verified on 2026-06-05:

| Field | Value |
|---|---|
| Repository URL | `https://github.com/Volaris-AI/dia` |
| Visibility | Private |
| Default branch | `main` |
| Local remote | `origin` -> `https://github.com/Volaris-AI/dia` |

The rollout should grow this repository over time. The first implementation should make the GitHub-only factory useful before adding Kubernetes deployment mutation.

## Baseline Findings

### Active Factory Shape In the Upstream Baseline
The active `.github/workflows` directory defines these factory roles:

| Workflow | Trigger | Runner | Purpose |
|---|---:|---|---|
| `agent-product-owner.yml` | Every 5 minutes, manual | `self-hosted` | Triage, prioritize, maintain project board |
| `agent-project-manager.yml` | Every 5 minutes, manual | `self-hosted` | Assign work, manage Copilot PRs, review/merge |
| `agent-tech-reviewer.yml` | Every 15 minutes, manual | `self-hosted` | Deep PR review and infra-aware validation |
| `agent-qa-manager.yml` | Hourly, after dev deploy, manual | `self-hosted` | Test quality, coverage gaps, bug/test correlation |
| `agent-docs-improver.yml` | Hourly, manual | `self-hosted` | Identify recurring docs gaps and create issues |
| `agent-cluster-guardian.yml` | Hourly, manual | `self-hosted` | Kubernetes runtime inspection and remediation |
| `agent-operations-manager.yml` | Every 6 hours, manual | `self-hosted` | Runner, Azure, cost, capacity, backup checks |
| `monitor-actions.yml` | Every 15 minutes, manual | `ubuntu-latest` | GitHub Actions queue monitoring |
| `monitor-health.yml` | Every 5 minutes, manual | `self-hosted` | Endpoint and runner remediation trigger |
| `monitor-logs.yml` | Every 15 minutes, manual | split | Query logs on self-hosted, analyze on GitHub-hosted |
| `pr-validation.yml` | PR and push | `ubuntu-latest` | Lint, tests, security, Helm, Terraform checks |
| `pr-enrichment.yml` | PR | `ubuntu-latest` | Metadata, risk labels, CODEOWNERS/protected-path notes |
| `doc-drift-detector.yml` | PR closed/merged | `ubuntu-latest` | Post-merge docs drift detection |
| Deploy/remediation workflows | Push/manual/schedule | split | Environment deploys and runner/AKS maintenance |

Important baseline conflicts:
- The docs say Product Owner is weekly, but the active workflow runs it every 5 minutes. The factory baseline will use the workflow cadence unless explicitly changed.
- The docs describe some agents as GitHub-hosted, but active workflows run most agent jobs on `self-hosted`. The factory should preserve active workflow behavior where useful, but re-evaluate runner placement with GitHub-hosted as the default.
- The issue-label handler exists only under `workflows.disabled`; active orchestration relies primarily on Product Owner and Project Manager creating and assigning work rather than direct label-triggered issue execution. In this spec, that Project Manager role is called **Project Coordinator**; the baseline workflow file can still be named `agent-project-manager.yml`.
- The README says to avoid Octokit, but active `pr-enrichment.yml` uses `actions/github-script`. The factory should avoid Octokit inside Copilot SDK tools, but deterministic workflow steps may use `gh` or `actions/github-script` when simpler and scoped.

Runner placement note: the table above records the active upstream baseline. The reusable factory should not copy all of that runner placement. Most SDK control agents can run on GitHub-hosted runners; self-hosted should be reserved for jobs that need private environment access, cluster credentials, preinstalled private tooling, host-level remediation, or production-controlled secrets.

### Agent Runtime Pattern
The reusable runtime pattern is:
1. Store agent prompts in `.github/agents/*.agent.md`.
2. Load prompts with `.github/tools/shared/src/agent-loader.ts`.
3. Interpolate repository variables such as `owner`, `repo`, and issue/PR numbers.
4. Start a `CopilotClient` session using `COPILOT_TOKEN`.
5. Use auto-approved permissions in CI.
6. Let the agent operate primarily through shell commands, especially `gh`; reserve `az`, `kubectl`, `helm`, and other environment tools for workflows explicitly placed on self-hosted runners.
7. Write summaries to `$GITHUB_STEP_SUMMARY`.

This works, but the reusable version should centralize common behavior instead of duplicating it per tool.

## Goals And Non-Goals

### Goals
- Recreate the baseline `.github` factory in this template with a clean, configurable structure.
- Use GitHub Actions as the durable scheduler, event router, permissions boundary, and audit trail.
- Use Copilot SDK agents for planning, triage, review, QA analysis, documentation drift, CI diagnosis, and operations monitoring.
- Use Copilot cloud agent as the coding implementation worker by assigning issues or commenting `@copilot` on PRs.
- Support both GitHub-hosted runners and self-hosted runners with explicit labels and privilege boundaries.
- Make the automation portable across new projects created from this template.
- Keep enough guardrails that the factory can run frequently without creating issue spam, runaway PRs, or unsafe production changes.

### Non-Goals
- Do not implement the workflows in this draft.
- Do not copy Azure/AKS-specific remediations blindly into this Supabase/Temporal/Vite template.
- Do not require official GitHub Copilot Automations as the primary mechanism; they can be optional later.
- Do not grant agents broad secrets or production mutation rights by default.
- Do not auto-merge high-risk or protected-path changes without a human gate.

## External Platform Constraints
These constraints are current as of 2026-06-05 and should be rechecked during implementation:

- Copilot cloud agent works in a GitHub Actions-backed ephemeral development environment and can be invoked from external tools.
  Source: https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
- Copilot can be assigned to issues via API, with optional custom agent, model, target repo, and base branch fields.
  Source: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/start-copilot-sessions
- Repository custom agents live in `.github/agents/*.agent.md` and can be selected for Copilot cloud agent tasks.
  Source: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents
- Copilot SDK supports `CopilotClient`, `createSession`, `sendAndWait`, permission handlers, streaming, and hooks.
  Source: https://docs.github.com/en/copilot/how-tos/copilot-sdk/getting-started
- Copilot SDK hooks can enforce tool allowlists before execution.
  Source: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/hooks
- Self-hosted runner routing should use labels or groups, and labels are cumulative.
  Source: https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow
- GitHub Actions permissions should be set explicitly. Unspecified permissions become `none` once any permission is specified.
  Source: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- Copilot PR workflow runs may require explicit approval before Actions runs execute.
  Source: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/troubleshoot-cloud-agent
- Actions Runner Controller is GitHub's recommended Kubernetes-based solution for autoscaling self-hosted runners. ARC creates ephemeral runner pods through runner scale sets.
  Source: https://docs.github.com/en/actions/concepts/runners/actions-runner-controller
- GitHub recommends ephemeral self-hosted runners for autoscaling; persistent autoscaled runners are not recommended.
  Source: https://docs.github.com/en/actions/reference/runners/self-hosted-runners
- ARC deployment guidance recommends isolating runner pods from controller pods, passing secrets through Kubernetes secrets, and isolating production workloads because Actions jobs run arbitrary code.
  Source: https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets
- Copilot cloud agent normally uses `ubuntu-latest`, but organizations can configure it to use labeled runners or runner groups when sessions need larger runners or internal resource access.
  Source: https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/configure-runner-for-coding-agent
- Supabase self-hosting upstream is Docker-Compose-first, with community-driven Kubernetes Helm charts. **This project self-hosts Supabase on Kubernetes regardless** (project decision): we accept ownership of hardening, HA, backups, disaster recovery, monitoring, and upgrades as part of running our own cluster. The community Helm chart / equivalent manifests are the basis; we adapt and own them rather than depend on managed Supabase.
  Source: https://supabase.com/docs/guides/self-hosting
- The Temporal Helm chart deploys Temporal server components only and requires external persistence. Production-style values should reference existing Kubernetes secrets for database credentials.
  Source: https://github.com/temporalio/helm-charts
- GitHub Projects supports table, board, and roadmap layouts, custom fields, filtering, sorting, grouping, charts, and automation over issues and pull requests.
  Source: https://docs.github.com/issues/trying-out-the-new-projects-experience/about-projects
- GitHub roadmap views can use date, iteration, and milestone fields as visual markers.
  Source: https://docs.github.com/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-a-view
- GitHub Projects can show parent issue and sub-issue progress fields, which lets epics expose child-story progress directly on the roadmap.
  Source: https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields
- GitHub Issues support sub-issues, labels, issue types, assignees, projects, and milestones for planning and tracking work.
  Source: https://docs.github.com/en/issues/tracking-your-work-with-issues/quickstart

## Proposed Architecture

```text
Issues, PRs, schedules, deploys
        |
        v
GitHub Actions workflows
        |
        +--> GitHub-hosted runners
        |       - CI validation
        |       - PR enrichment
        |       - Actions queue monitor
        |       - SDK analysis that needs only GitHub API access
        |
        +--> Self-hosted runners
                - Environment-aware agents
                - Docker/local stack validation
                - Cloud/Kubernetes operations if configured
                - Runner maintenance

Copilot SDK control agents
        |
        +--> Create/update issues
        +--> Assign issues to copilot-swe-agent[bot]
        +--> Comment @copilot on existing PRs
        +--> Review, label, summarize, merge only where allowed

Copilot cloud agent implementation workers
        |
        +--> Branches and PRs
        +--> Tests and iteration
        +--> Human/agent review loop
```

The factory should separate three concerns:
- **Control plane**: workflows, schedules, permissions, concurrency, secrets, runner labels.
- **Agent runtime**: shared SDK client, prompt loading, timeouts, logging, tool policy, summary writing.
- **Factory policy**: labels, issue states, merge rules, protected paths, deployment gates, per-repo technology profile.

## Kubernetes Deployment Reality

### Recommended Production Shape
For this template, the production architecture should be Kubernetes-native for the app and workers, but not necessarily for every dependency.

| Component | Recommended production deployment | Rationale |
|---|---|---|
| Frontend | Container image, Kubernetes `Deployment`, `Service`, `Ingress`/Gateway | Simple stateless workload; easy blue/green or rolling deploys |
| Temporal worker | Container image, Kubernetes `Deployment` or KEDA-scaled worker | Stateless worker process; scales independently from frontend |
| Temporal service | Prefer Temporal Cloud for serious production; otherwise official Temporal Helm chart with external Postgres | Self-hosted Temporal is operationally real infrastructure, not just another app pod |
| Supabase/Postgres | **Self-host open-source Supabase in the Kubernetes cluster** (community Helm chart / manifests): Postgres, GoTrue auth, PostgREST, Kong gateway, Realtime, Storage, Meta, Studio. Migrations applied via `supabase db push`/SQL against the in-cluster Postgres. | **Decision: self-hosting is required** — the platform runs entirely on our own Kubernetes, no managed/3rd-party Supabase dependency. We own HA, backups, security, and upgrades as part of operating the cluster. |
| Supabase Edge Functions | Run the Supabase functions runtime in-cluster (or as separate app services) alongside the self-hosted stack | Keeps the whole data/edge plane inside our Kubernetes |
| GitHub Actions runners | ARC runner scale sets in Kubernetes, isolated from production workloads | Ephemeral runner pods match GitHub guidance and keep CI capacity elastic |
| Secrets | External secrets controller or cloud secret manager -> Kubernetes secrets | Keeps secrets out of repo and chart values |
| Observability | Prometheus/Grafana-compatible metrics, logs, traces, plus GitHub workflow summaries | Agents need enough evidence to triage without guessing |

The first factory implementation should support two deployment profiles:

- `local-compose`: current Docker Compose stack for local validation.
- `kubernetes-app`: application **and its data plane** run on Kubernetes — frontend, Temporal worker, and the **self-hosted open-source Supabase stack** all in-cluster.

**The data plane is self-hosted in-cluster, by decision.** The `kubernetes-app` profile deploys open-source Supabase (Postgres + GoTrue + PostgREST + Kong + Realtime + Storage + Meta + Studio) into the cluster and applies the repo's migrations to it; there is no dependency on managed/hosted Supabase. This accepts the operational burden (HA, backups, upgrades, security) as a deliberate platform choice — operating that stack is in scope, not an excuse to avoid it.

### Runner Topology
The runner plane should be separate from the application plane:

```text
GitHub Actions
  |
  +--> GitHub-hosted runners
  |     - cheap/default CI
  |     - PR metadata
  |     - Actions queue monitor
  |
  +--> ARC runner scale set: factory-build
  |     - image builds
  |     - integration tests
  |     - Docker/Compose/kind checks
  |
  +--> ARC runner scale set: factory-deploy-nonprod
  |     - kubectl/helm access to dev/test
  |     - smoke tests against nonprod
  |
  +--> ARC runner scale set: factory-prod-ops
        - production deploys/remediation
        - manual dispatch or protected environment approval only
```

Do not run arbitrary agent workflows on the same runner identity that can mutate production. The production runner scale set should be narrow, manually gated, and ideally isolated by runner group, namespace, service account, and Kubernetes RBAC.

### Runner Placement Policy
Default to GitHub-hosted runners. Move a workflow to self-hosted only when it has a concrete requirement that GitHub-hosted runners cannot satisfy safely.

Use **GitHub-hosted** for:

- Product Owner, Factory Architect, Project Coordinator, Tech Reviewer, QA Manager, Docs Improver, Security Reviewer, Database Steward, and Actions Monitor when they only need repo contents, GitHub API, Copilot SDK, package installs, CI artifacts, or public internet.
- PR enrichment, validation, linting, unit tests, type checks, dependency scans, static analysis, and issue/project board sync.
- Kubernetes manifest rendering, Helm template checks, schema validation, and policy checks that do not contact a live cluster.
- Container builds if registry credentials are available through normal GitHub Actions secrets and there is no private network dependency.

Use **self-hosted** for:

- `kubectl`, `helm upgrade`, live cluster inspection, pod logs, events, rollout status, or anything that talks to a private Kubernetes API.
- Deployment and rollback workflows for private clusters.
- Operations workflows that rely on pre-authenticated cloud CLIs, private network access, or organization-managed tools unavailable on GitHub-hosted runners.
- Runner health, disk cleanup, remediation, ARC diagnostics, and host-level maintenance.
- Smoke tests that must run from inside a private network or use environment-local secrets.
- Production workflows that require protected runner groups, environment approvals, and narrow RBAC.

Do **not** use self-hosted just because a workflow uses `gh`, `node`, `npm`, `tsx`, `python`, Docker, or the Copilot SDK. Those should stay GitHub-hosted unless the workflow also needs private environment reachability or privileged local tooling.

Recommended initial placement:

| Workflow / agent | Runner | Reason |
|---|---|---|
| Product Owner | `ubuntu-latest` | GitHub/project/issue operations only |
| Factory Architect | `ubuntu-latest` | Reads repo/docs/issues and creates specs/comments |
| Project Coordinator | `ubuntu-latest` | GitHub PR/issue/project/Copilot assignment flow |
| Tech Reviewer | `ubuntu-latest` by default; self-hosted only for live env review mode | Most PR review is repo/CI based |
| QA Manager | `ubuntu-latest` | Reads artifacts, merged PRs, tests, coverage |
| Docs Improver | `ubuntu-latest` | GitHub/doc analysis only |
| Security Reviewer | `ubuntu-latest` | Static review of code, workflows, dependencies |
| Database Steward | `ubuntu-latest` | Migration review and local/service-container validation |
| Platform Engineer | `ubuntu-latest` for CI/chart review; self-hosted for runner/cluster diagnostics | Split static platform review from live ops |
| Actions Monitor | `ubuntu-latest` | GitHub Actions API only |
| Release Manager | `ubuntu-latest` for release issue/notes; self-hosted deploy jobs for promotion | Separate release coordination from deploy execution |
| Build Images | `ubuntu-latest` unless private registry/network requires otherwise | Standard CI build path |
| Deploy Dev/Test/Prod | self-hosted or GitHub environment runner group | Needs cluster/environment access |
| Cluster Guardian | self-hosted | Needs live `kubectl`/Helm access |
| Operations Manager | split: `ubuntu-latest` for GitHub/board/cost APIs, self-hosted for private env checks | Avoid unnecessary privileged runner use |
| Runner cleanup/remediation | self-hosted | Host-level maintenance |

### Verified Existing Upstream-Baseline Infrastructure
Verified with `az`, `kubectl`, `helm`, and `gh` on 2026-06-05.

#### Azure Subscription
| Item | Value |
|---|---|
| Active subscription | `Volaris Alexandria - Subscription 1` |
| Subscription ID | `44542832-156a-4b4e-a4fd-5a182428ca1e` |
| Tenant | `Volaris Group` / `ourvolaris.onmicrosoft.com` |
| Tenant ID | `75c696ec-5bfb-4892-9a0c-9187a9061cd6` |

Accessible subscriptions also include `Volaris Alexandria - Subscription 2`, `Volaris Alexandria - Subscription 3`, `Volaris entitlement 7`, `Volaris entitlement 8`, and `Volaris entitlement 9`, but the verified `selfheal` AKS and runner resources are in Subscription 1.

#### Reusable AKS Clusters
| Environment | Cluster | Resource group | Region | State | Kubernetes | Notes |
|---|---|---|---|---|---|---|
| Nonprod | `aks-selfheal-staging` | `rg-selfheal-staging` | `eastus2` | Running / Succeeded | `1.33` (`v1.33.6` nodes) | Reachable via `kubectl`; VPA enabled; public API; Azure CNI; no network policy |
| Prod | `aks-selfheal-prod` | `rg-selfheal-prod` | `eastus2` | Running / Succeeded | `1.33` (`v1.33.6` nodes) | Reachable via `kubectl`; VPA enabled; public API; Azure CNI; no network policy |

Node pools:

| Cluster | Node pool | Mode | VM size | Count | Autoscaling | Current issue |
|---|---|---|---|---:|---|---|
| `aks-selfheal-staging` | `default` | System | `Standard_D2s_v5` | 2 | Enabled, min 2 max 4 | Ready |
| `aks-selfheal-staging` | `larger` | User | `Standard_D4s_v5` | 1 | Disabled | Ready |
| `aks-selfheal-prod` | `nodepool1` | System | `Standard_D2s_v5` | 5 | Disabled | Azure reports node pool provisioning `Failed`; two nodes are `Ready,SchedulingDisabled` |

Current namespaces:

| Cluster | Namespaces |
|---|---|
| `aks-selfheal-staging` | `default`, `dev`, `test`, `istio-system`, Kubernetes system namespaces |
| `aks-selfheal-prod` | `default`, `prod`, `ingress-nginx`, `istio-system`, Kubernetes system namespaces |

Current Helm releases:

| Cluster | Notable releases |
|---|---|
| `aks-selfheal-staging` | `app` in `dev` and `test`; `postgres`, `temporal`, and `keycloak` in `dev` and `test`; Istio 1.28.3; AKS managed overlay/VPA add-ons |
| `aks-selfheal-prod` | `app` in `prod`; `ingress-nginx`; Istio 1.28.3; AKS managed overlay/VPA add-ons |

Reuse recommendation:
- Reuse the clusters for prototype factory deployment only if we create new namespaces, for example `dia-dev`, `dia-test`, and `dia-prod`, rather than overwriting existing `dev`, `test`, or `prod`.
- Before using prod, resolve the `nodepool1` provisioning failure and decide whether the two scheduling-disabled nodes are intentional.
- Add namespace-specific RBAC/service accounts for deploy workflows instead of letting a generic runner identity mutate the whole cluster.
- If the long-term design uses GitHub OIDC or workload identity, enable/configure those deliberately; current clusters report OIDC issuer disabled.
- Network policy is currently `none`; if this template becomes production-facing, create or enable a network policy posture before relying on the cluster for sensitive workloads.

#### Container Registry And Front Door
| Resource | Value |
|---|---|
| Existing ACR | `acrselfhealstg` |
| ACR login server | `acrselfhealstg.azurecr.io` |
| ACR resource group | `rg-selfheal-staging` |
| ACR SKU | Basic |
| ACR admin user | Enabled |
| Existing dev URL variable | `https://selfheal-hydehhbpc6abfndc.a02.azurefd.net` |
| Existing Keycloak URL variable | `https://selfheal-hydehhbpc6abfndc.a02.azurefd.net/auth` |
| Existing staging Front Door profile | `selfheal-afd` in `rg-selfheal-staging` |
| Existing prod Front Door profile | `selfheal-prod-afd` in `rg-selfheal-prod` |

Reuse recommendation:
- Reuse `acrselfhealstg` for early image builds if repository credentials/RBAC are granted.
- Do not rely on ACR admin credentials as the long-term path; prefer scoped tokens, managed identity, or OIDC-based push where possible.
- Create new image repository names/tags for this template and avoid overwriting the upstream baseline images.
- Existing Front Door endpoints are tied to the upstream baseline routes; create separate endpoints/routes or use temporary ingress URLs for the new template.

#### Self-Hosted Runner Inventory
The upstream baseline repository currently reports three online self-hosted runners:

| GitHub runner | Status | Busy | Labels |
|---|---|---:|---|
| `github-runner-01` | Online | false | `self-hosted`, `Linux`, `X64`, `azure` |
| `github-runner-02` | Online | false | `self-hosted`, `Linux`, `X64`, `azure` |
| `github-runner-03` | Online | false | `self-hosted`, `Linux`, `X64`, `azure` |

Azure VM search found these runner-related VMs in Subscription 1:

| VM | Resource group | Region | Size | State | Identity | Public IP | Notes |
|---|---|---|---|---|---|---|---|
| `github-runner-01` | `github-runners-rg` | `eastus` | `Standard_D2s_v3` | Running | SystemAssigned | Present | Older documented repo-scoped runner VM |
| `vm-gh-runner` | `rg-selfheal-staging` | `eastus2` | `Standard_D2s_v5` | Running | SystemAssigned | Present | Staging runner VM referenced by operations docs |

Open runner question:
- GitHub shows `github-runner-02` and `github-runner-03` online, but Azure VM search across accessible Volaris subscriptions only found `github-runner-01` and `vm-gh-runner` by runner-like VM names. Before relying on these runners for the new factory, map the GitHub runner registrations to their actual hosts. They may be multiple runner services on one VM, differently named VMs, or hosts outside the visible Azure inventory.

Reuse recommendation:
- Do not reuse these repo-scoped runners directly for the new template unless they are re-registered at organization scope or specifically registered to the new repository.
- Keep most factory workflows on `ubuntu-latest`.
- Use self-hosted runners only for deploy, rollback, live cluster inspection, private-network smoke tests, and runner remediation.
- Prefer creating an org-level runner group or ARC runner scale sets with labels such as `factory-deploy-nonprod` and `factory-prod-ops`.
- If keeping VM runners, update docs/scripts to reflect the verified VM reality: `github-runners-rg` currently exposes only `github-runner-01`, while `rg-selfheal-staging` contains `vm-gh-runner`.

#### Existing GitHub Configuration
Verified non-secret repository variables in the upstream baseline repository:

| Variable | Value |
|---|---|
| `ACR_NAME` | `acrselfhealstg` |
| `ACR_LOGIN_SERVER` | `acrselfhealstg.azurecr.io` |
| `AKS_DEV_CLUSTER_NAME` | `aks-selfheal-staging` |
| `AKS_DEV_RESOURCE_GROUP` | `rg-selfheal-staging` |
| `AKS_STAGING_CLUSTER_NAME` | `aks-selfheal-staging` |
| `AKS_STAGING_RESOURCE_GROUP` | `rg-selfheal-staging` |
| `DEV_URL` | `https://selfheal-hydehhbpc6abfndc.a02.azurefd.net` |
| `KEYCLOAK_CLIENT_ID` | `eservices-web` |
| `KEYCLOAK_REALM` | `equivant-courts` |
| `KEYCLOAK_URL` | `https://selfheal-hydehhbpc6abfndc.a02.azurefd.net/auth` |

Verified secret names only; values were not read:

| Secret | Present |
|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | Yes |
| `COPILOT_MCP_GITHUB_PERSONAL_ACCESS_TOKEN` | Yes |
| `COPILOT_TOKEN` | Yes |
| `PROJECT_MANAGER_PAT` | Yes |

Configuration needed for this template if reusing the infrastructure:
- Create equivalent variables/secrets in the new repository.
- Add prod variables if production deploy workflows need them; the upstream baseline variables currently expose dev/staging AKS config but not an `AKS_PROD_*` pair through the variable API output.
- Add environment-specific URLs for this template rather than reusing the `selfheal` Front Door URL.
- Ensure `PROJECT_MANAGER_PAT` has access to the new repository and can assign Copilot, manage project items, and query workflow/runners as required.

### Kubernetes Release Flow
The realistic engineering-team flow should be:

1. Product Owner or Architect turns a request into an implementation-ready issue/spec.
2. Project Coordinator assigns clear issues to Copilot cloud agent, respecting max active PRs.
3. Copilot creates a PR.
4. PR validation runs on GitHub-hosted or build runner:
   - frontend lint/typecheck/tests
   - Temporal worker unit tests
   - Supabase migration validation
   - container build
   - Helm/Kubernetes manifest rendering
   - policy/security scan
5. Tech Reviewer, QA Manager, and Security Reviewer inspect the PR.
6. Merge to `main` builds and deploys dev automatically.
7. QA/smoke workflows validate dev and promote to test.
8. Release Manager promotes to prod through a protected environment.
9. SRE/Operations agents monitor runtime health and create targeted issues for regressions.
10. Docs/Handoff agents turn repeated failures into docs, runbooks, or follow-up issues.

This is closer to a real engineering team than the baseline, because it separates implementation, review, release, and operations authority.

### Kubernetes Artifacts Needed
The initial implementation should add these artifacts before enabling production automation:

- `charts/app` or `deploy/k8s`: frontend and Temporal worker manifests.
- `charts/app/values-dev.yaml`, `values-test.yaml`, `values-prod.yaml`.
- Image build workflow with immutable tags.
- `deploy-dev.yml`, `deploy-test.yml`, `deploy-prod.yml` adapted to this stack.
- Namespace bootstrap manifests.
- Kubernetes service accounts and RBAC for deploy runners.
- Secret references, not literal secrets.
- Smoke test workflow that validates frontend, worker connectivity, Temporal task queue registration, and database/migration state.
- Rollback workflow using Helm release history or GitOps revert.

## Engineering-Team Fidelity Assessment

The baseline agents are directionally right, but they do not yet fully mimic a healthy engineering team. They cover product, project management, review, QA, docs, operations, and cluster health. The missing pieces are release ownership, architecture/spec quality, security ownership, database ownership, and incident/postmortem discipline.

### Current Agents To Keep
- **Product Owner**: keep, but it should operate at product/backlog level, not constantly churn issues every five minutes without a throttle.
- **Project Coordinator**: keep the baseline Project Manager behavior; this is the core factory coordinator.
- **Tech Reviewer**: keep; make it stack-aware and keep it independent from Project Coordinator.
- **QA Manager**: keep; it should verify tests are meaningful, not merely present.
- **Docs Improver**: keep; it should create targeted issues rather than directly changing docs by default.
- **Actions Monitor**: keep; this maps to CI coordinator/build cop.
- **Operations Manager**: keep; it maps to SRE/platform operations.
- **Cluster Guardian**: keep only for Kubernetes profiles; make it nonprod-first and production-gated.

### Agents To Add Or Activate
| Agent | Team analogue | Why it matters |
|---|---|---|
| `factory-architect` | Staff engineer / architect | Turns vague goals into bounded specs, ADRs, interfaces, migration plans |
| `release-manager` | Release engineer | Owns promotion, rollback, deployment notes, environment gates |
| `security-reviewer` | AppSec engineer | Reviews auth, secrets, dependency risk, workflow permissions, data exposure |
| `database-steward` | DBA/data platform engineer | Reviews Supabase migrations, RLS, seed data, destructive changes, rollback plans |
| `platform-engineer` | Platform/devex engineer | Maintains charts, runner sets, CI reliability, developer tooling |
| `incident-manager` | Incident commander/SRE | Converts runtime failures into postmortems, follow-ups, and reliability work |
| `handoff-guardian` | Engineering manager / delivery lead | Ensures closed PRs/issues did not drop acceptance criteria |

Several of these already exist in the upstream baseline as disabled or prompt-only assets (`architect`, `security-auditor`, `handoff-guardian`, audit agents). The factory should activate a smaller, clearer subset rather than adding many overlapping auditors.

### Workflow Gaps To Add
| Workflow | Purpose | Runner |
|---|---|---|
| `agent-release-manager.yml` | Promote dev -> test -> prod, produce release notes, coordinate rollback | nonprod/prod deploy runner |
| `agent-security-reviewer.yml` | Review PRs touching auth, secrets, workflows, migrations, dependencies | GitHub-hosted or build runner |
| `agent-database-steward.yml` | Review migrations and seed changes; validate Supabase reset/migration safety | build runner |
| `k8s-render-validate.yml` | Render Helm/manifests, run schema/policy checks, produce diff summary | GitHub-hosted/build runner |
| `build-images.yml` | Build and push immutable app/worker images | build runner |
| `deploy-dev.yml` | Auto-deploy `main` to dev | nonprod deploy runner |
| `deploy-test.yml` | Promote validated dev image to test | nonprod deploy runner |
| `deploy-prod.yml` | Protected manual/proven promotion to prod | prod deploy runner |
| `smoke-dev-test-prod.yml` | Environment smoke checks and release verification | environment-specific runner |
| `rollback.yml` | Manual rollback by release/image/Helm revision | prod deploy runner |
| `postmortem-handoff.yml` | Convert incidents or failed prod deploys into follow-up issues | GitHub-hosted |

### Decision Rights
The factory should define who can do what:

- Product Owner can create and prioritize issues.
- Architect can create specs and ADRs, but not deploy.
- Project Coordinator can assign Copilot and comment/request changes. The baseline workflow/file name can remain `agent-project-manager.yml`.
- Tech Reviewer can approve low/medium-risk PRs, but cannot bypass protected paths.
- Security Reviewer can block PRs touching auth, secrets, workflows, or data exposure.
- Database Steward can block migrations.
- Release Manager can promote between environments, but prod needs protected environment approval.
- Operations/Cluster Guardian can remediate known nonprod issues automatically; production remediation should be limited to documented safe actions or require manual dispatch.

Without explicit decision rights, the agents will overlap and either duplicate comments or make unsafe decisions.

## Ticket Routing And Handoff Model

### Core Principle
The factory should use labels and project fields as the work router. Agents should not all search the whole repository looking for things to do.

There are two kinds of queues:

- **Discovery queues**: broad scans where an agent is allowed to find, merge, split, close, or reroute work. Only Product Owner, Project Coordinator, Actions Monitor, Operations Manager, and Handoff Guardian should have broad discovery authority.
- **Ownership queues**: narrow worklists where an agent only acts on issues or PRs explicitly routed to that persona. Factory Architect, Security Reviewer, Database Steward, Platform Engineer, Release Manager, QA Manager, and Cluster Guardian should mostly consume ownership queues.

This preserves the useful baseline behavior from Product Owner and Project Coordinator while avoiding every persona independently inventing work.

### Routing Labels
Use one active `queue:*` label per issue as the main owner:

| Queue label | Owner | Meaning |
|---|---|---|
| `queue:product` | Product Owner | Raw intake, prioritization, epic/story shaping |
| `queue:architecture` | Factory Architect | Needs technical design, ADR, interface definition, or decomposition |
| `queue:development` | Project Coordinator | Ready to assign to Copilot or a developer |
| `queue:review` | Tech Reviewer | PR or issue requires engineering review before progress |
| `queue:qa` | QA Manager | Needs test strategy, coverage, or quality validation |
| `queue:security` | Security Reviewer | Auth, secrets, permissions, dependency, or data exposure risk |
| `queue:database` | Database Steward | Supabase migration, RLS, seed, data model, rollback concern |
| `queue:platform` | Platform Engineer | CI, runners, charts, Kubernetes, deployment, observability |
| `queue:release` | Release Manager | Promotion, rollback, release note, environment gate |
| `queue:ops` | Operations or Cluster Guardian | Runtime alert, incident, environment health |
| `queue:docs` | Docs Improver | Documentation gap or recurring instruction problem |

Use one active workflow-state label:

| State label | Meaning |
|---|---|
| `needs-triage` | Raw issue; Product Owner has not shaped it |
| `needs-info` | Blocked on reporter or human clarification |
| `needs-design` | Requires architect review before implementation |
| `design-in-progress` | Architect is working the design |
| `design-approved` | Design is sufficient for implementation |
| `ready-for-dev` | Acceptance criteria and constraints are clear |
| `assigned-to-copilot` | Copilot cloud agent is assigned and expected to create a PR |
| `in-progress` | Work has an assignee or linked PR |
| `ready-for-review` | PR exists and validation is running or complete |
| `changes-requested` | Review found actionable fixes |
| `ready-for-release` | Merged and validated enough for release consideration |
| `released` | Production release completed |
| `blocked` | Cannot progress without dependency, decision, or access |

Labels are the routing mechanism; GitHub assignees are for humans and Copilot cloud agent. Do not rely on assigning abstract SDK personas unless the organization creates real bot/user accounts for them.

### Project Board Fields
Labels route automation. Project fields provide reporting and prioritization:

- `Status`: Triage, Design, Todo, In Progress, Review, Ready for Release, Done, Blocked.
- `Queue Owner`: Product, Architecture, Development, QA, Security, Database, Platform, Release, Ops, Docs.
- `Phase`: Foundation, Core Product, MVP, Scale/Harden, Future.
- `Risk`: Low, Medium, High, Critical.
- `Environment`: Local, Dev, Test, Prod, N/A.
- `Copilot Eligible`: Yes, No, Needs Human First.

Product Owner and Project Coordinator own board sync. Specialist agents may update only their queue/status fields for items they handled.

### How The Factory Architect Picks Up Work
The Factory Architect should not freely search for interesting technical problems. It should pick up work through explicit routing:

1. Product Owner routes a raw issue or epic to `queue:architecture` with `needs-design` when the work is ambiguous, cross-cutting, high-risk, or architectural.
2. Project Coordinator routes an issue back to `queue:architecture` when a `ready-for-dev` ticket is too vague for Copilot or needs design constraints before assignment.
3. Security Reviewer, Database Steward, Platform Engineer, QA Manager, or Operations may route to `queue:architecture` when their review finds a design-level decision is missing.
4. Humans can manually add `queue:architecture` and `needs-design`.

On each run, Factory Architect should query only:

```bash
gh issue list --state open --label "queue:architecture" --json number,title,labels,updatedAt --limit 20
gh issue list --state open --label "needs-design" --json number,title,labels,updatedAt --limit 20
```

It should prioritize:

1. Issues explicitly marked `priority:critical` or `priority:high`.
2. Issues blocking active epics or open PRs.
3. Epics without child stories.
4. Tickets returned by Project Coordinator because Copilot could not act.

Architect output should be one of:

- **Light design**: issue comment with scope, constraints, acceptance criteria, interfaces, test strategy, and risks; then labels `design-approved`, `queue:development`, `ready-for-dev`.
- **Formal spec needed**: create or request a `docs/specs/<slug>.md` spec and keep issue in `queue:architecture`, `design-in-progress` until reviewed.
- **ADR needed**: create or request `docs/adrs/<slug>.md`; route to `queue:review` or `queue:platform` if technical decision needs approval.
- **Not ready**: label `needs-info` and route back to `queue:product` with exact questions.
- **Split work**: create child stories, link them to the epic, route children to `queue:development`, keep parent as epic.

The architect should not assign Copilot directly except for a spec/ADR/documentation PR. Implementation assignment remains Project Coordinator's job.

### End-To-End Ticket Lifecycles

#### 1. Product Feature Lifecycle
```text
Human/product idea
  -> needs-triage + queue:product
  -> Product Owner validates priority, duplicate status, business value
  -> if small: ready-for-dev + queue:development
  -> if large/unclear: needs-design + queue:architecture
  -> Factory Architect designs/splits work
  -> design-approved + ready-for-dev + queue:development
  -> Project Coordinator assigns Copilot if active PR count < 3
  -> Copilot PR
  -> PR validation + enrichment
  -> Tech/QA/Security/Database/Platform review lanes as needed
  -> merge
  -> deploy dev
  -> QA smoke
  -> ready-for-release + queue:release
  -> Release Manager promotes
```

#### 2. Bug Lifecycle
```text
Human bug or monitor-created issue
  -> needs-triage + queue:product or queue:ops
  -> Product Owner confirms user impact and priority
  -> if root cause clear: ready-for-dev + queue:development
  -> if root cause unclear: queue:review or queue:platform for investigation
  -> if design flaw: queue:architecture + needs-design
  -> Project Coordinator assigns Copilot only after concrete acceptance criteria
  -> PR -> validation -> review -> release
```

#### 3. Runtime Alert Lifecycle
```text
Operations/Cluster Guardian/Actions Monitor detects problem
  -> creates or updates fingerprinted auto:alert issue
  -> queue:ops or queue:platform
  -> safe nonprod remediation may run immediately if documented
  -> if code fix needed: add ready-for-dev + queue:development
  -> if infra design needed: queue:architecture
  -> if prod impact: Incident Manager creates incident summary and follow-ups
```

#### 4. Database/Migration Lifecycle
```text
Issue or PR touches supabase/migrations, seed data, RLS, or schema docs
  -> queue:database or needs-database-review
  -> Database Steward checks reversibility, data loss, RLS, seed impact, reset safety
  -> if approved: database-reviewed + queue:development/review
  -> if blocked: changes-requested or needs-design with exact constraints
```

#### 5. Security-Sensitive Lifecycle
```text
Issue or PR touches auth, secrets, workflow permissions, dependency risk, data exposure
  -> queue:security or needs-security-review
  -> Security Reviewer defines required controls or blocks unsafe direction
  -> if implementation needed: queue:development + ready-for-dev
  -> if architectural decision needed: queue:architecture + needs-design
  -> PR cannot merge until security-reviewed
```

#### 6. Release Lifecycle
```text
Merged PRs on main
  -> build immutable images
  -> deploy dev automatically
  -> QA Manager and smoke workflows validate
  -> Release Manager opens/updates release issue
  -> promote to test
  -> collect release notes, risk, rollback plan
  -> protected prod deployment
  -> released + post-release health check
```

### Agent Discovery Rules
| Agent | May discover broad work? | Primary query |
|---|---:|---|
| Product Owner | Yes | `needs-triage`, epics, research/RFP labels, board gaps |
| Project Coordinator | Yes, but only for execution flow | open PRs, `ready-for-dev`, Copilot assignments, board sync |
| Factory Architect | No | `queue:architecture`, `needs-design` |
| Tech Reviewer | Limited to PR queue | open PRs, `requires-maintainer-review`, review requested |
| QA Manager | Limited | merged PRs, coverage artifacts, `queue:qa`, `needs-tests` |
| Security Reviewer | Limited | `queue:security`, PRs with protected/security-sensitive paths |
| Database Steward | Limited | `queue:database`, PRs touching migrations/schema/seed |
| Platform Engineer | Limited | `queue:platform`, CI/runner/chart/deploy failures |
| Release Manager | Limited | `queue:release`, merged commits, deploy status |
| Operations Manager | Yes for environment health | runners, cloud resources, budgets, backups |
| Cluster Guardian | Yes inside configured cluster scope | unhealthy pods, Helm releases, events |
| Docs Improver | Limited | recurring PR feedback, `queue:docs`, doc drift |
| Handoff Guardian | Yes for recently closed work | closed PRs/issues with incomplete acceptance criteria |

### Handoff Rules
- Every handoff comment must state: current finding, requested next owner, blocking question if any, and exact label transition made.
- An agent moving a ticket to another queue must remove the old `queue:*` label.
- An agent may add specialist review labels without taking ownership if the ticket still belongs in the current queue.
- Project Coordinator must not assign Copilot unless the ticket has `ready-for-dev`, acceptance criteria, and no `needs-*review` or `needs-design` blockers.
- Product Owner should not break down epics into implementation stories until either the work is straightforward or Architect has approved the design.
- Release Manager must not promote to prod unless validation, smoke, required reviews, and rollback notes are present.

### Suggested Schedule
Baseline cadence can remain for parity, but a healthier starting cadence is:

| Agent | Suggested trigger |
|---|---|
| Product Owner | hourly plus manual, not every 5 minutes unless backlog churn is high |
| Project Coordinator | every 5 minutes, matching baseline |
| Factory Architect | every 30-60 minutes plus `queue:architecture` label event |
| Tech Reviewer | every 15 minutes, matching baseline |
| QA Manager | hourly and after dev deploy |
| Security Reviewer | on PR label/path trigger plus hourly sweep |
| Database Steward | on PR path trigger plus hourly sweep |
| Platform Engineer | on CI/deploy failure plus scheduled sweep |
| Release Manager | after dev/test deployment success plus manual |
| Operations/Cluster Guardian | scheduled, profile-specific |
| Docs/Handoff Guardian | daily or post-merge/closed events |

## Roadmap Story: One Ticket Through The Factory

This story is the intended operating model. It combines the baseline Product Owner and Project Manager behavior with the new specialist personas.

### Scene 1: Intake Lands On The Roadmap
A human opens an issue:

> "Build customer onboarding so a tenant admin can create their first workspace, invite users, and see starter data."

The issue starts with:

- `needs-triage`
- `queue:product`
- no assignee

The Product Owner workflow runs. It performs the baseline broad scan: open issues, board gaps, duplicates, priorities, and epics. It decides this is not a one-ticket feature; it is an epic.

Product Owner actions:

1. Rename/refine the issue as an epic: `Epic: Tenant onboarding`.
2. Add it to the GitHub Project roadmap.
3. Set project fields:
   - `Status`: Triage
   - `Queue Owner`: Product
   - `Phase`: Core Product or MVP
   - `Risk`: Medium or High
   - `Environment`: N/A
   - `Copilot Eligible`: Needs Human First
   - target start/end dates or iteration, so it appears on the roadmap view
4. Add labels:
   - `enhancement`
   - `priority:high`
   - `queue:architecture`
   - `needs-design`
   - milestone/phase label
5. Write a product comment:
   - customer/user value
   - rough scope
   - out-of-scope notes
   - why it needs architecture before implementation

At this point, the roadmap view shows an epic-sized item. It is visible to humans and agents, but it is not assignable to Copilot yet.

### Scene 2: Architect Turns The Epic Into Buildable Work
The Factory Architect workflow runs on schedule or from the `queue:architecture` label event. It does not search the whole repo. It reads only `queue:architecture` and `needs-design`.

Architect actions:

1. Read the epic, README, architecture docs, Supabase schema docs, Temporal worker docs, and current frontend engine shape.
2. Decide whether this needs:
   - a light design comment,
   - a formal spec in `docs/specs/`,
   - an ADR in `docs/adrs/`,
   - or a split into child stories.
3. For this epic, create or request a formal spec because onboarding touches frontend routes, Supabase data model, Temporal workflows, auth, emails, and deployment smoke checks.
4. Add a design comment or spec with:
   - target user flow,
   - data model changes,
   - Temporal workflow boundaries,
   - frontend route/component boundaries,
   - security/RLS implications,
   - test strategy,
   - release/rollback notes,
   - implementation slices.
5. Create sub-issues under the epic:
   - `Story: Add tenant/workspace schema and RLS`
   - `Story: Build onboarding UI flow`
   - `Story: Add onboarding Temporal workflow`
   - `Story: Add invitation email activity`
   - `Story: Add onboarding smoke test and docs`

Each sub-issue is added to the same GitHub Project and linked as a sub-issue of the epic. The Project should expose `Parent issue` and `Sub-issue progress`, so the epic's roadmap row shows actual progress as children close.

Architect routes the child stories:

- Database story: `queue:database`, `needs-database-review`, `needs-design` if migration details are not complete.
- UI story: `queue:development`, `ready-for-dev`, `Copilot Eligible: Yes`.
- Temporal workflow story: `queue:development`, `ready-for-dev`, `Copilot Eligible: Yes`.
- Email/invitation story: `queue:security`, `needs-security-review` if secrets or external provider concerns exist.
- Smoke/docs story: `queue:qa` or `queue:development` depending on clarity.

The architect leaves the parent epic open with `design-approved` once the split is coherent. It does not assign Copilot to implementation tickets.

### Scene 3: Specialist Preflight Removes Known Risk
Specialist agents pick up only their routed queues.

Database Steward sees the migration story:

1. Checks proposed schema against existing Supabase migrations and seed data.
2. Requires additive migration, RLS policy tests, and reset validation.
3. If clear, changes labels to `database-reviewed`, `queue:development`, `ready-for-dev`.
4. If unclear, routes back to `queue:architecture` with exact missing decisions.

Security Reviewer sees invitation/auth-sensitive work:

1. Defines required controls: token expiry, no secrets in repo, least-privilege service role use, audit logging, user enumeration protections.
2. If implementable, changes labels to `security-reviewed`, `queue:development`, `ready-for-dev`.
3. If there is a platform decision, routes to `queue:architecture`.

QA Manager may add test expectations before implementation:

1. Required unit tests.
2. Required frontend interaction tests.
3. Required smoke test after dev deploy.
4. Labels `qa-reviewed` or `needs-tests`.

This stage keeps Copilot from receiving vague or unsafe work.

### Scene 4: Project Coordinator Feeds Copilot
The Project Coordinator workflow runs every five minutes, preserving the strongest baseline behavior.

It gathers:

- open PRs,
- open issues,
- Copilot assignments,
- recent workflow runs,
- project board state.

It first clears flow:

1. Review/merge/nudge existing Copilot PRs.
2. Investigate Copilot PR workflows stuck in `action_required` and escalate persistent backlogs to platform/maintainers.
3. Clean up dead Copilot assignments older than the threshold.
4. Sync project statuses.

Only after that does it assign new work. It selects from:

```text
queue:development + ready-for-dev
no needs-design
no needs-security-review
no needs-database-review
no needs-platform-review
Copilot Eligible = Yes
```

It respects the baseline concurrency rule:

- target 2 active Copilot assignments,
- hard max 3 open Copilot PRs,
- no new assignments if there are already 3 open Copilot PRs.

When it assigns Copilot, it updates:

- issue label: `assigned-to-copilot`
- project `Status`: In Progress
- project `Queue Owner`: Development
- handoff comment: "Assigned to Copilot because acceptance criteria and required reviews are complete."

### Scene 5: PR Enrichment Creates Review Lanes
Copilot opens a PR linked to a child story.

`pr-enrichment.yml` runs:

1. Detects changed files.
2. Adds risk label:
   - `risk:low`
   - `risk:medium`
   - `risk:high`
3. Adds specialist review labels from paths:
   - `supabase/migrations/**` -> `needs-database-review`
   - `.github/workflows/**` -> `needs-platform-review` and `requires-maintainer-review`
   - auth/secrets-sensitive files -> `needs-security-review`
   - frontend/worker code without test changes -> `needs-tests`
4. Updates the Project item:
   - `Status`: Review
   - `Queue Owner`: Review or specialist queue
5. Posts a concise PR analysis summary.

`pr-validation.yml` runs:

- frontend lint/typecheck/tests,
- Temporal worker tests,
- migration validation when available,
- container build/render checks,
- security/dependency checks,
- validation summary.

### Scene 6: Review Agents Act Like A Review Team
Tech Reviewer reads PRs that are open, review-requested, or labeled `queue:review`/`requires-maintainer-review`.

It does not replace specialists. It coordinates engineering quality:

- Does the PR satisfy the linked issue?
- Are tests meaningful?
- Are changes scoped?
- Are architecture constraints followed?
- Are all specialist review labels resolved?

Specialist review agents act on their lanes:

- Database Steward removes `needs-database-review` and adds `database-reviewed`, or requests changes.
- Security Reviewer removes `needs-security-review` and adds `security-reviewed`, or blocks.
- Platform Engineer removes `needs-platform-review` and adds `platform-reviewed`, or blocks.
- QA Manager removes `needs-tests`/adds `qa-reviewed`, or creates a test-gap issue.

Project Coordinator continues to nudge Copilot when CI fails or review feedback is actionable:

```text
@copilot CI failing in frontend test: <specific failure>. Please fix without expanding scope.
```

If the PR changes protected paths, is large, or has unresolved specialist blockers, Project Coordinator does not merge it.

### Scene 7: Merge Updates The Roadmap
When validation passes and required reviews are complete:

1. Tech Reviewer or Project Coordinator approves low-risk PRs if auto-merge is enabled.
2. Otherwise a human approves/merges.
3. The issue closes through `Fixes #...`.
4. Project Coordinator syncs:
   - child issue `Status`: Done
   - child issue labels: remove active queue/state labels, add completion marker if needed
   - parent epic `Sub-issue progress`: automatically advances in the Project view
5. If all child stories close, Product Owner or Project Coordinator marks the epic ready for release or done depending on deployment status.

The roadmap now shows actual epic progress, not just a pile of closed PRs.

### Scene 8: Release Manager Promotes The Work
Merge to `main` triggers image build and dev deploy.

Release Manager watches:

- successful dev deployment,
- smoke test status,
- QA signoff,
- unresolved release blockers,
- rollback notes,
- linked epic/child issue status.

It opens or updates a release issue:

- `queue:release`
- `ready-for-release`
- release notes,
- included PRs/issues,
- risk assessment,
- rollback plan,
- environment promotion checklist.

Then:

1. Promote dev -> test.
2. Wait for smoke tests and QA.
3. Request protected production deployment approval.
4. Promote to prod.
5. Confirm post-release health.
6. Mark release issue `released`.
7. Update epic/project status.

### Scene 9: Feedback Loops Close The System
After release:

- Operations Manager and Cluster Guardian watch runtime health.
- Actions Monitor watches CI/deploy health.
- QA Manager watches coverage and bug/test correlation.
- Docs Improver looks for recurring mistakes or review feedback.
- Handoff Guardian checks closed issues/PRs for incomplete acceptance criteria.

If something breaks, the factory creates a fingerprinted issue and routes it back into the same queues. The point is not that agents avoid all failure; it is that failure becomes structured work with an owner, a queue, and a roadmap impact.

### Required Workflows For This Story
| Workflow | Needed for story? | Responsibility | Runner |
|---|---:|---|---|
| `agent-product-owner.yml` | Yes | Intake, roadmap, epics, priority, child-story shaping | `ubuntu-latest` |
| `agent-factory-architect.yml` | Yes | Design queue, specs, ADRs, decomposition | `ubuntu-latest` |
| `agent-project-manager.yml` / Project Coordinator | Yes | PR flow, Copilot assignment, board sync | `ubuntu-latest` |
| `agent-database-steward.yml` | Yes | Migration/data/RLS preflight and PR review | `ubuntu-latest` |
| `agent-security-reviewer.yml` | Yes | Auth/secrets/workflow/security review | `ubuntu-latest` |
| `agent-qa-manager.yml` | Yes | Test quality, coverage, smoke expectations | `ubuntu-latest` |
| `agent-tech-reviewer.yml` | Yes | General engineering review and merge readiness | `ubuntu-latest` |
| `pr-enrichment.yml` | Yes | Risk labels, review lanes, project metadata | `ubuntu-latest` |
| `pr-validation.yml` | Yes | CI quality gate | `ubuntu-latest` |
| `build-images.yml` | Yes for Kubernetes | Immutable image build | `ubuntu-latest` unless private registry/network |
| `deploy-dev.yml` | Yes for Kubernetes | Automatic dev deployment | self-hosted deploy runner if cluster is private |
| `deploy-test.yml` | Yes for Kubernetes | Promotion to test | self-hosted deploy runner if cluster is private |
| `deploy-prod.yml` | Yes for Kubernetes | Protected production promotion | self-hosted prod runner group |
| `agent-release-manager.yml` | Yes for Kubernetes | Release issue, promotion, rollback, notes | `ubuntu-latest` for coordination; deploy workflows self-hosted |
| `monitor-actions.yml` | Yes | CI/deploy queue health | `ubuntu-latest` |
| `agent-operations-manager.yml` | Yes | Runner/environment/capacity health | split: `ubuntu-latest` plus self-hosted for private checks |
| `agent-cluster-guardian.yml` | Kubernetes profile only | Runtime cluster health and safe remediation | self-hosted cluster runner |
| `agent-docs-improver.yml` | Yes | Recurring docs/process gaps | `ubuntu-latest` |
| `agent-handoff-guardian.yml` | Recommended | Prevent incomplete closure | `ubuntu-latest` |

### Minimum Viable Factory
The smallest version that still tells this story:

1. Product Owner
2. Factory Architect
3. Project Coordinator
4. PR Enrichment
5. PR Validation
6. Tech Reviewer
7. QA Manager
8. Release Manager
9. Actions Monitor

Database Steward, Security Reviewer, Platform Engineer, Operations Manager, Cluster Guardian, Docs Improver, and Handoff Guardian are the next layer. They become mandatory once the Kubernetes deployment profile is active or once the app handles real user/security-sensitive data.

## Required Artifacts To Create

### 1. `.github/factory.yml`
A single repo-local configuration file that parameterizes the factory:

```yaml
repository:
  owner: Volaris-AI
  name: dia
  default_branch: main

factory:
  max_open_copilot_prs: 3
  auto_merge_low_risk: false
  active_runner_profile: github-hosted-mvp

runners:
  default_agent: ubuntu-latest
  github_hosted: ubuntu-latest
  self_hosted:
    build: [self-hosted, linux, x64, factory-build]
    deploy_nonprod: [self-hosted, linux, x64, factory-deploy-nonprod]
    prod_ops: [self-hosted, linux, x64, factory-prod-ops]

stack:
  frontend: vite-react
  worker: temporal-python
  database: supabase-postgres
  deployment: docker-compose
  deployment_profiles:
    - local-compose
    - kubernetes-app # future profile; disabled in MVP

commands:
  validate:
    - make up
    - make db-validate
    - make e2e-validate
  frontend_test:
    - npm --prefix frontend test -- --run
  worker_test:
    - python -m pytest temporal/tests
```

The implementation should tolerate missing commands and mark them as skipped with a clear summary rather than failing before the template has full tests.

## Implementation Readiness Cut
Use an incremental rollout. The first implementation should prove ticket flow, Copilot assignment, PR validation, and roadmap coordination before any workflow mutates Kubernetes.

### MVP: GitHub-Only Factory
Goal: make the software factory useful inside `Volaris-AI/dia` without requiring self-hosted runners or live cluster access.

MVP includes:

- `.github/factory.yml`
- `.github/copilot-instructions.md`
- label/project bootstrap docs or script
- shared Copilot SDK runtime
- Product Owner agent
- Factory Architect agent
- Project Coordinator agent using the baseline Project Manager behavior
- Tech Reviewer agent
- QA Manager agent
- Actions Monitor agent
- PR Enrichment workflow
- PR Validation workflow for the current template stack
- Copilot assignment helper with max 3 open Copilot PRs

MVP excludes:

- live Kubernetes deploys
- production promotion
- Cluster Guardian
- self-hosted runner remediation
- Azure cost/capacity automation
- Front Door changes
- direct writes to existing `dev`, `test`, or `prod` namespaces

All MVP workflows should run on `ubuntu-latest`.

### Phase 2: Kubernetes Nonprod Profile
Goal: deploy this template to Kubernetes without touching existing the upstream baseline namespaces.

Add:

- `charts/app` or `deploy/k8s`
- image build workflow using `acrselfhealstg`
- namespaces such as `dia-dev` and `dia-test`
- namespace-scoped RBAC/service accounts
- self-hosted deploy runner or protected runner group
- `deploy-dev.yml`
- `deploy-test.yml`
- smoke tests
- Release Manager coordination workflow

Phase 2 must not use `dev`, `test`, or `prod` namespaces that already belong to the upstream baseline.

### Phase 3: Production Profile
Goal: production deployment only after nonprod release flow is reliable.

Add:

- `dia-prod` namespace or separate production cluster decision
- protected environment approvals
- rollback workflow
- production Release Manager gates
- Cluster Guardian for runtime inspection
- Operations Manager private checks
- network policy/security posture decision

Before Phase 3, resolve or consciously accept the current `aks-selfheal-prod` node pool issue.

### 2. `.github/agents/*.agent.md`
Initial agents should be adapted from the upstream baseline, but generalized:

- `product-owner.agent.md`: issue triage, backlog shaping, project board maintenance.
- `project-manager.agent.md`: assignment, Copilot PR flow control, stale work cleanup.
- `tech-reviewer.agent.md`: code review, protected-path checks, merge readiness.
- `qa-manager.agent.md`: coverage and test quality analysis.
- `docs-improver.agent.md`: recurring docs drift and instruction gaps.
- `actions-monitor.agent.md`: CI queue, failed run analysis, duplicate issue updates.
- `operations-manager.agent.md`: runner and environment health.
- `factory-architect.agent.md`: converts product requests into implementation-ready specs.
- `release-manager.agent.md`: environment promotion, rollback, release notes, deploy gates.
- `security-reviewer.agent.md`: security-sensitive PR review and workflow permission review.
- `database-steward.agent.md`: migration, RLS, seed data, and rollback review.
- `platform-engineer.agent.md`: charts, runner scale sets, CI reliability, developer tooling.
- Optional later: `security-auditor`, `infrastructure-auditor`, `handoff-guardian`, `audit-orchestrator`.

Agent prompts must be stack-aware. For this repo, they should reference Supabase migrations, Temporal worker code, Vite/React frontend, Docker Compose, and the repository docs instead of AKS-only assumptions.

### 3. `.github/tools/shared`
Create a shared TypeScript package with:

- `agent-loader.ts`: robust frontmatter parsing for `.agent.md` files.
- `factory-config.ts`: load and validate `.github/factory.yml`.
- `github-context.ts`: derive owner/repo/run URLs from environment.
- `run-agent.ts`: generic Copilot SDK session runner.
- `permissions.ts`: permission handler and hook policy.
- `logging.ts`: single-line structured logs.
- `dedupe.ts`: issue/comment fingerprint helpers.
- `copilot-assignment.ts`: helper to assign issues to Copilot cloud agent via `gh api`.
- `safe-run.ts`: timeout handling for SDK `sendAndWait`.
- Tests for all shared behavior.

The baseline auto-approves all SDK tool use. The factory should preserve baseline parity for the first port, but the shared runtime should support stricter profiles:
- `read_only`
- `github_write`
- `repo_write`
- `environment_mutating`

### 4. `.github/tools/<agent>`
Create thin per-agent tools only where needed. Most agents should call the shared runner with an agent name and prompt file rather than duplicating SDK setup.

Example desired shape:

```text
.github/tools/
  shared/
  agent-runner/
  qa-manager/
  pr-enrichment/
  validation-summary/
```

The current baseline has many independent `package.json` files and duplicated SDK boilerplate. The factory should start with a shared runtime and add bespoke packages only for deterministic analyzers such as QA coverage parsing.

### 5. Workflow Set
Create an initial active workflow set based on the upstream baseline:

| Workflow | Baseline | Initial Template Adaptation | Recommended runner |
|---|---|---|---|
| `agent-product-owner.yml` | Every 5 min, self-hosted | Same behavior, configurable cadence | `ubuntu-latest` |
| `agent-project-manager.yml` | Every 5 min, self-hosted | Same behavior; enforce max Copilot PRs | `ubuntu-latest` |
| `agent-factory-architect.yml` | New | Design/spec/ADR queue | `ubuntu-latest` |
| `agent-tech-reviewer.yml` | Every 15 min, self-hosted | Stack-aware review; no live env checks by default | `ubuntu-latest` |
| `agent-qa-manager.yml` | Hourly and after dev deploy | Same event model; use test/coverage artifacts | `ubuntu-latest` |
| `agent-security-reviewer.yml` | New | Static security review and sensitive-path lane | `ubuntu-latest` |
| `agent-database-steward.yml` | New | Migration/RLS/schema review and local validation | `ubuntu-latest` |
| `agent-platform-engineer.yml` | New | Static CI/chart/runner config review | `ubuntu-latest` by default |
| `agent-docs-improver.yml` | Hourly | Same, but no direct edits by default | `ubuntu-latest` |
| `monitor-actions.yml` | Every 15 min, GitHub-hosted | Same | `ubuntu-latest` |
| `monitor-health.yml` | Every 5 min, self-hosted | Split public endpoint checks from private checks | `ubuntu-latest` for public, self-hosted for private |
| `pr-validation.yml` | PR and push | Replace AKS/Helm/Terraform specifics with template checks | `ubuntu-latest` |
| `pr-enrichment.yml` | PR | Keep deterministic metadata/risk labeling | `ubuntu-latest` |
| `doc-drift-detector.yml` | merged PR | Keep | `ubuntu-latest` |
| `build-images.yml` | New | Build immutable images | `ubuntu-latest` unless private registry/network requires self-hosted |
| `deploy-dev.yml` / `deploy-test.yml` / `deploy-prod.yml` | Existing in baseline | Adapt to Kubernetes app profile | self-hosted deploy runner |
| `agent-cluster-guardian.yml` | Hourly, self-hosted | Kubernetes profile only | self-hosted cluster runner |
| `agent-operations-manager.yml` | Every 6h, self-hosted | Split GitHub/cloud API checks from private env checks | mixed |
| `runner-*` | scheduled/manual | Keep only generic cleanup/health first | self-hosted |

Do not create AKS-specific workflows in the first implementation unless `.github/factory.yml` declares an AKS profile.

### 6. Copilot Instructions
Create `.github/copilot-instructions.md` adapted to this template:

- Read README and relevant docs first.
- Tests required with code changes.
- Supabase migrations must be additive and verified with reset/validation commands when available.
- Temporal changes require worker tests.
- Frontend changes require Vitest/RTL or equivalent.
- Logs must be single-line unless `docs/Logging.md` overrides.
- Protected paths require human review.
- No secrets in code or migrations.
- PRs must include what changed, why, tests, risks, and docs updated.

### 7. Labels And Issue Taxonomy
Create a bootstrap label taxonomy used by agents:

- Type: `bug`, `enhancement`, `documentation`, `security`, `performance`, `refactor`, `infrastructure`
- Queue: `queue:product`, `queue:architecture`, `queue:development`, `queue:review`, `queue:qa`, `queue:security`, `queue:database`, `queue:platform`, `queue:release`, `queue:ops`, `queue:docs`
- State: `needs-triage`, `needs-info`, `needs-design`, `design-in-progress`, `design-approved`, `ready-for-dev`, `assigned-to-copilot`, `in-progress`, `ready-for-review`, `changes-requested`, `ready-for-release`, `released`, `blocked`
- Priority: `priority:critical`, `priority:high`, `priority:medium`, `priority:low`
- Agent: `agent:run`, `ai-fix-requested`, `ai-fix-approved`, `auto:alert`
- Review: `needs-security-review`, `security-reviewed`, `needs-database-review`, `database-reviewed`, `needs-platform-review`, `platform-reviewed`
- Quality: `testing`, `test-gap`, `test-quality`, `needs-tests`, `qa-reviewed`
- Risk: `risk:low`, `risk:medium`, `risk:high`, `requires-maintainer-review`
- Fingerprints: `fingerprint:<stable-id>` or comment body markers for dedupe

### 8. Secrets And Variables
Minimum secrets:

- `COPILOT_TOKEN`: Copilot SDK authentication token.
- `PROJECT_MANAGER_PAT`: user token for `gh` commands that assign Copilot, manage PRs, projects, and workflows.

Optional based on enabled profiles:

- `AUDIT_PAT`: audit-specific GitHub operations.
- Deployment secrets such as app JWTs.
- Cloud credentials only if the runner is not already authenticated and the profile permits them.

Baseline note: the upstream baseline assumes self-hosted runners are already authenticated for Azure and explicitly avoids Entra/OIDC. For this template, environment authentication must be profile-specific and documented rather than assumed globally.

## Guardrails

### Work Assignment
- Agents must search for existing issues and PRs before creating new work.
- Project Coordinator must enforce the baseline hard limit of 3 open Copilot PRs.
- Product Owner and Docs Improver should create issues, not code changes.
- Copilot implementation should happen through issue assignment or `@copilot` comments on active PRs.

### PR Review And Merge
- Tech Reviewer and Project Coordinator may approve low-risk PRs only after validation passes.
- Auto-merge should be disabled initially in this template until branch protection and required checks are configured.
- Protected paths require human review:
  - `.github/workflows/`
  - `supabase/migrations/`
  - `temporal/`
  - deployment and secrets-related files
  - security docs and policies

### Runner Boundaries
- GitHub-hosted runners are the default for checks, Copilot SDK control agents, project/issue/PR automation, static review, package tests, local service-container validation, and public-network CI.
- Self-hosted runners handle private-network checks, live Kubernetes operations, deployment/rollback, host-level runner maintenance, and workflows requiring organization-managed tooling or credentials.
- Privileged workflows should use explicit labels or groups, not plain `self-hosted`, once runner labels exist.
- Environment mutation workflows require concurrency groups and manual `workflow_dispatch` unless the action is proven safe.
- A workflow should not run on self-hosted merely because it uses `gh`, Node, Python, Docker, or the Copilot SDK.

### SDK Tool Policy
- Phase 1 can use the baseline `autoApprove` behavior.
- The shared runtime must include hooks so Phase 2 can deny dangerous shell commands or writes outside the repository.
- Environment-mutating agents need narrower command allowlists than review/triage agents.

### Noise Control
- Every issue/comment created by an agent needs a stable fingerprint.
- Agents must update matching open issues before creating new ones.
- Agents must avoid repeated comments when no new evidence exists.
- Scheduled agents must always write a concise run summary.

## Implementation Plan

### Phase 1: Baseline Factory Scaffold
- [ ] Create `.github/factory.yml`.
- [ ] Create generalized `.github/copilot-instructions.md`.
- [ ] Add initial agents adapted from the upstream baseline.
- [ ] Add shared TypeScript runtime and tests.
- [ ] Add core workflows: Product Owner, Project Coordinator, Tech Reviewer, QA Manager, Docs Improver, Actions Monitor.
- [ ] Add PR validation and enrichment for this repo's current stack.
- [ ] Add setup documentation for secrets, labels, branch protection, and runners.

### Phase 2: Copilot Worker Integration
- [ ] Add reliable Copilot assignment helper via `gh api`.
- [ ] Support custom agent selection when assigning implementation tasks.
- [ ] Add first-run Actions approval/rerun handling for Copilot PRs.
- [ ] Add max-open-PR enforcement and stale assignment cleanup.
- [ ] Add issue/PR dedupe fingerprints.

### Phase 3: Quality And Observability
- [ ] Publish workflow summaries consistently.
- [ ] Add tests for shared runtime, prompt rendering, dedupe, and assignment commands.
- [ ] Add artifact handling for coverage and validation results.
- [ ] Add monitor workflows for failed/stuck Actions runs.
- [ ] Add local runner health and cleanup workflows.

### Phase 4: Environment Profiles
- [ ] Add a `local-compose` profile for this template.
- [ ] Add optional `supabase-local` validation profile.
- [ ] Add optional cloud profiles later, such as AKS/Azure or AWS, only when configured.
- [ ] Add human approval gates for production deploys and high-risk environment changes.

## Acceptance Criteria
- A new repo created from this template can enable the factory by setting the required secrets and labels.
- Scheduled agents run without failing when optional services are absent; they report skipped checks clearly.
- Product Owner and Project Coordinator can create/prioritize issues and assign Copilot without exceeding the open PR limit.
- Copilot-created PRs receive validation, enrichment, review, and follow-up comments.
- No workflow assumes AKS, Azure, Helm, or Terraform unless the matching profile is enabled.
- Agents do not create duplicate issues for the same failure.
- All TypeScript shared runtime files have tests.
- Workflow permissions are explicit and minimal for each job.
- Self-hosted runner use is documented and label-routable.

## Risks And Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Agents create too much issue/PR noise | High | Fingerprints, existing issue search, max Copilot PRs, no-repeat comments |
| Auto-approval lets SDK agents run unsafe commands | High | Start with limited workflow permissions, then enforce SDK hook allowlists |
| Self-hosted runner credentials are too broad | High | Runner profiles, labels/groups, manual gates for mutation workflows |
| Template copies AKS-specific behavior into non-AKS repos | Medium | Profile-gate all cloud/Kubernetes workflows |
| Copilot API behavior changes | Medium | Centralize assignment helper and keep docs links in setup guide |
| Product Owner every 5 minutes is too aggressive | Medium | Baseline uses workflow cadence; expose cadence as config before broad rollout |
| Missing test infrastructure causes false failures | Medium | Skip optional checks with explicit summaries until commands exist |

## Open Review Questions
- Should the initial factory preserve the baseline Product Owner cadence of every 5 minutes, or should we keep the workflow baseline but set this repo's config to a lower cadence?
- Should Project Coordinator and Tech Reviewer be allowed to auto-merge low-risk PRs in this template, or only approve/comment until branch protection is proven?
- Which self-hosted runner labels should be standardized for this factory: `factory-build`, `factory-deploy-nonprod`, `factory-prod-ops`, or another taxonomy?
- Should Copilot implementation assignments use the default Copilot cloud agent first, or should this template immediately define specialized implementation agents?
- Which validation commands should be mandatory on day one for this repo: Docker Compose health, Supabase migration reset, frontend tests, Temporal tests, or all available checks?
