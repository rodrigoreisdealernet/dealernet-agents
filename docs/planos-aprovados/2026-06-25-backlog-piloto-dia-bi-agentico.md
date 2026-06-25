# Backlog de issues do piloto DIA — BI agêntico

- **Título:** Backlog de issues do piloto DIA — BI agêntico em `dealernet-agents`
- **Data de aprovação:** 2026-06-25
- **Versão:** v0.1 (SemVer)
- **Status:** Aprovado

---

## Contexto

O workshop accelerator de palm-beach (`C:\Dealernet\accelerator-palm-beach-dealernet`) validou a **DIA** (brief matinal do dono) e o **FastBI** (BI conversacional). Aquele repo é material de produto — não é código.

Este repo (`dealernet-agents`, remote `rodrigoreisdealernet/dealernet-agents`) é a plataforma DIA: React + Temporal + Supabase, com um modelo de dados genérico, agentes em Temporal, um fluxo de `finding` (aprovar/rejeitar) e uma `ops_api`. O objetivo é transformar o conceito DIA em issues pequenas e atômicas que o `/ship-issue` consiga levar de spec → código → testes → review → merge.

**Visão final:**
- O brief matinal é **parte do processo agêntico** e será **configurável por usuário** (quais seções/KPIs, agenda, canais). O **brief do dono** é o primeiro template/preset do piloto — a issue do brief é pensada como um **motor de briefing**, não um brief único.
- Primeiro **criar o banco que serve de base ao mock** das visões de concessionária (VN, VU, Oficina, Estoque) e depois **inserir dados mockados** para demonstração.
- O **portal DIA** (estilo Portal DMS, staff-facing) terá menus com **visões e gráficos** — BI agêntico.

## Decisões de arquitetura (ancoradas no código)

1. **Domínio mock = modelo genérico.** Modelar como novos `entity_types` no modelo `entities`+`entity_versions` (JSONB via RPC `rental_upsert_entity_current_state`): `company`, `brand`, **`vehicle` único com `condition` (novo|usado)** + `cost`/`list_price`/`purchase_date`/`status` **e os campos de venda no próprio veículo** (`sold_at`/`sold_price`/`salesperson`/`customer` — não há entidade `vehicle_sale` separada; VN/VU derivado de `condition`, vendas = veículos com `status=vendido`), `service_order` e `part`. Floor plan calculado de `purchase_date`+`cost` (até `sold_at`/hoje). Métricas em novos `fact_types` e **views analíticas** no padrão de `v_home_dashboard_kpis` (`supabase/migrations/20260606152000_home_dashboard_kpis.sql`).
2. **Gráficos.** Não há lib de charting hoje (só `StatCard`). Adicionar **recharts** + um widget `ChartCard` registrado no UIEngine (`frontend/src/registry/index.ts`).
3. **Portal DIA (BI) é staff-facing** na app principal: novas rotas `/dia/*` + itens em `frontend/src/components/nav-config.ts` + páginas `frontend/src/pages/*.json` (UIEngine, ADR-0016). A pasta `frontend/src/routes/portal/` é customer-facing e **não** é onde isto vive.
4. **Config por usuário.** Nova tabela `user_briefing_config` (seções/KPIs/agenda/canais em JSONB, RLS por dono + admin), no padrão de `accounting_export_config` e `profiles`.

## Como criamos as issues

- **Repositório:** `rodrigoreisdealernet/dealernet-agents` (`gh issue create` a partir da raiz).
- **Labels:** `dia` em todas; área (`area:db` / `area:temporal` / `area:frontend`); capacidade (`cap:data` / `cap:briefing` / `cap:portal` / `cap:alerts` / `cap:bi` / `cap:actions`).
- **Template do corpo:** **Objetivo** · **Contexto** · **Critérios de Aceitação** (3–6, testáveis) · **Arquivos/pistas** · **Fora de escopo**.
- **Cadência:** criar **uma issue por vez**, aguardando ok antes da próxima.

## Issues por capacidade (atômicas, ordenadas por dependência)

### A — Fundação de dados demo (mock concessionária) · `cap:data`
- **A1 `feat(db)`: fundação de dados demo DIA (schema + seed, básico p/ apresentação).** Issue #3. Modelar como `entity_types`: **usuários** (via `profiles`+roles), **loja** (`store`), **marca** (`brand`), **veículo único** (`vehicle` com `condition` novo|usado + `cost`/`sale_price`/`purchase_date`/`status`), **venda** (`vehicle_sale` → referencia o veículo; VN/VU derivado da condição) e **Oficina** (`service_order`). Floor plan de `purchase_date`+`cost`. `fact_types` (inclui `stock_aging_days`, `stock_floor_plan_cost`) + **views** `v_dia_owner_kpis`, `v_dia_vn_summary`, `v_dia_vu_summary`, `v_dia_service_summary`, `v_dia_inventory_summary` (drill por marca/loja), `security_invoker=true`. Seed idempotente (`demo-dia-%`) + `time_series_points` de ~90 dias. *Arquivos:* `supabase/migrations/<novo>.sql`, `supabase/seed.sql`.

### B — Motor de briefing agêntico configurável · `cap:briefing`
- **B1 `feat(db)`: tabela `user_briefing_config`.** Preferências por usuário (JSONB) com RLS own-row + admin e default seedado.
- **B2 `feat(temporal)`: motor de briefing + template "Dono".** Agente lê `user_briefing_config` e monta seções habilitadas; `OwnerBriefTemplate` (resumo executivo + VN/VU/Oficina/Estoque + ganchos p/ alertas). Reusa `branch_brief_assistant`/`chat_with_tools`, workflow `ops`, `POST /api/ops/briefing/run`. *Depende de A1, B1.*
- **B3 `feat(frontend)`: tela "Meu Briefing" (ver + configurar).** Rota `/briefing` + painel que grava em `user_briefing_config`; item no `nav-config.ts`. *Depende de B2.*

### C — Portal DIA: menus + gráficos · `cap:portal`
- **C1 `feat(frontend)`: widget `ChartCard` no UIEngine (recharts).** *(Habilitador.)*
- **C2 `feat(frontend)`: dashboard "Visão do Dono".** Página `/dia/overview` (`StatCard` de `v_dia_owner_kpis` + `ChartCard`) + menu. *Depende de A1, C1.*
- **C3–C6 `feat(frontend)`: 1 dashboard por visão (VN, VU, Oficina, Estoque).** Uma issue por visão, drill por marca/loja. *Depende de A1, C1.*

### D — Motor de alertas · `cap:alerts`
- **D1 `feat(db)`: tabela `kpi_target`.** *Depende de A1.*
- **D2 `feat(temporal)`: motor de alertas (<70% da meta).** Emite `finding` (`finding_type='kpi_alert'`); `POST /api/ops/alerts/trigger`. *Depende de A1, D1.*
- **D3 `feat`: seção "Alertas" no briefing e no dashboard do dono.** *Depende de B2, C2, D2.*

### E — BI conversacional (FastBI) · `cap:bi`
- **E1 `feat(temporal)`: agente de BI conversacional (PT-BR).** `bi_query_assistant.py`; `POST /api/ops/bi/ask`. *Depende de A1.*
- **E2 `feat(frontend)`: chat "Pergunte à DIA".** Rota `/dia/ask`. *Depende de C1, E1.*

### F — Ações pré-rascunhadas (AI Ladder 4.5) · `cap:actions`
- **F1 `feat`: ação pré-rascunhada com confirmação em 1 toque.** Reusa `follow_up_draft` + `POST /api/ops/findings/decision`. *Depende de B2/B3.*

## Primeira leva recomendada (caminho crítico)

**A1 → C1 → B1 → B2 → B3 → C2** — piloto que abre o portal, mostra a Visão do Dono com gráficos e roda o briefing configurável. Próximas levas: dashboards por visão (C3–C6), alertas (D1–D3), BI conversacional (E1–E2), ações (F1).

## Verificação

1. `gh issue list -R rodrigoreisdealernet/dealernet-agents` mostra as issues com labels corretas.
2. `supabase db reset` aplica A1; consultar `v_dia_owner_kpis` retorna dados mock.
3. Pipeline: `/ship-issue <n>` → revisar spec no gate → `--approved` → ler review do PR → merge.
4. Demo: `make up`, abrir `/dia/overview` e `/briefing`.
5. **Risco:** o script `.github/scripts/ship-issue-dashboard.mjs` não foi encontrado; usar `--dry-run` na 1ª issue para verificar se o `/ship-issue` degrada graciosamente.

## Follow-ups
- Salvar memória `feedback`/`project` com o fluxo acordado (pensar em issues; despachar via `/ship-issue`; dois gates humanos; visão DIA = briefing agêntico configurável por usuário + BI agêntico no portal).
