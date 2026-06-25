# Briefing de handoff — planejar/implementar um produto similar ao Dealernet

> Documento para ser **entregue à sessão oficial do produto** (a sessão/repo onde o produto real será
> desenhado e implementado). Resume o que aprendi levantando, executando e dissecando o sistema de
> referência Dealernet. **Não confie na documentação oficial dele** — o que segue foi validado na prática.
> Leia junto: [operations-factory-flow.md](./operations-factory-flow.md),
> [factory-workflows.md](./factory-workflows.md), [factory-agents.md](./factory-agents.md).

## 1. O que é o sistema de referência
ERP de **locação de equipamentos** com duas "fábricas" agentic em volta:
- **Operations Factory** (produto): agentes LLM em workflows Temporal analisam dados e produzem
  **findings**; humano aprova/rejeita (human-in-the-loop). Ver `operations-factory-flow.md`.
- **Software Factory** (constrói o produto): GitHub Actions + 27 agentes por papel que triam,
  desenham, constroem, revisam, fazem deploy e monitoram. Ver `factory-workflows.md` + `factory-agents.md`.

## 2. Stack validada
React+Vite (engine de UI dirigida por JSON) · **Supabase self-hosted** (Postgres+PostgREST+GoTrue+Kong;
local via Supabase CLI) · RBAC por `app_metadata.role` (admin/branch_manager/field_operator/read_only) +
multi-tenant via claim `tenant` + RLS · **Temporal** (worker Python) · **Azure OpenAI**
`chat/completions` (tools + `response_format json_schema`) · **ops-api** FastAPI · AKS+Helm+ACR+Front Door
(deploy real) / Docker Compose (local).

## 3. Modelo de dados central (copie a ideia)
- **Modelo genérico de entidades + SCD2** (`entities`+`entity_versions`, `is_current`/`valid_from/to`);
  até a **config dos agentes** é entidade versionada → views "current".
- **Multi-tenant** por `tenant_id`/`tenant_key`; RLS por tenant+role.
- **findings** (`status` pending_approval/approved/rejected/informational, `severity`, `delta`,
  `confidence`, `rationale`, `evidence`, `fingerprint`, ligações a run/workflow/contract/line_item).
- Telemetria: `ops_workflow_run`, `ops_finding_kpis`, `ops_agent_status_view`.

## 4. Padrão agentic a replicar
`Schedule(cron) → Workflow → scope → assess(LLM chat_with_tools + evidência) → record_finding(dedupe
por fingerprint) → finalize`. Human-in-the-loop: app lê via PostgREST (RLS) → ops-api approve/reject →
grava no banco + signal Temporal (best-effort). LLM **agnóstico de provedor**, validação client-side.

## 5. ARMADILHAS reais (projete o produto para evitá-las — o mais valioso)
1. **Migrations com timestamp duplicado quebram `supabase db`** (a versão é PK). → CI que rejeita versões duplicadas.
2. **Compose "oficial" enganoso** (só um stub de Postgres; login não funcionava). → tenha **um** caminho de bring-up local de verdade (foi o Supabase CLI).
3. **Seed de auth do GoTrue é cheio de detalhes:** `auth.users` (bcrypt) **+** `auth.identities` (senão "Invalid login credentials") + normalizar tokens NULL→'' + índice único parcial (`ON CONFLICT (email) WHERE is_sso_user=false`). → script de seed idempotente e testado.
4. **Structured output `strict:true` + modelos novos = HTTP 400** (Azure exige todos os campos em `required`; opcionais quebram). → `strict:false` + validação client-side; só enviar `tool_choice` com `tools`.
5. **`model` por agente era ignorado** (usa o deployment do env). → decida modelo por env vs por agente, explicitamente.
6. **Schedules cron = custo de LLM silencioso.** → agendados **off-by-default** em dev + kill-switch + `bounds` por agente.
7. **Aprovação best-effort no signal:** decisão = estado no banco, não no workflow.
8. **Completude de seed por agente:** uma fonte de config canônica por agente (evite "tabela base" + "view entity-backed" divergentes — só RevRec vinha semeado).
9. **Interceptação TLS corporativa** quebra pip/HTTPS no container. → injete a CA corporativa ou hosts confiáveis.
10. **Frontend chamava ops-api por caminho relativo** → padronize base via env + proxy em dev.

## 6. Padrão "harness determinístico envolvendo LLM" (a tese arquitetural)
O LLM decide só o julgamento; **ordem, dedupe, idempotência, timeouts, ledger de progresso, roteamento
de incidentes, métricas, gating de promoção e auditorias são determinísticos**. Agentes têm cap de
ações/run, dedupe por fingerprint SHA-256, e a decisão sempre vira estado persistido por código.
Promoção por **digest imutável**; ledgers append-only (`ci-history`/`e2e-history`/`releases-ledger`);
human-gate só onde há risco real (deploy test/prod, remediação de cluster).

## 7. O que a sessão oficial deve produzir
Um **plano de produto + arquitetura** contemplando: modelo de domínio + entidades genéricas/SCD2 +
multi-tenant + RLS; o padrão **Operations Factory** (catálogo de agentes, schema de findings,
telemetria, config versionada); estratégia de LLM agnóstica (structured output tolerante, tool-belt,
validação client-side, kill-switch de custo, agendados-off-by-default); bring-up local **único** + seed
idempotente + CI que barra migrations duplicadas; human-in-the-loop com decisão no banco; orquestração
durável (Temporal ou equivalente).

Comece pelas **ADRs** e um **roadmap por fases** (MVP do ERP → 1 agente de ops end-to-end → painel de
aprovação → demais agentes). Para cada armadilha da §5, declare explicitamente como seu design a evita.
