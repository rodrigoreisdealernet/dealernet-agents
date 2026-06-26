# Spec — Contas a Receber + revisão de dados/execução dos agentes DIA

**Status:** APPROVED (escopo confirmado pelo solicitante: tela Fast BI, menu em
Fast BI → Indicadores Operacionais, seed rico ~8 clientes).
**Método:** AI-DLC (brownfield) — reverse-engineering dos agentes → requisitos →
critérios de aceite → design → validação.

## Overview

Revisão dos 4 agentes de IA ativos do DIA quanto a (a) **terem dados** (tabelas)
para trabalhar e (b) **executarem de fato** — não apenas "fingirem". O foco é o
agente de cobrança (`collections-prioritizer`): ele tem backing de dados, mas era
o **único dos 4 sem tela no portal**, então o valor que ele prioriza ficava
invisível ao operador. Esta mudança adiciona a tela **"Contas a Receber"** (Fast
BI read-only) e enriquece o seed de cobrança para o agente ranquear de forma
significativa.

## Reverse-engineering — estado dos 4 agentes

| Agente | Fonte de dados | Tela no portal | Execução |
|---|---|---|---|
| vehicle-aging-analyst | `v_dia_vehicle_current` | ✅ Estoque + Fast BI | LLM real; **executa a ação após aprovação** (#73, `finding_action`) |
| parts-inventory-advisor | `v_dia_part_current` / part_sale | ✅ Estoque + Venda + Fast BI | LLM real |
| service-estimate-rescue | service order + estimate ETL | ✅ Ordens de Serviço + Oficina Fast BI | LLM real |
| collections-prioritizer | `v_dia_receivable_current` + `v_dia_collection_contact_current` | ❌ **nenhuma** (corrigido aqui) | LLM real |

Fatos verificados:

- **Ninguém "finge".** `temporal/src/agents/openai_client.py` faz chamada HTTP real
  ao Azure OpenAI e **lança** `AzureOpenAIConfigurationError` se a config faltar —
  não há transporte stub/echo. Todo agente roda um LLM de verdade.
- O agente de cobrança **tem** tabelas/views/RLS/config (migrations
  `20260627130300_dia_receivable_entity_crud.sql`,
  `20260627130400_dia_collection_contact_entity_crud.sql`,
  `20260627130600_collections_prioritizer_agent.sql`). O workflow
  (`temporal/src/workflows/ops/collections_prioritizer.py`) escopa títulos via
  `ops_scope_collections` lendo `v_dia_receivable_current` (status `aberto`) +
  `v_dia_collection_contact_current`, ranqueia por exposição e grava `finding`.
- **Lacunas reais do agente de cobrança:** (1) o seed era uma fixture mínima (1
  cliente, 3 títulos) → ranking/BI trivial; (2) **não havia tela "Contas a
  Receber"** no menu, diferente dos outros 3 agentes que têm tela própria.

## Acceptance Criteria

- [x] **Existe a tela "Contas a Receber"** (Fast BI read-only) que lê
  `v_dia_receivable_current` (mesma fonte do agente) via `getReceivables()`,
  exibindo KPIs (total em aberto, total vencido, clientes, títulos, maior atraso,
  ticket médio), gráfico de **exposição por faixa de atraso** (a vencer / 1–30 /
  31–60 / 61–90 / 90+), **top clientes por exposição vencida** e lista dos
  **títulos vencidos mais críticos**.
- [x] **A tela está no menu** em Fast BI → Indicadores Operacionais
  (`fast-bi-receivables` → `dia-receivables`), registrada no `registry.ts`.
- [x] **Read-only**: a tela não faz nenhuma escrita (`supabase.rpc`), compõe
  `ChartCard`/`KpiCard` e não importa `recharts` direto.
- [x] **Rótulos localizados** pt-BR e en-US em `screens.receivablesBI`, em paridade
  de chaves; rótulo de menu nos dois bundles.
- [x] **Seed com substância**: ~8 clientes (`demo-dia-custvol-collections-%`) e 18
  títulos (`demo-dia-recvol-%`) cobrindo todas as faixas de atraso, sem colidir
  com a fixture curada `demo-dia-receivable-001..003`.
- [x] **Cobertura de teste**: `scripts/verify-receivables-screen.mjs` (node:test
  dependency-free) na lista do `npm test`.

## Design

- **Frontend** (`frontend-portal/`):
  - `agentsApi.getReceivables()` → leitura direta da view (security_invoker → RLS
    `authenticated`), `status=aberto`, ordenado por `days_overdue`.
  - `ReceivablesBI.tsx` deriva tudo no cliente (KPIs, aging, rollup por cliente);
    `overdueTone`/`agingBucket` espelham `_severity_for_days` do backend.
  - `format.ts` ganha `formatDate` (data sem hora, ancorada ao meio-dia p/ evitar
    deslocamento de fuso em datas puras `YYYY-MM-DD`).
  - Menu: item em `MOCK_MENU` (portalApi.ts) no grupo `fast-bi`.
- **Seed** (`supabase/seed.sql`): bloco idempotente (DELETE por namespace →
  `rental_upsert_entity_current_state` sob guard `service_role`) gerando clientes
  + títulos com `due_date = hoje − offset` para distribuir as faixas.

## Non-Goals / Out-of-Scope

- Não cria CRUD de títulos a receber (a tela é Fast BI read-only).
- Não implementa "executar a ação após aprovação" para o agente de cobrança — as
  recomendações (ligar/renegociar/notificar) são assist-only, como o padrão
  `pending_execution` não-monetário do #73.
- Não altera a análise/prompt do agente nem a integração com Azure OpenAI.
- Não toca nos outros 3 agentes (já têm dados e tela).

## Validação

- `tsc -b` → 0; `npm test` → 201 passing (inclui os 11 novos + i18n parity);
  `eslint` nos arquivos alterados → 0; `vite build` → OK.
- Seed validado contra o container (`docker exec … psql`, em transação com
  ROLLBACK): 8 clientes / 18 títulos; via a view, as 5 faixas de aging populadas
  (a vencer 4, 1–30 5, 31–60 3, 61–90 3, 90+ 3).
