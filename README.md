# DIA Portal — Dealernet Automotive DMS

**DIA Portal** is the Dealernet (Volaris Group) **DMS for automotive dealerships** — vehicles (frota), service orders (ordem de serviço/oficina), parts and inventory (peças/almoxarifado), master data (dados mestres), and **agentic BI** over a self-hosted Supabase data layer. It is designed and operated by AI agents end to end.

This repository holds both the product and the autonomous system that designs, builds, runs, and plans it:

- **The product** — a DMS web app over a self-hosted Supabase data layer, with **Temporal**-orchestrated agentic operations for the automotive dealership domain (vehicles, service orders, parts/inventory, master data, and BI).
- **The factories that run it** — an autonomous **software factory** (role-based agents under [`.github/agents/`](./.github/agents/), driven through the issue→spec→code→tests→review pipeline) that triages, designs, builds, reviews, and ships the product, and an emerging agentic **Operations Factory** (Temporal + Azure OpenAI) that automates tedious dealership back-office work — reporting, reconciliation, and operational audits — for the people who use the software.
- **How they decide what to build (and how to build it agentically)** — three layers that feed the factory:
  - an **operating model** ([`docs/discovery/domain/`](./docs/discovery/domain/README.md)) answering *"what does it take to run an X?"* — the target business mapped into roles → real, cited tasks, with a calibrated **coverage % and ROI** (Hubbard-style 90% CIs) and a bridge that turns the highest-value gaps into the backlog as **one epic per role**;
  - a nightly **discovery pipeline** ([`docs/discovery/`](./docs/discovery/README.md)) that researches the market and matures product ideas from raw signal to design-ready;
  - a living **agentic charter** ([`docs/agentic-charter.md`](./docs/agentic-charter.md)) — the evolving definition of a *great* agentic workflow, applied as a design lens and re-examined on a slow cadence.

> **Start here:** the [architecture overview](./docs/architecture/README.md) has diagrams of the whole system. Decisions are recorded in [`docs/adrs/`](./docs/adrs/) and detailed designs in [`docs/specs/`](./docs/specs/). Read those before making a change so you know which decisions you're working within.

**Jump to:** [Domain](#the-domain) · [Stack](#the-stack) · [Repository map](#repository-map) · [Local development](#local-development) · [Testing](#testing) · [Documentation](#documentation)

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
| Data | **Self-hosted, open-source Supabase** (Postgres + PostgREST + GoTrue + Kong) | [ADR-0013](./docs/adrs/0013-self-host-supabase-in-cluster.md) |
| Workflows | **Temporal** (Python) for dealership operations and agentic ops; human-in-the-loop via signals | [ADR-0003](./docs/adrs/0003-temporal-workflow-orchestration.md), [ADR-0004](./docs/adrs/0004-signal-driven-human-in-the-loop.md) |
| AI agents | **Azure OpenAI** `chat_with_tools` | [ADR-0005](./docs/adrs/0005-azure-openai-chat-with-tools-adapter.md) |
| Deploy (design) | AKS + Helm, images in ACR, Azure Front Door edge — **decision records only; no cluster is currently running** (see [Local development](#local-development) for how the project actually runs today) | [ADR-0012](./docs/adrs/0012-aks-helm-multienv-gated-promotion.md), [ADR-0015](./docs/adrs/0015-azure-front-door-external-edge.md) |
| Factories | Software factory (builds the product) + Operations Factory (serves dealership users) | [ADR-0006](./docs/adrs/0006-autonomous-software-factory.md), [ADR-0020](./docs/adrs/0020-operations-factory-agentic-ops.md) |

## Repository map

Where things live, at a glance:

| Path | What's there |
|------|--------------|
| [`frontend-portal/`](./frontend-portal/) | DIA **Portal DMS** shell — React 18 + Vite + Tailwind, MDI window manager, native AI-Operations screens (`src/portal/renderers/screens/`) over the Supabase data layer |
| [`temporal/`](./temporal/) | Python Temporal workers — dealership + agentic-ops workflows, activities, and pytest suites |
| [`supabase/`](./supabase/) | Postgres migrations, seed, and RLS / access-control contract tests |
| [`charts/`](./charts/) | Helm charts — app, monitoring, observability (infra code; no cluster currently running) |
| [`deploy/`](./deploy/) | Kubernetes + OpenBao deploy surface (infra code; not currently deployed) |
| [`scripts/`](./scripts/) | Bootstrap & ops scripts (labels, demo-user seeding, discovery/charter publish) |
| [`.github/`](./.github/) | **The software factory** — role-based agents (`agents/`) and shared agent runtime (`tools/shared/`). The only active GitHub Actions workflow is [`ci.yml`](./.github/workflows/ci.yml); the cadence/deploy pipelines are parked under [`workflows.disabled/`](./.github/workflows.disabled/) |
| [`docs/`](./docs/) | Architecture, ADRs, specs, discovery, runbooks, user guide, release notes (see [Documentation](#documentation)) |

## Local development

> **How the project runs today:** local development is via **Docker Compose**. The AKS/Helm
> cluster deployment is documented as a design decision ([ADR-0012](./docs/adrs/0012-aks-helm-multienv-gated-promotion.md),
> [ADR-0013](./docs/adrs/0013-self-host-supabase-in-cluster.md)) but **no environment is
> currently deployed** — the deploy workflows are parked under `.github/workflows.disabled/`.
> Use Compose for everything below.

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

### Demo users & roles (local)

Four roles control what each user can do — stored in `app_metadata.role` in the JWT and enforced
by RLS on the data layer ([ADR-0023](./docs/adrs/0023-user-role-model-profiles.md)):

| Role | Capabilities |
|------|-------------|
| `admin` | Full read/write on all tables; manage user profiles |
| `branch_manager` | Full read/write on operational + entity data |
| `field_operator` | Read + limited insert on operational records |
| `read_only` | Read-only for authenticated sessions |

Seed a standard set of demo users against a **local** Supabase instance with passwords of your
choosing (passwords are never committed):

```bash
SUPABASE_DB_URL=******localhost:54322/postgres \
DEMO_ADMIN_PASS=<choose> \
DEMO_OPERATOR_PASS=<choose> \
bash scripts/seed-demo-users.sh
```

> **Note:** the seeded demo emails use a `@dia-rental.dev` domain — a **legacy placeholder**
> carried over from the project's earlier name. It is just a throwaway dev-account label, not the
> product's business domain (the product is the DIA Portal automotive DMS). Renaming the seeded
> accounts is follow-up work.

> ⚠️ Dev-only throwaway credentials for local use. Never rely on long-lived defaults, and do not
> put real/sensitive data in a dev environment. Credential custody, rotation, and break-glass are
> covered in the [secret operations runbook](./docs/runbooks/secret-operations.md).

## Testing

| Suite | What it covers | Where | Run |
|------|----------------|-------|-----|
| **Frontend Portal (lint, build, test)** | DIA Portal shell — ESLint, type-checked build (`tsc -b && vite build`), and the DIA-branding verification test | [`frontend-portal/`](./frontend-portal/) | `cd frontend-portal && npm run lint && npm run build && npm test` |
| **Temporal worker** | Dealership-operations workflows & activities (pytest) | [`temporal/tests/`](./temporal/tests/) | `python -m pytest temporal/tests/ -v` |
| **Supabase access-control contract** | RLS / role boundaries on the data layer (details [below](#supabase-api-access-control-contract-tests)) | [`test_supabase_api_access_contract.py`](./temporal/tests/test_supabase_api_access_contract.py) | `python -m pytest temporal/tests/test_supabase_api_access_contract.py -v` |

> **Note:** the inherited Playwright E2E / Visual-UX suites and the heavy CI factory belonged to
> the removed `frontend/` (dia-frontend) and now live under [`.github/workflows.disabled/`](./.github/workflows.disabled/).
> The only active gate is the slim [`ci.yml`](./.github/workflows/ci.yml) (guard-rails + the
> `frontend-portal` lint/build/test job). Re-establishing E2E and the CI/CD factory for the Portal
> is follow-up work.

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
- [`PHASE2-DEPLOYMENT.md`](./PHASE2-DEPLOYMENT.md) — live deployment details (AKS, Supabase, Front Door) for when a cluster is brought up.

### Product & end-user docs
- [`docs/user-guide/`](./docs/user-guide/README.md) — end-user how-to guides for the DIA Portal DMS.
- [`docs/release-notes/`](./docs/release-notes/README.md) — plain-language record of what shipped, build over build.

### Contributing / conventions
- [`AGENTS.md`](./AGENTS.md) — repository guidelines: project structure, coding conventions, commit/PR norms, and the canonical commands. Read this before contributing (human or agent).
- [`CLAUDE.md`](./CLAUDE.md) — Claude Code working agreement for this repo.
