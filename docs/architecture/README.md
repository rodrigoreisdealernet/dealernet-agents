# Architecture Overview

This directory holds the **cross-cutting architecture documentation** for the Wynne
Systems equipment-rental platform — the diagrams and narrative that tie the
subsystems together. It complements, and does not replace:

- [`docs/adrs/`](../adrs/) — **why** each decision was made (the binding record).
- [`docs/specs/`](../specs/) — the **detailed designs** for individual slices.

Read this when you want the *shape of the whole system*; drop into the ADRs and
specs when you need the depth on a particular decision.

> All diagrams below render natively on GitHub (Mermaid). Each subsystem page goes
> deeper with its own diagrams.

## What this system is

The repository is **two factories around one product**:

1. **The product** — a rental ERP web app (React) over a self-hosted Supabase data
   layer, with **Temporal** orchestrating rental operations.
2. **The Software Factory** — GitHub Actions + role-based AI agents that triage,
   design, build (via Copilot), review, and ship the product autonomously.
3. **The Operations Factory** — Temporal + Azure OpenAI agents that automate the
   rental back-office (revenue recognition, fleet audits, billing reconciliation)
   *for the people who use the product*.

```mermaid
flowchart TB
    subgraph Builds["🏭 Software Factory — builds the product"]
        direction LR
        GHA["GitHub Actions<br/>cadence pipelines"] --> Agents["Role-based agents<br/>(PM, reviewers, architect…)"]
        Agents --> Copilot["GitHub Copilot<br/>(implements)"]
    end

    subgraph Product["📦 The Product — rental ERP"]
        direction LR
        FE["React frontend<br/>(JSON-driven UI engine)"]
        DB[("Self-hosted Supabase<br/>Postgres + PostgREST + GoTrue")]
        TMP["Temporal worker<br/>(rental workflows)"]
        FE --> DB
        TMP --> DB
    end

    subgraph Ops["🤖 Operations Factory — serves rental users"]
        direction LR
        OWF["Temporal agentic<br/>workflows"] --> AOAI["Azure OpenAI<br/>chat_with_tools"]
        OWF --> DB
    end

    Builds -->|ships code & images| Product
    Product -.->|powers| Ops
    Users(["Rental staff<br/>admin · branch mgr · field op"]) --> FE
    Maintainers(["Maintainers"]) -.->|epics & guardrails| Builds
```

## C4 Level 1 — System context

```mermaid
flowchart TB
    user(["Rental staff<br/>(4 roles)"])
    maint(["Maintainers"])
    gh(["GitHub<br/>(issues · PRs · Actions)"])
    aoai(["Azure OpenAI"])
    azure(["Azure<br/>(AKS · ACR · Front Door)"])

    sys["<b>Wynne Rental Platform</b><br/>Rental ERP + two AI factories"]

    user -->|signs in, manages rentals| sys
    maint -->|files epics, sets guardrails| sys
    sys -->|orchestrates issues/PRs| gh
    gh -->|runs agents & CI| sys
    sys -->|agent reasoning + tools| aoai
    sys -->|deploys to| azure
```

## C4 Level 2 — Containers

```mermaid
flowchart TB
    subgraph edge["Azure Front Door (edge)"]
        fd["Stable hostnames + managed TLS"]
    end

    subgraph aks["AKS cluster (aks-selfheal-staging)"]
        subgraph nsapp["ns: wynne-dev / wynne-test"]
            fe["frontend<br/>(nginx + React bundle)"]
            worker["temporal-worker<br/>(Python)"]
        end
        subgraph nssb["ns: wynne-supabase"]
            kong["Kong (API gateway)"]
            rest["PostgREST"]
            auth["GoTrue (auth)"]
            studio["Studio (internal)"]
            pg[("Postgres<br/>generic entity model + SCD2")]
            kong --> rest --> pg
            kong --> auth --> pg
            studio --> pg
        end
        temporal["Temporal server"]
        worker --> temporal
    end

    fd --> fe
    fd --> kong
    fe -->|anon key, PostgREST| kong
    worker -->|service-role writes| kong
    worker -->|rental + agentic workflows| temporal

    classDef ns fill:#eef,stroke:#88a;
    class nsapp,nssb ns;
```

## The pages

| Page | What it covers |
|------|----------------|
| [Product architecture](./product-architecture.md) | Frontend JSON-driven UI engine, Supabase data layer, Temporal rental workflows, signal-driven human-in-the-loop |
| [Data model & security](./data-model.md) | Generic entity model with SCD2 history, the rental domain graph, analytics facts, RLS / role model, hardened write-RPCs |
| [Software Factory](./software-factory.md) | Role-based agents, cadence pipelines, the issue→PR→merge→deploy lifecycle, label-driven routing, agent runtime |
| [CI/CD & delivery pipeline](./ci-cd-pipelines.md) | Workflow catalogue & `workflow_run` chain, the PR test gate, test trend history, gated dev→test→prod promotion, agent cadence pipelines, issue→ship lifecycle |
| [Operations Factory](./operations-factory.md) | Agentic ops workflows (Rev-Rec), the `chat_with_tools` agent loop, findings & approval persistence |
| [Deployment & infrastructure](./deployment.md) | Local Compose stack, AKS/Helm multi-env, self-hosted Supabase topology, image promotion, edge |

## How the pieces relate

```mermaid
flowchart LR
    subgraph fe["Frontend"]
        engine["UI Engine<br/>(pages/*.json)"]
    end
    subgraph data["Data layer"]
        views["Read views<br/>(rental_current_*)"]
        rpc["Write RPCs<br/>(security definer)"]
        core[("entities / entity_versions<br/>/ relationships_v2")]
        views --> core
        rpc --> core
    end
    subgraph tmp["Temporal"]
        rwf["Rental workflows"]
        owf["Ops Factory workflows"]
    end

    engine -->|SELECT via PostgREST| views
    engine -->|RPC| rpc
    rwf -->|activities| rpc
    owf -->|findings/adjustments| core
    owf -->|reasoning| ext(["Azure OpenAI"])
```

See each page for the detailed, accurate diagrams and file references.
