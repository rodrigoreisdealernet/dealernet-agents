# Operations Factory — Fluxo do Produto (Temporal + LLM + human-in-the-loop)

> Diagramas e explicação do **ciclo agentic de operações do produto** (não confundir com a *software
> factory* que constrói o produto — essa está em [factory-workflows.md](./factory-workflows.md) /
> [factory-agents.md](./factory-agents.md)). Baseado no código real validado nesta sessão:
> `temporal/src/worker.py`, `workflows/ops/*`, `activities/ops_*`, `agents/*`, `agents/openai_client.py`
> e `ops_api/app.py`.

## Princípio
**Agents propose; humans dispose.** Agentes LLM analisam dados de locação e produzem **findings**
(propostas de ação com evidência, delta em $, severidade, confiança). Nada é aplicado
automaticamente (v1, `auto_apply=false`): um humano **aprova/rejeita** cada finding, e a decisão é
**persistida no banco como fonte da verdade** (o signal ao Temporal é best-effort).

## Componentes
- **Temporal Schedules (cron)** — criadas pelo worker no startup a partir de `ops_agent_config_current`.
- **Workflows de ops** (1 por agente): RevRec, Fleet, Credit, Account-Health, Territory-Brief, etc.
- **Activities** padronizadas por agente: `ops_load_agent_config` → `ops_scope_*` → `ops_list_open_finding_fingerprints` (dedupe) → `ops_create_workflow_run` → `ops_*_assess` (**LLM**) → `ops_record_finding` → `ops_finalize_workflow_run`.
- **`chat_with_tools`** (`agents/openai_client.py`): loop tool-belt + `response_format: json_schema` validado por pydantic.
- **Dados:** `finding` (SCD2 de status), `ops_workflow_run` (counts), `ops_finding_kpis`, `ops_agent_status_view`; config entity-backed → `ops_agent_config_current`.
- **ops-api** (FastAPI): autentica JWT no GoTrue, grava a decisão, sinaliza o workflow.
- **Frontend**: lê findings/KPIs via PostgREST (RLS por role+tenant); approve/reject via `/api/ops/*`.

---

## Diagrama 1 — Ciclo completo (produção do finding → aprovação)

```mermaid
sequenceDiagram
    autonumber
    participant CFG as ops_agent_config_current (SCD2)
    participant WK as Temporal Worker
    participant SCH as Temporal Schedule (cron)
    participant WF as Workflow de ops (ex. RevRec)
    participant LLM as Azure OpenAI (chat_with_tools)
    participant DB as Supabase (finding / ops_workflow_run)
    participant UI as Frontend (admin)
    participant API as ops-api (FastAPI)

    WK->>CFG: lê config (enabled, cron, prompts, tools, schema)
    WK->>SCH: cria/atualiza Schedule por tenant+agente
    Note over SCH: dispara no cron (ex. revrec 02:00)
    SCH->>WF: start workflow (tenant_id)
    WF->>DB: ops_create_workflow_run (running)
    WF->>WF: ops_scope_* (seleciona contratos/ativos/contas)
    WF->>DB: ops_list_open_finding_fingerprints (dedupe)
    loop por item escopado
        WF->>LLM: ops_*_assess (system+user prompt, tools de evidência)
        LLM->>WF: tool_calls (pede dados) ...
        WF->>DB: executa tool (ex. rental_data) e devolve evidência
        LLM-->>WF: JSON estruturado (RevRecFindingV1) validado
        WF->>DB: ops_record_finding (status=pending_approval, fingerprint, delta, confidence)
    end
    WF->>DB: ops_finalize_workflow_run (counts: scoped/recorded/...)

    Note over UI,API: Human-in-the-loop (mais tarde)
    UI->>DB: lê finding + ops_finding_kpis (PostgREST, JWT, RLS)
    UI->>API: POST /api/ops/findings/decision (approve/reject + JWT)
    API->>DB: autentica JWT (GoTrue) e valida tenant/role
    API->>DB: persist_disposition (status=approved/rejected, approver, decided_at)
    API-->>WF: signal approve_finding/reject_finding (best-effort)
    API-->>UI: 202 accepted
```

## Diagrama 2 — Componentes e governança

```mermaid
flowchart TD
  subgraph Config[Governança de agente - SCD2]
    AC[entities/entity_versions\nagent_config] --> ACV[(ops_agent_config_current\nview entity-backed)]
  end
  ACV -->|reconcile no startup| SCH[Temporal Schedules cron]
  SCH --> WF[Workflows de ops\nRevRec/Fleet/Credit/...]
  WF -->|scope + assess| LLM[(Azure OpenAI\nchat_with_tools + json_schema)]
  LLM -->|tools de evidencia| TOOLS[rental_data, etc.\nleem o Postgres]
  WF -->|record| FND[(finding\npending_approval\nfingerprint dedupe)]
  WF -->|telemetria| RUN[(ops_workflow_run\ncounts)]
  FND --> KPI[(ops_finding_kpis\npendentes / $ recuperavel)]
  FND --> UI[Frontend\nFindings & Approvals]
  UI --> OPSAPI[ops-api\n/api/ops/findings/decision]
  OPSAPI -->|persist decisao| FND
  OPSAPI -.signal best-effort.-> WF
  RUN --> OM[ops-monitor\n15min: SLA / zero-finding]
  OM --> ISS[(GitHub Issues\nfingerprint ops-monitor:...)]
  PROM[Prometheus metrics\nworker 9000 / ops-api 8000] --> GRAF[Grafana / alertas]
```

---

## Pontos de design a replicar (e o que validamos aqui)

1. **Config de agente versionada (SCD2) + reconcile de schedule:** ligar/desligar um agente é mudar
   um registro; o worker reconcilia (cria/atualiza/deleta a Schedule). *(Foi o que usamos para o
   kill-switch de custo: `enabled=false` → schedule deletada e não recriada.)*
2. **Activities padronizadas por agente** (`scope → assess(LLM) → record → finalize`) com **dedupe por
   fingerprint** antes de gravar — evita findings repetidos a cada run.
3. **LLM tolerante a provedor/modelo:** `response_format json_schema` com `strict:false` + validação
   client-side (pydantic). *(Com `strict:true` o gpt-5.4 retorna HTTP 400 porque exige todos os
   campos em `required`; campos opcionais quebram. Só enviar `tool_choice` quando há `tools`.)*
4. **Tool-belt de evidência:** o modelo pede dados via tools que leem o Postgres; a evidência é
   marcada como "untrusted" no prompt (mitigação de prompt-injection).
5. **Decisão é estado no banco, não no workflow:** `ops-api` grava a disposição e **só então** tenta
   sinalizar o Temporal (falha de signal é logada, não quebra a aprovação) — robusto mesmo quando o
   workflow já terminou.
6. **Multi-tenant em tudo:** `tenant_id` no scope, no finding, no JWT claim e na RLS; o ops-api
   resolve `tenant_key`→`tenant_id` e valida acesso.
7. **Observabilidade de 1ª classe:** `ops_workflow_run` (counts), `ops_finding_kpis` (burn-down de
   aprovações + $ recuperável), `ops_agent_status_view`, métricas Prometheus, e o `ops-monitor`
   (SLA de aprovação 24h/4h, anomalia zero-finding).
8. **Custo controlado:** schedules **desligadas por padrão** em dev; execução sob demanda; cada agente
   tem `bounds` (`max_findings_per_run`, `max_tool_rounds`).

> **Estado validado nesta sessão:** RevRec rodou end-to-end contra gpt-5.4 e gerou um finding real
> (`unbilled_rental_extension`, $2.742,86, conf. 0,92); aprovação testada via app→proxy→ops-api→DB.
> Fleet/Credit exigem a *config entity-backed* (lacuna do seed do template — só RevRec vem semeado).
