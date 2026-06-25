# DIA Portal — Dealernet Automotive DMS

**DIA Portal** is the Dealernet (Volaris Group) **DMS for automotive dealerships** — vehicles (frota), service orders (ordem de serviço/oficina), parts and inventory (peças/almoxarifado), master data (dados mestres), and **agentic BI** over a self-hosted Supabase data layer. It is designed and operated by AI agents end to end.

This repository holds both the product and the autonomous system that designs, builds, runs, and plans it:

- **The product** — a DMS web app over a self-hosted Supabase data layer, with **Temporal**-orchestrated agentic operations for the automotive dealership domain (vehicles, service orders, parts/inventory, master data, and BI).
- **The factories that run it** — an autonomous **software factory** (GitHub Actions + role-based agents) that triages, designs, builds, reviews, and ships the product, and an emerging agentic **Operations Factory** (Temporal + Azure OpenAI) that automates tedious dealership back-office work — reporting, reconciliation, and operational audits — for the people who use the software.
- **How they decide what to build (and how to build it agentically)** — three layers that feed the factory:
  - an **operating model** ([`docs/discovery/domain/`](./docs/discovery/domain/README.md)) answering *"what does it take to run an X?"* — the target business mapped into roles → real, cited tasks, with a calibrated **coverage % and ROI** (Hubbard-style 90% CIs) and a bridge that turns the highest-value gaps into the backlog as **one epic per role**;
  - a nightly **discovery pipeline** ([`docs/discovery/`](./docs/discovery/README.md)) that researches the market and matures product ideas from raw signal to design-ready;
  - a living **agentic charter** ([`docs/agentic-charter.md`](./docs/agentic-charter.md)) — the evolving definition of a *great* agentic workflow, applied as a design lens and re-examined on a slow cadence.

> **Start here:** the [architecture overview](./docs/architecture/README.md) has diagrams of the whole system. Decisions are recorded in [`docs/adrs/`](./docs/adrs/) and detailed designs in [`docs/specs/`](./docs/specs/). Read those before making a change so you know which decisions you're working within.

**Jump to:** [Domain](#the-domain) · [Stack](#the-stack) · [Repository map](#repository-map) · [Live dev environment](#live-dev-environment) · [UAT environment](#uat-environment-dia-test) · [Local development](#local-development) · [Testing](#testing) · [Documentation](#documentation)

## The domain

Core entities (stored in a generic entity model with SCD2 history — see [ADR-0001](./docs/adrs/0001-generic-entity-model-scd2.md)):

- **Vehicles** (frota) and their master data, organized by **Company/Brand** (empresa/marca).
- **Service Orders** (ordem de serviço/oficina) running through the workshop lifecycle.
- **Parts & Inventory** (peças/almoxarifado), including parts sales.
- **Users & master data** (dados mestres) plus an **agentic BI** analytics layer over the operational data.

Full model: see the per-entity design specs under [`docs/specs/`](./docs/specs/) (e.g. [Vehicle](./docs/specs/4-vehicle-crud.md), [Service Order](./docs/specs/7-feat-ordem-de-servico-oficina.md), [Parts](./docs/specs/8-feat-pecas-entidade-crud.md)) and the [data model & security](./docs/architecture/data-model.md) architecture page.

## The stack

| Layer | Choice | Decision |
|------|--------|----------|
| Frontend | React 18 + Vite + TanStack Router/Query; **JSON-driven UI engine** (screens are declarative JSON over the entity model) | [ADR-0016](./docs/adrs/0016-json-driven-ui-engine.md), [ADR-0017](./docs/adrs/0017-frontend-data-layer-supabase-anon.md) |
| Data | **Self-hosted, open-source Supabase** (Postgres + PostgREST + GoTrue + Kong) in-cluster | [ADR-0013](./docs/adrs/0013-self-host-supabase-in-cluster.md) |
| Workflows | **Temporal** (Python) for dealership operations and agentic ops; human-in-the-loop via signals | [ADR-0003](./docs/adrs/0003-temporal-workflow-orchestration.md), [ADR-0004](./docs/adrs/0004-signal-driven-human-in-the-loop.md) |
| AI agents | **Azure OpenAI** `chat_with_tools` | [ADR-0005](./docs/adrs/0005-azure-openai-chat-with-tools-adapter.md) |
| Build & deploy | AKS + Helm (dev/test/prod), images in ACR, **Azure Front Door** edge | [ADR-0012](./docs/adrs/0012-aks-helm-multienv-gated-promotion.md), [ADR-0015](./docs/adrs/0015-azure-front-door-external-edge.md) |
| Factories | Software factory (builds the product) + Operations Factory (serves dealership users) | [ADR-0006](./docs/adrs/0006-autonomous-software-factory.md), [ADR-0020](./docs/adrs/0020-operations-factory-agentic-ops.md) |

## Repository map

Where things live, at a glance:

| Path | What's there |
|------|--------------|
| [`frontend-portal/`](./frontend-portal/) | DIA **Portal DMS** shell — React 18 + Vite + Tailwind, MDI window manager, native AI-Operations screens (`src/portal/renderers/screens/`) over the Supabase data layer |
| [`temporal/`](./temporal/) | Python Temporal workers — dealership + agentic-ops workflows, activities, and pytest suites |
| [`supabase/`](./supabase/) | Postgres migrations, seed, and RLS / access-control contract tests |
| [`charts/`](./charts/) | Helm charts — app, monitoring, observability |
| [`deploy/`](./deploy/) | Kubernetes + OpenBao deploy surface |
| [`scripts/`](./scripts/) | Bootstrap & ops scripts (labels, demo-user seeding, discovery/charter publish) |
| [`.github/`](./.github/) | **The software factory** — role-based agents (`agents/`), cadence pipelines (`workflows/`), shared agent runtime (`tools/shared/`) |
| [`docs/`](./docs/) | Architecture, ADRs, specs, discovery, runbooks, user guide, release notes (see [Documentation](#documentation)) |

## Live Dev Environment

The DIA Portal DMS MVP is deployed to Kubernetes (`aks-selfheal-staging`) with a fully
**self-hosted, open-source Supabase** stack in-cluster. Full deploy details:
[`PHASE2-DEPLOYMENT.md`](./PHASE2-DEPLOYMENT.md).

| What | URL |
|------|-----|
| **App (frontend)** | https://dia-app-a4bde4gwecdnfpfb.a02.azurefd.net |
| **Supabase API** | https://dia-api-fvd0fcfubfb2drcy.a02.azurefd.net |

Both are served through **Azure Front Door** (stable hostname + managed TLS; the
underlying cluster LoadBalancer IP can change without the URL changing). If a Front
Door URL 404s briefly after a change, it is still propagating to the edge.

### How to access / sign in

The app now has an in-app **Sign In** button in the header (login dialog). GoTrue
auto-confirms email sign-ups (no verification step needed).

#### Role model

Four roles control what each user can do — stored in `app_metadata.role` in the JWT
([ADR-0023](./docs/adrs/0023-user-role-model-profiles.md)):

| Role | Capabilities |
|------|-------------|
| `admin` | Full read/write on all tables; manage user profiles |
| `branch_manager` | Full read/write on operational + entity data |
| `field_operator` | Read + insert on inspections, contracts, check-ins |
| `read_only` | Read-only for authenticated sessions |

#### Demo accounts

A standard set of demo users is seeded via `scripts/seed-demo-users.sh`.
Passwords are **not committed** — they are stored as secrets (`DEMO_ADMIN_PASS`,
`DEMO_OPERATOR_PASS`) per the secrets workflow (#125). Rotate and invalidate
demo credentials using the [secret operations runbook](./docs/runbooks/secret-operations.md).
Contact a maintainer for current environment credentials, or run the seed script
yourself against a local Supabase instance with passwords of your choosing.

> **Note:** the `@dia-rental.dev` domain on the seeded demo accounts is a **legacy
> placeholder** carried over from the project's earlier name — it is just a throwaway
> dev-account label, not the product's business domain (the product is the DIA Portal
> automotive DMS). The underlying seeded accounts are unchanged; renaming them is
> follow-up infra work, out of scope for this doc.

| Email | Role |
|-------|------|
| `admin@dia-rental.dev` | `admin` |
| `manager@dia-rental.dev` | `branch_manager` |
| `operator@dia-rental.dev` | `field_operator` |
| `readonly@dia-rental.dev` | `read_only` |
| `demo@dia-rental.dev` | Legacy break-glass account (disabled unless explicitly re-enabled for incident recovery) |

To seed demo users against a local Supabase instance:
```bash
SUPABASE_DB_URL=******localhost:54322/postgres \
DEMO_ADMIN_PASS=<choose> \
DEMO_OPERATOR_PASS=<choose> \
bash scripts/seed-demo-users.sh
```

> ⚠️ Dev-only throwaway credentials in a dev environment with placeholder data.
> Never rely on long-lived defaults. Follow the credential rotation cadence and
> rollback/break-glass controls in the [secret operations runbook](./docs/runbooks/secret-operations.md).
> Do not put real/sensitive data in this environment.

### Admin (Supabase Studio)

Studio is **internal-only** (not public). Reach it via port-forward:
```bash
kubectl -n dia-supabase port-forward svc/supabase-supabase-studio 3001:3000
# then open http://localhost:3001  (dashboard creds: `kubectl get secret supabase-dashboard -n dia-supabase`)
```

Use temporary credentials only and rotate/rollback via the
[secret operations runbook](./docs/runbooks/secret-operations.md).

> Hardening of this environment (TLS everywhere, JWT rotation, real auth, secrets
> management, backups, network policy) is tracked under epic **#130**.

## UAT Environment (`dia-test`)

A human-gated **UAT** environment that mirrors dev but with a **fully isolated data plane** —
its own self-hosted Supabase + Postgres in the `dia-supabase-test` namespace, sharing **no
data** with dev ([ADR-0062](./docs/adrs/0062-gated-promotion-known-good-digest-per-env-data-isolation.md)).
App workloads run in the `dia-test` namespace on the same `aks-selfheal-staging` cluster
(namespace isolation, to control cost).

| What | URL |
|------|-----|
| **App (frontend)** | https://dia-app-test-gtehe0hddtcyf4gq.a02.azurefd.net |
| **Supabase API** | https://dia-api-test-h5hbdeb8b9fdhedu.a02.azurefd.net |

Served through **Azure Front Door** (managed TLS; a brief 404 right after a change just means
the edge is still propagating).

For UAT, the Supabase/Kong origin is hardened to allow only Azure Front Door backend source
ranges (`loadBalancerSourceRanges`), so direct-origin traffic is blocked.

**Promotion is human-gated** — nothing auto-deploys to UAT. A release manager promotes a
**known-good commit** by dispatching `deploy-test.yml` with a `sha` from the `releases-ledger`
branch; the immutable image digest is resolved from ACR. See the
[promotion runbook](./docs/runbooks/promotion.md). (A second-person reviewer-approval gate
would require GitHub Enterprise; on the current plan the gate is the manual dispatch, which
GitHub restricts to write-access users.)

**Access / sign-in:** same role model + demo accounts as dev (above). UAT has its **own
isolated auth**, so demo users must be seeded against the UAT Supabase before sign-in works
(`scripts/seed-demo-users.sh` pointed at the `dia-supabase-test` database). The schema is
migrated and the demo **baseline** data is seeded.

**In-cluster fallback** (if Front Door is mid-propagation):
```bash
# the in-cluster Service is named "<helm-release>-frontend" (legacy release name "rental-app"
# yields "rental-app-frontend"); the app it serves is the DIA Portal frontend (frontend-portal/).
kubectl -n dia-test port-forward svc/rental-app-frontend 8080:80   # → http://localhost:8080
```

> **Status (2026-06-14):** frontend + ops-api live and public; data plane isolated, schema
> migrated + demo-baseline seeded. The Temporal **worker is scaled to 0** (no in-cluster
> Temporal server yet — same as dev). Bring-up / public-exposure tooling:
> [`scripts/uat-finish-public.sh`](./scripts/uat-finish-public.sh). Same hardening caveat as
> dev applies — **do not put real/sensitive data here.**

Quick hardening verification:
```bash
# discover the Kong origin IP
kubectl -n dia-supabase-test get svc supabase-supabase-kong -o jsonpath='{.status.loadBalancer.ingress[0].ip}'

# direct origin should fail (expected: curl exits non-zero). If this prints, hardening failed:
curl --max-time 8 -sS -o /dev/null http://<kong-loadbalancer-ip>/auth/v1/health && echo "unexpected reachable (security issue)"

# Front Door API path must still work
curl --max-time 20 -sS -o /dev/null -w '%{http_code}\n' https://dia-api-test-h5hbdeb8b9fdhedu.a02.azurefd.net/auth/v1/health
```

## Local development

> **Docker Compose is a local development convenience only — it is not the production runtime.**
> The deployed cluster runs on AKS + Helm with a fully self-hosted Supabase stack in-cluster
> ([ADR-0013](./docs/adrs/0013-self-host-supabase-in-cluster.md)). Compose is purely for local
> iteration; never use it to reason about production behaviour.

### Prerequisites
- Docker Desktop with Compose v2
- `make` (comes with macOS/Linux; install via Xcode CLT on macOS)
- Node 18+ (for running the frontend on the host)
- Python 3.11+ with pip (for running the Temporal worker on the host)
- Supabase CLI (optional) if you want the full Supabase stack locally

### Quick start (all-in-one Compose)
1) Copy environment defaults  
   `cp .env.example .env`
2) Start everything  
   `make up`  
   (add `USE_DEV=1` for live-reload mounts)
3) Open services  
   - Frontend placeholder: http://localhost:3000  
   - Temporal UI: http://localhost:8080  
   - Temporal gRPC: localhost:7234  
   - Supabase Postgres stub: localhost:55432

Common commands:
- `make down` — stop containers
- `make reset` — tear down volumes and recreate containers
- `make logs` — stream all service logs
- `make logs-temporal` / `make logs-frontend` — targeted logs

### What the local stack runs
- Docker Compose stack: Temporal server, Temporal UI, the Python worker, the frontend dev server, and a stub Supabase Postgres
- Development overrides in `docker-compose.dev.yml` for live-reloading frontend and worker code
- Makefile wrappers for the usual lifecycle commands
- `.env.example` capturing required variables for frontend, Temporal, and Supabase

### Running services individually (without Compose)

If you prefer to run the frontend or Temporal worker directly on your host (faster iteration,
native debugger, no Docker overhead), start only the infrastructure with Compose and run each
service yourself.

**Step 1 — start infrastructure only (Temporal + Supabase stub)**
```bash
cp .env.example .env
docker compose up supabase-db temporal temporal-ui
```
Temporal gRPC is now available on `localhost:7234`; Supabase Postgres stub on `localhost:55432`.

**Step 2 — run the frontend on the host**
```bash
cd frontend-portal
npm install
npm run dev          # Vite dev server → http://localhost:5174
```

**Step 3 — run the Temporal worker on the host**
```bash
cd temporal
pip install -e ".[dev]"
# Set TEMPORAL_ADDRESS to the host-accessible port (not the Docker-internal service name)
TEMPORAL_ADDRESS=localhost:7234 python -m src.worker
```

> **Note on `TEMPORAL_ADDRESS`:** when the worker runs inside Docker Compose it resolves the
> service name `temporal:7233`. When running on the host, use `localhost:7234` (the port Docker
> publishes). The `.env.example` file documents both values with inline comments.

## Testing

| Suite | What it covers | Where | Run |
|------|----------------|-------|-----|
| **Frontend Portal (lint, build, test)** | DIA Portal shell — ESLint, type-checked build (`tsc -b && vite build`), and the DIA-branding verification test | [`frontend-portal/`](./frontend-portal/) | `cd frontend-portal && npm run lint && npm run build && npm test` |
| **Temporal worker** | Dealership-operations workflows & activities (pytest) | [`temporal/tests/`](./temporal/tests/) | `python -m pytest temporal/tests/ -v` |
| **Supabase access-control contract** | RLS / role boundaries on the data layer (details [below](#supabase-api-access-control-contract-tests)) | [`test_supabase_api_access_contract.py`](./temporal/tests/test_supabase_api_access_contract.py) | `python -m pytest temporal/tests/test_supabase_api_access_contract.py -v` |

> **Note (2026-06-25):** the inherited Playwright E2E / Visual-UX suites and the heavy CI factory belonged to the removed `frontend/` (dia-frontend) and live under `.github/workflows.disabled/`. The active gate is the slim [`ci.yml`](./.github/workflows/ci.yml) (guard-rails + the `frontend-portal` lint/build/test job). Re-establishing E2E for the Portal is follow-up work.

### Test trends, coverage & quality (build over build)

Where each suite stands across builds — plus **coverage**, **code quality**, and how we're tracking against explicit **SLO targets** ([`.github/qa-targets.json`](./.github/qa-targets.json)) — is recorded on two durable, append-only **orphan branches**. Each has an auto-regenerated dashboard (pass-rate + coverage trend charts, an SLO **Targets** table with ✅/⚠️ breach flags, a **Code quality** section, and recent-runs + flakiness/skip-rate tables) over a machine-readable [`runs.jsonl`](https://github.com/Volaris-AI/dia/blob/e2e-history/runs.jsonl) feed (one record per suite-run, shared schema; `kind:"coverage"`/`"quality"` records carry the metric axes):

| Dashboard | Covers | Cadence | Branch |
|---|---|---|---|
| 📊 **[E2E trends →](https://github.com/Volaris-AI/dia/blob/e2e-history/README.md)** | Deployed-env Playwright: smoke + experience; **daily Visual UX** review (vision critique → `ux` tickets) | Hourly + post-deploy; visual daily | [`e2e-history`](https://github.com/Volaris-AI/dia/tree/e2e-history) ([`trend.svg`](https://github.com/Volaris-AI/dia/blob/e2e-history/trend.svg)) |
| 📊 **[CI test trends →](https://github.com/Volaris-AI/dia/blob/ci-history/README.md)** | Unit · Temporal/contract · Helm · Seed · **Coverage** (e2e screens/journeys + unit) · **Code quality** (tsc/ruff/shellcheck/SAST/deps/secrets) | Per merge to `main`; quality nightly | [`ci-history`](https://github.com/Volaris-AI/dia/tree/ci-history) ([`trend.svg`](https://github.com/Volaris-AI/dia/blob/ci-history/trend.svg)) |

Producers: [`e2e-dev.yml`](./.github/workflows/e2e-dev.yml) + [`visual-ux.yml`](./.github/workflows/visual-ux.yml) (E2E/UX); the `publish-test-history` job in [`pr-validation.yml`](./.github/workflows/pr-validation.yml) + the nightly [`code-quality.yml`](./.github/workflows/code-quality.yml) (CI suites, coverage, quality). The **QA Manager** agent reads both feeds against the SLO targets, publishes a **scorecard**, and drives a deduped ticket for every breached target — covering not just red suites but **coverage growth** (uncovered screens/journeys) and **stability** (flip-flop flakiness, skip-rate). Two specialist reviewers own their lanes: the **code-quality-reviewer** files static-analysis tickets and the **ux-vision-reviewer** files visual tickets. New checks land **report-only and ratchet to gating** once their target holds.

### Supabase API access-control contract tests

The RLS / role-boundary contract suite referenced in the table above:

- Run locally (auto-manages a local Supabase stack):  
  `python -m pytest temporal/tests/test_supabase_api_access_contract.py -v`
- Run against a deployed environment (read-only-safe by default): set
  `SUPABASE_TEST_BASE_URL` and `SUPABASE_TEST_ANON_KEY`, then run the same pytest command.
- Optional vars:
  - `SUPABASE_TEST_AUTH_JWT` (or `SUPABASE_TEST_JWT_SECRET`) to validate authenticated JWT behavior.
  - `SUPABASE_TEST_SERVICE_ROLE_KEY` + `SUPABASE_TEST_ALLOW_SERVICE_ROLE_WRITE=1` to validate service-role writes on non-local environments.

## Documentation

### Architecture (start here)
[`docs/architecture/`](./docs/architecture/README.md) — cross-cutting **architecture
docs with diagrams** that tie the subsystems together (C4 context/container views,
data flow, lifecycles). Read these for the shape of the whole system; drop into the
ADRs/specs for the depth on any one decision.

| Page | Covers |
|------|--------|
| [Overview](./docs/architecture/README.md) | System context, container diagram, how the pieces relate |
| [Product architecture](./docs/architecture/product-architecture.md) | Portal DMS shell, Supabase data layer, Temporal dealership workflows |
| [Data model & security](./docs/architecture/data-model.md) | Generic entity model + SCD2, automotive domain graph, RLS / role model, write-RPC guards |
| [Software Factory](./docs/architecture/software-factory.md) | Role-based agents, cadence pipelines, the issue→PR→merge→deploy lifecycle |
| [Operations Factory](./docs/architecture/operations-factory.md) | Agentic ops (Rev-Rec), the `chat_with_tools` loop, findings & approvals |
| [CI/CD & GitHub Actions](./docs/architecture/ci-cd-pipelines.md) | **Catalogue of every workflow and why it exists**, the six bands (CI gate · Build · Deploy · Verify · Agents · Monitor), the `«Band» · «Name»` naming convention, and the placement rule for adding a new workflow |
| [Deployment & infrastructure](./docs/architecture/deployment.md) | Local Compose, AKS/Helm multi-env, self-hosted Supabase, image promotion |

### Product discovery & agentic practice
- [`docs/discovery/domain/`](./docs/discovery/domain/README.md) — the **operating model** (the north star): *"what does it take to run an X?"* mapped as roles → rich personas → real, cited tasks, with **roadmap coverage % + ROI** (calibrated 90% CIs; addressable / capturable / captured). The `domain-cartographer` builds it (breadth-first, then no-churn refinement + continuous discovery); a **ticket bridge** files one epic per role into `queue:product`, and a feedback loop advances task status as work ships so coverage is a live burn-up.
- [`docs/discovery/`](./docs/discovery/README.md) — the **discovery pipeline**: the idea-maturity ladder (signal → opportunity → idea → validated → ready), the git-tracked dossier/evidence store, the nightly market-scout → product-strategist → discovery-critic crew, and the human build-gate.
- [`docs/agentic-charter.md`](./docs/agentic-charter.md) — the **living definition of a great agentic workflow** (floor: *agents propose; humans dispose*), the agentic-angle design lens, and how the weekly `agentic-reflector` evolves it on evidence.

### Decisions & designs
- [`docs/adrs/`](./docs/adrs/) — **Architecture Decision Records.** The reference point for reviews; start at the [index](./docs/adrs/README.md).
- [`docs/specs/`](./docs/specs/) — design specs: the automotive domain entities ([Vehicle](./docs/specs/4-vehicle-crud.md), [Service Order](./docs/specs/7-feat-ordem-de-servico-oficina.md), [Parts](./docs/specs/8-feat-pecas-entidade-crud.md)), the [software factory](./docs/specs/software-creation-factory.md), [live-cluster deployment](./docs/specs/live-cluster-deploy-smoke-rollback.md), and the [Operations Factory](./docs/specs/operations-factory-agentic-workflows.md).
- [`DATABASE.md`](./DATABASE.md) — the generic entity-model + SCD2 schema template the data layer is built on.

### Operational runbooks
- [`MONITORING.md`](./MONITORING.md) — **software-factory** health runbook (read the pipeline's health in 60 seconds; recurring failure patterns and how to unblock them).
- [`OPERATIONS.md`](./OPERATIONS.md) — **Operations Factory** runbook (the `MONITORING.md` analogue: where to run/approve/audit ops workflows, the approval SLA, failure recovery).
- [`docs/runbooks/secret-operations.md`](./docs/runbooks/secret-operations.md) — credential custody, rotation cadence, rollback, and break-glass handling.
- [`PHASE2-DEPLOYMENT.md`](./PHASE2-DEPLOYMENT.md) — live deployment details (AKS, Supabase, Front Door).

### Product & end-user docs
- [`docs/user-guide/`](./docs/user-guide/README.md) — end-user how-to guides for the DIA Portal DMS.
- [`docs/release-notes/`](./docs/release-notes/README.md) — plain-language record of what shipped, build over build.

### Contributing / conventions
- [`AGENTS.md`](./AGENTS.md) — repository guidelines: project structure, coding conventions, commit/PR norms, and the canonical commands. Read this before contributing (human or agent).

## Notes
- CI image publishing (`.github/workflows/build-images.yml`) uses repository configuration only: set `vars.ACR_LOGIN_SERVER` and `secrets.ACR_USERNAME`/`secrets.ACR_PASSWORD` to enable push on `main`; otherwise it performs build-only ([ADR-0010](./docs/adrs/0010-immutable-images-push-gating-digest-promotion.md)).
