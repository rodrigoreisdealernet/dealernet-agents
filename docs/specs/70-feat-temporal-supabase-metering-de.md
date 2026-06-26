# Spec — feat(temporal/supabase): metering de custo de tokens LLM por execução de agente (fundação + piloto credit)

**Issue:** #70
**Branch:** `feature/70-feat-temporal-supabase-metering-de`
**Status:** APPROVED (via `/ship-issue 70 --approved`).

## Overview
Registrar, precificar e tornar consultável o custo de tokens LLM de cada execução
do agente **credit** da Operations Factory, sobre uma **fundação de medição
agnóstica de provedor** reutilizável pelos demais agentes. Cada chamada real ao
Azure OpenAI vira um *usage event* atribuído a `tenant/run/agent/model`, precificado
como **custo Azure + markup % por cliente/plano**, e exposto em views de rollup por
cliente. Esta é uma fatia vertical: medição + atribuição + piloto no agente credit.

## Problem / Context
Hoje o transporte LLM (`temporal/src/agents/openai_client.py`) já recebe da Azure o
JSON completo da resposta — incluindo `usage`, `model` e `id` — mas **descarta tudo
exceto a mensagem do assistente**. Não há nenhum registro de quantos tokens cada
execução de agente consome, nem de quanto isso custa por cliente. Sem isso, a
software house não consegue atribuir custo de IA a cada concessionária (`tenant`)
nem aplicar markup para faturamento. O grounding confirma que `fx_rates` e os padrões
de tabela worker-write/UI-read (`ops_credit_proposal`) já existem e devem ser
reutilizados; o `run_id` precisa ser propagado até a activity do agente.

## Acceptance Criteria
- [ ] **AC-001 — Um evento por chamada real:** Ao rodar o workflow credit com 1 conta
  escopada e um transporte que faz 1 tool round + 1 resposta final, são gravadas
  **2 linhas** em `ops_llm_usage_event` com o mesmo `run_id`/`tenant_id`,
  `agent_key='credit-analyst'`, `item_key=account_id`, `round_index` 0 e 1, e os
  tokens preenchidos batendo com o `usage` retornado pelo provedor.
- [ ] **AC-002 — Resposta sem usage não inventa tokens:** Quando um completion 200
  chega **sem** `usage`, a linha é persistida com `metering_status='missing'`,
  tokens e `provider_cost_usd` nulos, e **não** aparece nos rollups cobráveis
  (`ops_llm_cost_by_tenant_day`).
- [ ] **AC-003 — Falha não perde o que já foi medido:** Quando uma execução estoura
  `max_tool_rounds`/tentativas de schema e levanta erro, as chamadas já feitas
  **já deixaram suas linhas** registradas (persistência crash-safe por chamada).
- [ ] **AC-004 — Preço = custo Azure + markup:** Para o rate-card `gpt-4.1-mini`
  (in 0.0004 / out 0.0016 por 1k) e plano default markup 0,30, um evento de
  prompt=1000/completion=500/cached=0 resulta em `provider_cost_usd≈0.0012` e
  `billable_cost_usd≈0.00156` (±1 centavo).
- [ ] **AC-005 — Retries/reparos não são cobrados, mas contam o custo:** Numa 2ª
  tentativa de schema, a linha fica `chargeable=false` com
  `chargeability_reason='schema_repair'`, porém com `provider_cost_usd>0`.
- [ ] **AC-006 — Sem dupla contagem:** Persistir o mesmo evento duas vezes
  (retry da activity com mesmo `response_id`) resulta em **1 linha** (upsert por
  `idempotency_key`), sem erro.
- [ ] **AC-007 — Isolamento multi-tenant (RLS):** Um papel `authenticated` **não**
  consegue `insert` em `ops_llm_usage_event` e só lê linhas do próprio tenant;
  o `service_role` insere e lê.
- [ ] **AC-008 — Rollup por cliente/dia:** Dois eventos cobráveis para o tenant T no
  dia D produzem **1 linha** (T,D) em `ops_llm_cost_by_tenant_day` com
  `sum(provider_cost_usd)` e `sum(billable_cost_usd)`.

## Non-Goals
- Sem geração de fatura, cobrança, portal do cliente, créditos pré-pagos ou pricing
  por outcome.
- Sem rollout aos demais agentes ops (revrec, branch, technician, etc.) — fica para
  o follow-up PRD "rollout metering".
- Sem automação de reconciliação contra Azure Cost Management/FOCUS nem extrato em
  BRL ao cliente — fica para o follow-up PRD "reconciliação & extrato".
- Sem alteração do comportamento de negócio dos agentes (mesmas decisões/findings).
- Sem instrumentar a software factory (agentes Claude em `.github/`).

## Out-of-Scope
- Conversão de câmbio USD→BRL e a fonte/tabela de FX (eventos permanecem em USD;
  reutilizará `fx_rates` no follow-up de reconciliação).
- Alocação de custo no modo **PTU** (`ops_llm_cost_allocation`) — esta fatia trata
  os deployments como **PAYG** via `billing_mode` no rate-card; PTU depende do
  inventário Azure (NC-001).
- Estender a medição a provedores não-Azure na prática (o schema é agnóstico de
  provedor, mas o piloto cobre apenas Azure OpenAI / agente credit).
