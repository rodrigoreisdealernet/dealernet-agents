# PRD Executável por Agente: Controle de custo de tokens LLM por execução de agente (fundação + piloto credit) — Operations Factory

## 0. Cabeçalho de execução
- **Fonte de entrada:** `.deep-research/controle-custo-tokens-agentes-20260625-1935/REPORT.md` (pesquisa Claude×Codex, convergida em 2 rodadas).
- **Raiz do repo:** `/mnt/c/Dev/AIAccelerator/dealernet-agents`  ·  **Stack:** Python 3 (Temporal workers, Pydantic) + SQL (Supabase/Postgres + PostgREST); testes `pytest` (Python) e `node --test` (.mjs de contrato SQL).
- **Runtime alvo:** Claude Code / Codex.
- **Size tier:** large → **fatiado**: este PRD cobre a *fundação de medição + piloto no agente credit* (1 fatia vertical, independentemente entregável). Rollout aos demais agentes e reconciliação contra a fatura Azure ficam em PRDs de follow-up (ver §3 não-objetivos).  ·  **Data:** 2026-06-25  ·  **Status:** executable.

## 1. Ledger de extração da entrada
- **Objetivos/decisões extraídos do REPORT:** medir tokens por **chamada real** ao Azure OpenAI; atribuir a `tenant/run/agent/model`; precificar via **rate-card datado + markup % por cliente/plano**; expor rollups por cliente; **transporte puro + persistência crash-safe na activity**; **USD no evento, BRL no rollup**; modos **PAYG/PTU**; schema **agnóstico de provedor**.
- **Decisões do usuário (escopo):** (1) medição + atribuição (sem motor de faturas/portal); (2) só Operations Factory / Azure OpenAI; (3) precificação = custo Azure + markup % configurável por cliente/plano.
- **Usuários implícitos / nouns de domínio:** software house (operador financeiro), `tenant` (concessionária/cliente), `agent`, `run` (`ops_workflow_run`), `usage event`, `rate-card`, `markup`, `provider_cost`, `billable_cost`.
- **Riscos/perguntas carregadas:** inventário PAYG vs PTU; fonte de câmbio; política de chargeability de retries; tagging por tenant no Azure; Chat Completions vs Responses API. (Viram ASSUMPTIONS/NC em §4.)
- **Sementes de grounding (fontes do REPORT):** `openai_client.py`, `config.py`, `ops_credit.py`, `credit.py`, `ops_revrec.py`, `20260607170000_ops_factory_persistence.sql`, `20260609000000_ops_credit_proposal.sql`, `20260609110000_enterprise_multi_currency_support.sql`.

## 2. Ledger de grounding (verificado no código real)
**Arquivos lidos (com porquê):**
- `temporal/src/agents/openai_client.py:51-56,76-141,144-178,220-229,254-262` — `AgentRunResult{response, executed_tool_calls}` (extra="forbid"); `chat_with_tools` chama `completion = await llm_transport.complete(...)` (:171) e **descarta tudo menos a mensagem** (`_extract_assistant_message`, :254-262); falhas levantam **antes** de retornar (`MaxToolRoundsExceededError` :181-184; `StructuredOutputRetriesExceededError` :223-229).
- **DESCOBERTA-CHAVE:** `complete()` **já retorna o JSON completo da Azure** (`_post_json` :140-141 devolve `json.loads(...)`), que inclui `usage`, `model` e `id`. Logo, **capturar usage NÃO exige mudar a assinatura de `complete()` nem o protocolo `ChatCompletionTransport`** (:58-67) — basta ler `completion.get("usage")`/`("model")`/`("id")` dentro de `chat_with_tools`. Isso preserva todos os `_FakeTransport` existentes.
- `temporal/src/config.py:11-17,39-69` — `AzureOpenAIEndpointConfig{endpoint,api_key,deployment,api_version}`; `settings.supabase_url`/`supabase_service_role_key` (:26-27).
- `temporal/src/agents/credit_analyst.py:45-67` — `run_credit_analyst(...)` chama `chat_with_tools(response_format=CreditProposalV1, ...)` e retorna `result.response.model_dump()`; é o ponto onde um parâmetro `on_llm_call` deve ser repassado.
- `temporal/src/activities/ops_credit.py:381-425` — `ops_credit_assess(account_payload, config)` (só 2 args; **sem `run_id`**); `account_payload` tem `tenant_id` (:397) e `account_id` (:398); chama `run_credit_analyst(...)` (:417-424).
- `temporal/src/workflows/ops/credit.py:79-94,122-132,181` — `run_id` criado em :94 via `ops_create_workflow_run`; `ops_credit_assess` chamado com `args=[account_payload, config]` (:125, **sem run_id**); `workflow_id=f"ops-credit:{run_id}"` só anexado a finding após sucesso (:181).
- `temporal/src/activities/ops_revrec.py:184-301,622-636` — `PostgrestServiceRoleClient` (PostgREST sobre urllib; `apikey`+`Bearer`=service-role; `.insert/.upsert(on_conflict=...)/.select/.update`); `_get_ops_persistence_client()` singleton (:292-300); `ops_create_workflow_run` (:622-636) é o **insert canônico a espelhar**.
- `supabase/migrations/20260607170000_ops_factory_persistence.sql:3-79,153-298` — `tenants(id uuid, tenant_key, name)`; `ops_workflow_run(run_id text PK, tenant_id, workflow_key, status, counts jsonb)`; helpers RLS `ops_tenant_match()`/`ops_claim_app_role()`.
- `supabase/migrations/20260609000000_ops_credit_proposal.sql:6-69` — **template de tabela worker-write/UI-read**: FK a `tenants`/`finding`, `revoke ... from anon,authenticated` + `grant select to authenticated` + `grant all to service_role`, `enable row level security`, política `*_tenant_read` (`ops_claim_app_role()` + `ops_tenant_match()`) + `*_service_role_all using(true) with check(true)`.
- `supabase/migrations/20260609110000_enterprise_multi_currency_support.sql:5-16,40-59,95-160` — **`fx_rates` JÁ EXISTE** (`base_currency_code, quote_currency_code, rate numeric(18,8), effective_at`, unique por par+data, RLS authenticated-read/service_role-all) e `v_invoice_currency_rollups` é o **padrão a copiar** para FX datado + `round(...,2)` no rollup. **Reutilizar, não duplicar.**
- `temporal/tests/test_openai_client.py:24-54` — `_FakeTransport` + `_assistant_response()` (retorna `{"choices":[{"message":...}]}`; **sem `usage`** hoje — estender).
- `temporal/tests/test_ops_revrec_activity.py:91-164` — `_FakeOpsPersistenceClient` (dict-de-tabelas com `.insert/.upsert/.select/.update`); fixture `monkeypatch.setattr(ops_revrec,"_ops_client",client)`.

**Comandos (stack):** `cd temporal && python -m pytest tests/ -v`; lint `ruff` (repo usa ruff — `# noqa` em `ops_credit.py:446`); SQL: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1`; contrato `node --test --test-concurrency=1 supabase/tests/<file>.test.mjs`.

**Conflitos entrada × código:**
| Afirmação da entrada | Realidade no código (path:line) | Resolução |
|---|---|---|
| "mudar `complete()` p/ retornar metadata estruturada" (codex-v1/v2) | `complete()` já devolve o JSON completo c/ `usage`/`model`/`id` (`openai_client.py:140-141,171`) | **drift de implementação** — desnecessário; ler do completion em `chat_with_tools` (menor blast radius; preserva fakes) |
| "criar tabela `ops_fx_rate`" (claude-v1/v2) | `fx_rates` já existe (`20260609110000_…:5-16`) | **drift** — reutilizar `fx_rates` |
| "`run_id` chega à activity de IA" (implícito) | `ops_credit_assess(account_payload, config)` não recebe run_id (`ops_credit.py:381-384`; `credit.py:125`) | **intended change** — este PRD adiciona `run_id` aos args |

**Desconhecidos:** se os deployments de produção são PAYG ou PTU (→ NC-001); fonte de câmbio autoritativa (→ A-002).

## 3. Contrato de resultado
- **Objetivo (1 frase):** registrar, precificar (custo Azure + markup por cliente) e tornar consultável o custo de tokens de cada execução do agente **credit** da Operations Factory, sobre uma fundação de medição agnóstica de provedor reutilizável pelos demais agentes.
- **Não-objetivos (explícitos):**
  - **Sem** geração de fatura, cobrança, portal do cliente, créditos pré-pagos, pricing por outcome.
  - **Sem** rollout aos outros agentes ops (revrec, branch, technician, etc.) — **follow-up PRD "rollout metering"** (reaplica T-004/T-005 por agente).
  - **Sem** automação de reconciliação contra Azure Cost Management/FOCUS nem extrato BRL ao cliente — **follow-up PRD "reconciliação & extrato"** (depende de acesso aos exports Azure e da fonte de câmbio).
  - **Sem** alteração de comportamento de negócio dos agentes (mesmas decisões/findings).
  - **Sem** instrumentar a software factory (`.github/` agentes Claude).
- **Verdades observáveis (quando pronto):**
  1. Rodar o workflow credit grava **1 linha em `ops_llm_usage_event` por chamada real ao provedor** (até `max_tool_rounds`+`max_schema_attempts`), com `tenant_id`, `run_id`, `agent_key`, `prompt/completion/total_tokens`, `model`, `provider_cost_usd`, `billable_cost_usd`.
  2. `select * from ops_llm_cost_by_tenant_day` retorna custo por cliente/dia.
  3. Uma execução que falha após ≥1 chamada **ainda** deixou as linhas das chamadas já feitas.
  4. Um usuário `authenticated` **não** consegue inserir em `ops_llm_usage_event`; só lê linhas do próprio tenant.
- **Métricas de sucesso:** 100% das chamadas Azure do workflow credit geram evento (ou `metering_status='missing'`); custo calculado bate (±1 centavo) com a fórmula sobre o rate-card seedado, validado em teste.

## 4. Clarificações & Suposições
- **Perguntado & respondido (2026-06-25):** escopo=medição+atribuição; agentes=Operations Factory/Azure; precificação=custo+markup% por cliente/plano.
- **[ASSUMPTION A-001]** Default de chargeability: chamadas de **retry do Temporal / reparo de schema / failover** entram com `chargeable=false` + `chargeability_reason`, mas **contam** em `provider_cost_usd`; markup só sobre `chargeable=true`. — racional: não cobrar o cliente por falhas da nossa orquestração; margem permanece honesta. Sobreponível por plano.
- **[ASSUMPTION A-002]** Câmbio fica **fora desta fatia** (eventos em USD); a conversão BRL e a tabela/fonte de FX entram no follow-up "reconciliação & extrato", reutilizando `fx_rates`. — racional: não bloqueia a medição; evita decidir fonte de FX agora.
- **[ASSUMPTION A-003]** Os deployments de produção são tratados como **PAYG** nesta fatia: `billing_mode` é coluna do rate-card (default `'payg'`) e a fórmula tokens×preço aplica-se; a alocação **PTU** (`ops_llm_cost_allocation`) fica para o follow-up. — racional: PAYG é o caso de custo marginal por token; PTU precisa do inventário (NC-001).
- **[NEEDS CLARIFICATION NC-001]** Quais deployments Azure em produção são PAYG vs PTU/reservado? — impacto se errado: sob PTU, `tokens×preço` **superfatura**; mitigado por `billing_mode` já estar no schema (troca de dado, não de código) e pela reconciliação do follow-up.

## 5. Glossário
- **usage event:** uma linha de `ops_llm_usage_event` = exatamente uma chamada HTTP ao provedor (uma iteração de `complete()`).
- **execução de agente / run:** uma `ops_workflow_run` (PK `run_id` texto `workflow_key:uuid`).
- **provider_cost_usd:** custo bruto Azure em USD (tokens×rate). **billable_cost_usd:** `provider_cost_usd·(1+markup_pct)` para chamadas `chargeable`.
- **chargeable:** se a chamada compõe a base de cobrança do cliente (vide A-001).
- **rate-card:** preço por modelo/unidade datado por vigência (`ops_llm_rate_card`).

## 6. Requisitos
- **FR-001** — QUANDO um agente da Operations Factory completa uma chamada Azure OpenAI (cada tool round e cada tentativa de schema), o sistema SHALL registrar **um** usage event com `prompt_tokens`, `completion_tokens`, `total_tokens` (e `cached_input_tokens`/`reasoning_tokens` quando presentes), `model`, `response_id`, `round_index`, `schema_attempt` e `metering_status`. [Realizes: UJ-2]
- **FR-002** — O sistema SHALL atribuir cada usage event a `tenant_id`, `run_id` (FK `ops_workflow_run`), `agent_key`, `activity_attempt` e `item_key`. [UJ-1, UJ-2]
- **FR-003** — QUANDO `usage` está ausente em uma resposta 200, o sistema SHALL persistir o evento com `metering_status='missing'` e fatos de token/custo nulos, **sem inferir tokens**, e excluí-lo dos rollups cobráveis. [UJ-2]
- **FR-004** — QUANDO uma execução falha após ≥1 chamada (estouro de tool rounds ou de tentativas de schema), o sistema SHALL ter registrado o usage das chamadas já realizadas (via sink por chamada). [UJ-2]
- **FR-005** — O sistema SHALL computar `provider_cost_usd` a partir de um rate-card datado por `(provider, model, unit_of_measure, effective_at)` com `(prompt−cached)·in + cached·cached + completion·out`, e `billable_cost_usd = provider_cost_usd·(1+markup_pct)`. [UJ-3]
- **FR-006** — O sistema SHALL resolver `markup_pct` de `ops_tenant_llm_plan` (override por tenant → default do plano) vigente no momento do evento e **congelar** `provider_cost_usd`/`billable_cost_usd` no evento com `rate_card_id` + `markup_pct`. [UJ-3]
- **FR-007** — O sistema SHALL marcar chamadas de retry/reparo/failover como `chargeable=false` com `chargeability_reason`, contando-as em `provider_cost_usd` (A-001). [UJ-3]
- **FR-008** — O sistema SHALL deduplicar usage events por `idempotency_key` único = `{run_id}:{workflow_id}:{activity_id}:{activity_attempt}:{item_key}:{call_index}:{response_id?}`. [UJ-2]
- **FR-009** — O sistema SHALL expor views de rollup por cliente: `ops_llm_cost_by_run`, `ops_llm_cost_by_tenant_day`, `ops_llm_cost_by_agent_model`. [UJ-1]
- **NFR-001** — Persistir usage NÃO SHALL adicionar I/O de banco ao transporte LLM (`AzureOpenAIChatTransport`/`complete()` permanecem puros e unit-testáveis). Medido por: nenhum import de cliente de persistência em `openai_client.py`.
- **NFR-002** — A captura SHALL ser agnóstica de provedor (`provider`, `provider_model`, `deployment`, `api_version`, `meter_name`, `unit_of_measure`), permitindo Anthropic sem migração de schema.
- **SEC-001** — As tabelas `ops_llm_*` SHALL aplicar RLS: `service_role` acesso total (worker escreve); `authenticated` só **leitura tenant-scoped** (sem insert/update), espelhando `credit_change_proposal`.

## 7. Critérios de aceite
- **AC-001 (FR-001, FR-002):** Dado um workflow credit com 1 conta escopada e um transporte que responde 1 tool round + 1 resposta final; Quando o workflow roda; Então `ops_llm_usage_event` tem **2** linhas com o mesmo `run_id`/`tenant_id`/`agent_key='credit-analyst'`/`item_key=account_id`, `round_index` 0 e 1, tokens preenchidos. E os tokens batem com o `usage` do fake.
- **AC-002 (FR-003):** Dado um completion 200 **sem** `usage`; Quando a chamada é capturada; Então a linha tem `metering_status='missing'`, `prompt_tokens/completion_tokens/provider_cost_usd` nulos, e não aparece em `ops_llm_cost_by_tenant_day`.
- **AC-003 (FR-004):** Dado um transporte que devolve tool calls em todas as rodadas até estourar `max_tool_rounds`; Quando `chat_with_tools` levanta `MaxToolRoundsExceededError`; Então o sink já foi chamado para cada chamada feita e as linhas correspondentes existem.
- **AC-004 (FR-005, FR-006):** Dado rate-card `gpt-4.1-mini`=(in 0.0004, out 0.0016 por 1k) e plano default markup 0.30; Quando um evento com prompt=1000/completion=500/cached=0 é precificado; Então `provider_cost_usd≈0.0004·1+0.0016·0.5=0.0012` e `billable_cost_usd≈0.00156` (±1e-6).
- **AC-005 (FR-007):** Dado a 2ª tentativa de schema da mesma execução; Quando capturada; Então `chargeable=false` e `chargeability_reason='schema_repair'`, mas `provider_cost_usd>0`.
- **AC-006 (FR-008):** Dado o mesmo evento persistido duas vezes (retry da activity com mesmo `response_id`); Quando inserido; Então existe **1** linha (upsert on `idempotency_key`), sem erro.
- **AC-007 (SEC-001):** Dado a migration aplicada; Quando um papel `authenticated` tenta `insert` em `ops_llm_usage_event`; Então é negado; e um `select` só retorna linhas do tenant do claim; `service_role` insere e lê.
- **AC-008 (FR-009):** Dado 2 eventos cobráveis para tenant T no dia D; Quando consulto `ops_llm_cost_by_tenant_day`; Então há 1 linha (T,D) com `sum(provider_cost_usd)` e `sum(billable_cost_usd)`.

## 8. Contrato de implementação
- **Arquivos alvo:** `supabase/migrations/20260627000000_llm_usage_metering.sql` (novo); `temporal/src/agents/openai_client.py`; `temporal/src/activities/ops_llm_usage.py` (novo); `temporal/src/agents/credit_analyst.py`; `temporal/src/activities/ops_credit.py`; `temporal/src/workflows/ops/credit.py`; `temporal/src/worker.py`; `temporal/tests/test_openai_client.py`; `temporal/tests/test_ops_llm_usage.py` (novo); `supabase/tests/llm_usage_metering_contract.test.mjs` (novo).
- **Dependências permitidas:** só o que já existe (pydantic, urllib, temporalio, node:test). **Proibido:** novos pacotes; SDK `openai`/`azure`; `tiktoken`; I/O de banco em `openai_client.py`.
- **Dados / migração / rollback:** migration aditiva e idempotente (`create table if not exists`), timestamp `> 20260626140001`. Rollback = `drop view/table` das novas entidades (nenhuma tabela existente é alterada). Validar no DB compartilhado **somente** via `docker exec … psql` dentro de `BEGIN;…ROLLBACK;` — **nunca** `supabase db reset` (`CLAUDE.md:66`).
- **Security-trigger check:** Cruza fronteira de confiança / dados sensíveis (custo/financeiro multi-tenant) / migração / permissões? **SIM** → Threat model:
  - **Trust boundaries:** worker (service_role, escreve) × usuário do portal (`authenticated`, lê só seu tenant) × PostgREST/RLS.

    | Ameaça | STRIDE | Componente | Disposição | Mitigação |
    |---|---|---|---|---|
    | Tenant A lê custo de Tenant B | Information Disclosure | RLS de `ops_llm_usage_event` | mitigate | política `*_tenant_read` com `ops_tenant_match(tenant_id)` (espelha `credit_change_proposal:54-61`) |
    | Usuário grava/forja custo | Tampering/Elevation | grants | mitigate | `revoke ... from authenticated`; só `service_role` insere (AC-007) |
    | Dupla contagem por retry | Tampering (integridade de cobrança) | persistência | mitigate | `idempotency_key` único (FR-008/AC-006) |
    | Vazar `raw_usage`/prompts | Information Disclosure | coluna `raw_usage` | accept (mitigado) | `raw_usage` guarda só o objeto `usage` (tokens), **não** mensagens/prompt; documentar no comentário da coluna |
  - Sem novas dependências → sem nota de legitimidade de pacote.
- **Stop gates:** se a migration não aplicar limpa em `BEGIN;…ROLLBACK;`, **parar** e corrigir antes de qualquer task Python. Se `run_id` não estiver disponível no ponto de chamada do agente, **parar** (não inventar um id).

## 9. Camada executável de tarefas

- [ ] **T-001** [reqs: FR-001, FR-002, FR-003, FR-005, FR-006, FR-007, FR-008, FR-009, NFR-002, SEC-001] [depends: —]
      **Files:** `supabase/migrations/20260627000000_llm_usage_metering.sql` (novo)
      **Precondition/skip-if:** pular se o arquivo existe e aplica limpo; confirmar que `20260627000000` > `ls supabase/migrations | sort | tail -1`.
      **Read first:** `supabase/migrations/20260609000000_ops_credit_proposal.sql:6-69` (template RLS/grants); `20260607170000_ops_factory_persistence.sql:28-37,153-165` (`ops_workflow_run`, helpers RLS); `20260609110000_…:95-160` (padrão de view de rollup).
      **Action:** criar a migration com:
      1. `ops_llm_rate_card(id uuid pk default gen_random_uuid(), provider text not null default 'azure_openai', provider_model text not null, unit_of_measure text not null default 'per_1k', billing_mode text not null default 'payg', currency text not null default 'USD', price_input numeric not null, price_output numeric not null, price_cached_input numeric not null default 0, effective_from timestamptz not null default now(), effective_to timestamptz, source text, version int not null default 1, created_at timestamptz not null default now())` + index `(provider, provider_model, effective_from desc)`.
      2. `ops_tenant_llm_plan(id uuid pk default gen_random_uuid(), tenant_id uuid references tenants(id) on delete cascade, plan_key text, markup_pct numeric not null default 0, markup_floor numeric not null default 0, effective_from timestamptz not null default now(), effective_to timestamptz, created_at timestamptz not null default now())` — `tenant_id` nulo = default de plano; index `(tenant_id, effective_from desc)`.
      3. `ops_llm_usage_event(id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, run_id text references ops_workflow_run(run_id) on delete set null, workflow_id text, activity_id text, activity_attempt int, agent_key text not null, item_key text, provider text not null default 'azure_openai', provider_model text, deployment text, api_version text, meter_name text, unit_of_measure text, round_index int, schema_attempt int, prompt_tokens int, completion_tokens int, total_tokens int, cached_input_tokens int, reasoning_tokens int, raw_usage jsonb, metering_status text not null default 'ok', provider_cost_usd numeric, billable_cost_usd numeric, rate_card_id uuid references ops_llm_rate_card(id), markup_pct numeric, chargeable boolean not null default true, chargeability_reason text, priced_at timestamptz, idempotency_key text not null, created_at timestamptz not null default now(), constraint uq_ops_llm_usage_idempotency unique (idempotency_key), constraint chk_ops_llm_metering_status check (metering_status in ('ok','missing','partial')))` + indexes `(tenant_id, created_at)`, `(run_id)`.
      4. Views (`security_invoker=true`): `ops_llm_cost_by_run` (group by tenant_id, run_id, agent_key → sum custos, count), `ops_llm_cost_by_tenant_day` (group by tenant_id, `date(created_at)` → sums; **filtrar `metering_status='ok' and chargeable`**), `ops_llm_cost_by_agent_model` (group by tenant_id, agent_key, provider_model → sums).
      5. RLS/grants para as 3 tabelas espelhando `ops_credit_proposal.sql:42-69`: `revoke all from anon, authenticated`; `grant select to authenticated`; `grant all to service_role`; `enable row level security`; política `_tenant_read` (`ops_claim_app_role() in ('admin','branch_manager','field_operator','read_only') and ops_tenant_match(tenant_id)`) — para `ops_tenant_llm_plan` use `(tenant_id is null or ops_tenant_match(tenant_id))`; `ops_llm_rate_card` é global → leitura `authenticated using(true)`; política `_service_role_all using(true) with check(true)` nas 3.
      6. Seed: 1 `ops_llm_rate_card` placeholder (`provider_model='gpt-4.1-mini'`, `price_input=0.0004`, `price_output=0.0016`, `unit_of_measure='per_1k'`, `source='seed-placeholder'`) e 1 `ops_tenant_llm_plan` default (`tenant_id=null`, `plan_key='default'`, `markup_pct=0.30`). Comentário SQL marcando como placeholders a calibrar (NC-001).
      **Re-run safety:** `create table/view if not exists` + `drop policy if exists` antes de `create policy` + seed via `on conflict do nothing`/`where not exists`.
      **Verify:** `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "begin; $(cat supabase/migrations/20260627000000_llm_usage_metering.sql); rollback;"` → termina sem erro (PASS = sem `ERROR:` na saída).
      **Done:** dentro de uma txn, `\d ops_llm_usage_event` mostra as colunas e a unique `uq_ops_llm_usage_idempotency`; as 3 views existem; `select polname from pg_policies where tablename='ops_llm_usage_event'` lista as 2 políticas.
      **Recovery/Rollback:** as novas tabelas/views são removíveis por `drop`; nenhuma entidade existente é tocada.

- [ ] **T-002** [P] [reqs: FR-001, FR-003, FR-004, NFR-001] [depends: —]
      **Files:** `temporal/src/agents/openai_client.py`
      **Read first:** `openai_client.py:51-56` (AgentRunResult), `:144-178` (loop+complete), `:220-229` (retorno+falha schema).
      **Action:** (1) adicionar modelo `LlmCallUsage(BaseModel)` com `round_index:int, schema_attempt:int, model:str|None, response_id:str|None, finish_reason:str|None, prompt_tokens:int|None, completion_tokens:int|None, total_tokens:int|None, cached_input_tokens:int|None, reasoning_tokens:int|None, metering_status:str, chargeable:bool, chargeability_reason:str|None, raw_usage:dict|None`. (2) helper `_extract_usage(completion, *, round_index, schema_attempt, chargeable, chargeability_reason) -> LlmCallUsage` que lê `completion.get("usage")` (→ `metering_status='missing'` e tokens None se ausente), `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`, `completion.get("model")`, `completion.get("id")`, `choices[0].finish_reason`. (3) adicionar param `on_llm_call: Callable[[LlmCallUsage], Awaitable[None]] | None = None` a `chat_with_tools`. (4) após cada `completion = await llm_transport.complete(...)` (:171), calcular a `LlmCallUsage` (chargeable=False/reason='schema_repair' quando `schema_attempt>0`; reason='tool_round' não muda chargeable) e, se `on_llm_call`, `await on_llm_call(call)`; acumular em `llm_calls`. (5) adicionar `llm_calls: list[LlmCallUsage] = []` a `AgentRunResult` e retorná-la em :222. (6) exportar `LlmCallUsage` em `__all__`.
      **Re-run safety:** edição idempotente de código; sem efeito colateral externo.
      **Verify:** `cd temporal && python -m pytest tests/test_openai_client.py -v` (após T-007) e `ruff check src/agents/openai_client.py` → PASS.
      **Done:** `grep -n "on_llm_call\|LlmCallUsage\|llm_calls" temporal/src/agents/openai_client.py` mostra os 3; `grep -c "import" não inclui cliente de persistência` (NFR-001).

- [ ] **T-003** [reqs: FR-005, FR-006, FR-007, FR-008, NFR-001] [depends: T-001, T-002]
      **Files:** `temporal/src/activities/ops_llm_usage.py` (novo)
      **Read first:** `temporal/src/activities/ops_revrec.py:228-300,622-636` (cliente PostgREST + `ops_create_workflow_run`); `temporal/src/agents/openai_client.py` (LlmCallUsage de T-002).
      **Action:** criar módulo com: (1) `price_usage(call, *, rate_card_row, markup_pct) -> tuple[provider_cost_usd, billable_cost_usd]` aplicando a fórmula de FR-005 com `unit_of_measure` ('per_1k'→/1000, 'per_1m'→/1_000_000); retorna (None,None) se `metering_status!='ok'`. (2) `_resolve_rate_card(client, provider, model, at)` e `_resolve_markup(client, tenant_id, at)` (override tenant→default `tenant_id is null`) via `client.select(...)` ordenado por `effective_from desc`. (3) `@activity.defn async def persist_llm_usage_event(event: dict) -> dict` que usa `ops_revrec._get_ops_persistence_client().upsert("ops_llm_usage_event", row, on_conflict="idempotency_key")` (upsert = idempotente p/ retries). (4) `build_usage_sink(*, tenant_id, run_id, workflow_id, activity_id, activity_attempt, agent_key, item_key) -> Callable` que devolve uma corrotina `on_llm_call(call)` montando `idempotency_key` (FR-008) + precificando + chamando `persist_llm_usage_event` (via `await asyncio.to_thread` p/ o insert síncrono). Sem import de `openai_client`→ usar `Any`/TYPE_CHECKING p/ evitar ciclo.
      **Re-run safety:** persistência por upsert em `idempotency_key`; reprocessar a mesma chamada não duplica.
      **Verify:** `cd temporal && python -m pytest tests/test_ops_llm_usage.py -v` (T-007) → PASS.
      **Done:** `persist_llm_usage_event` e `build_usage_sink` existem; teste de pricing (AC-004) e idempotência (AC-006) passam.

- [ ] **T-004** [P] [reqs: FR-001] [depends: T-002]
      **Files:** `temporal/src/agents/credit_analyst.py`
      **Read first:** `credit_analyst.py:45-67` (`run_credit_analyst`).
      **Action:** adicionar param `on_llm_call=None` a `run_credit_analyst` e repassá-lo em `chat_with_tools(..., on_llm_call=on_llm_call)`.
      **Re-run safety:** edição idempotente.
      **Verify:** `cd temporal && python -m pytest tests/test_credit_analyst.py -v` e `ruff check src/agents/credit_analyst.py` → PASS.
      **Done:** `grep -n on_llm_call temporal/src/agents/credit_analyst.py` mostra o param e o repasse.

- [ ] **T-005** [reqs: FR-002, FR-007, FR-008] [depends: T-003, T-004]
      **Files:** `temporal/src/activities/ops_credit.py`, `temporal/src/workflows/ops/credit.py`
      **Read first:** `ops_credit.py:381-425` (`ops_credit_assess`); `credit.py:79-94,122-132` (run_id + call site).
      **Action:** (1) em `ops_credit.py`: mudar assinatura para `ops_credit_assess(account_payload, config, run_id: str | None = None)`; dentro, importar `from temporalio import activity` (já usado :409), obter `info = activity.info()`; construir `sink = ops_llm_usage.build_usage_sink(tenant_id=account_payload.get("tenant_id"), run_id=run_id or "", workflow_id=info.workflow_id, activity_id=info.activity_id, activity_attempt=info.attempt, agent_key="credit-analyst", item_key=str(account_payload.get("account_id") or ""))`; passar `on_llm_call=sink` em `run_credit_analyst(...)` (:417-424). (2) em `credit.py:125`: trocar `args=[account_payload, config]` por `args=[account_payload, config, run_id]`.
      **Re-run safety:** `run_id` opcional preserva chamadas antigas; sink persiste via upsert idempotente.
      **Verify:** `cd temporal && python -m pytest tests/test_ops_credit_activity.py -v` → PASS (asserções de AC-001/AC-003).
      **Done:** `ops_credit_assess` aceita `run_id`; `credit.py` passa `run_id`; teste mostra linhas em `ops_llm_usage_event` do fake após uma execução multi-rodada.

- [ ] **T-006** [reqs: FR-001] [depends: T-003]
      **Files:** `temporal/src/worker.py`
      **Read first:** `temporal/src/worker.py:1457-1560` (lista `activities=[...]`, cluster credit `~:1540-1555`).
      **Action:** importar `persist_llm_usage_event` e adicioná-la à lista `activities=[...]` do `Worker`.
      **Re-run safety:** adição idempotente; registro duplicado é detectável pelos testes de registro.
      **Verify:** `cd temporal && python -m pytest tests/test_worker_registration.py tests/test_activity_registration_unique.py -v` → PASS.
      **Done:** `grep -n persist_llm_usage_event temporal/src/worker.py` aparece no import e na lista.

- [ ] **T-007** [reqs: FR-001, FR-003, FR-004, FR-005, FR-007, FR-008] [depends: T-002, T-003]
      **Files:** `temporal/tests/test_openai_client.py`, `temporal/tests/test_ops_llm_usage.py` (novo)
      **Read first:** `test_openai_client.py:24-54` (`_FakeTransport`/`_assistant_response`); `test_ops_revrec_activity.py:91-164` (`_FakeOpsPersistenceClient`).
      **Action:** (a) em `test_openai_client.py`: estender `_assistant_response` para aceitar `usage=None` e incluí-lo no dict retornado; novo teste — passar `on_llm_call` coletor a `chat_with_tools` e asserir 1 chamada por rodada com tokens corretos (AC-001), `metering_status='missing'` quando `usage=None` (AC-002/AC-003 base), e que o estouro de tool rounds já chamou o sink (AC-003). (b) `test_ops_llm_usage.py`: testar `price_usage` (AC-004), `chargeable=false`/reason em schema-repair (AC-005), e `persist_llm_usage_event` idempotente (AC-006) usando um `_FakeOpsPersistenceClient` com `tables` incluindo `ops_llm_usage_event/ops_llm_rate_card/ops_tenant_llm_plan` (monkeypatch `ops_revrec._ops_client`).
      **Re-run safety:** testes puros, sem estado externo.
      **Verify:** `cd temporal && python -m pytest tests/test_openai_client.py tests/test_ops_llm_usage.py -v` → PASS.
      **Done:** os testes de AC-001..AC-006 (lado Python) passam.

- [ ] **T-008** [reqs: SEC-001, FR-009] [depends: T-001]
      **Files:** `supabase/tests/llm_usage_metering_contract.test.mjs` (novo)
      **Read first:** `supabase/tests/vehicle_aging_contract.test.mjs:22-80` (padrão `psql`/`withFixture`/`BEGIN;…ROLLBACK;`, container `supabase_db_dealernet-agents`).
      **Action:** novo teste node que, dentro de `BEGIN;…ROLLBACK;`: aplica a migration T-001; sob `set local request.jwt.claim.role='authenticated'` + claim de tenant, asseta que `insert` em `ops_llm_usage_event` é **negado** e `select` só vê o tenant do claim (AC-007); sob `service_role` insere 2 eventos cobráveis e asseta `ops_llm_cost_by_tenant_day` agrega (AC-008).
      **Re-run safety:** tudo em txn revertida; nunca muta o DB compartilhado.
      **Verify:** `node --test --test-concurrency=1 supabase/tests/llm_usage_metering_contract.test.mjs` → PASS.
      **Done:** asserções de AC-007 e AC-008 passam.

## 10. Matriz de cobertura
| Requisito | Aceite | Task(s) | Comando de verificação | Evidência (path:line) |
|---|---|---|---|---|
| FR-001 | AC-001 | T-002, T-003, T-005, T-006, T-007 | `pytest tests/test_openai_client.py tests/test_ops_credit_activity.py` | `openai_client.py:171,178` |
| FR-002 | AC-001 | T-001, T-005 | `pytest tests/test_ops_credit_activity.py` | `ops_credit.py:397-398`; `credit.py:94` |
| FR-003 | AC-002 | T-002, T-007 | `pytest tests/test_openai_client.py` | OpenAI ref: `usage` opcional |
| FR-004 | AC-003 | T-002, T-005, T-007 | `pytest tests/test_openai_client.py` | `openai_client.py:181-184,223-229` |
| FR-005 | AC-004 | T-001, T-003, T-007 | `pytest tests/test_ops_llm_usage.py` | MS prompt-caching/pricing |
| FR-006 | AC-004 | T-001, T-003 | `pytest tests/test_ops_llm_usage.py` | `20260609000000_…` (template) |
| FR-007 | AC-005 | T-002, T-003, T-007 | `pytest tests/test_ops_llm_usage.py` | A-001 |
| FR-008 | AC-006 | T-003, T-005, T-007 | `pytest tests/test_ops_llm_usage.py` | `ops_revrec.py:259-267` (upsert) |
| FR-009 | AC-008 | T-001, T-008 | `node --test supabase/tests/llm_usage_metering_contract.test.mjs` | `20260609110000_…:95-160` |
| NFR-001 | (estrutural) | T-002, T-003 | `grep -L persist temporal/src/agents/openai_client.py` | `openai_client.py` |
| NFR-002 | (estrutural) | T-001 | revisão de colunas em \d | T-001 colunas provider/* |
| SEC-001 | AC-007 | T-001, T-008 | `node --test supabase/tests/llm_usage_metering_contract.test.mjs` | `20260609000000_…:42-69` |

## 11. Relatório de auto-verificação
- [x] Sem placeholders/TODOs nas tasks (DDL e ações concretas; sem "similar a"/"TBD").
- [x] Toda FR/NFR/SEC → ≥1 task e toda task → ≥1 requisito (matriz fecha nos dois sentidos).
- [x] Toda task tem Files / Action / Verify / Done.
- [x] Todo fato de código cita path:line real (verificado nos arquivos lidos em §2; nenhum caminho inventado).
- [x] Aceite testável (Given/When/Then, com casos de erro: AC-002 missing, AC-003 falha, AC-006 dedup, AC-007 negação).
- [x] Conflitos resolvidos e marcados (drift × intended change em §2).
- [x] Gate de tamanho: **8 tasks**, **3 jornadas**. Arquivos = 10 (7 de produção + 3 de teste co-localizados); o excedente sobre 8 é só por testes — o **escopo** já é a fatia mínima coerente, com rollout e reconciliação **explicitamente fatiados** em follow-ups (§3). Sem balão.
- [x] Security-trigger check feito; STRIDE expandido (SIM disparou: migração + RLS + dados financeiros multi-tenant).
- [x] Sem bulk inlado (cita código; o único SQL embutido é DDL **nova** a criar, não cópia de arquivo existente).
- **Veredito:** EXECUTABLE ✅
