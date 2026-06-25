# Spec — Issue #15: feat(frontend) — Dashboard "Visão do Dono" (Fast BI)

## Overview
Adicionar uma nova tela de dashboard "Visão do Dono" (Fast BI) ao Portal DMS,
composta por uma banda de KpiCards e ao menos dois ChartCards alimentados pelas
views analíticas criadas na issue #14/#13. É um trabalho FRONTEND-ONLY: nenhuma
migração de banco é criada aqui — as views já existem em
`supabase/migrations/20260625170000_dia_fast_bi_analytics.sql`.

## Problem / Context
Hoje o Portal tem telas operacionais (estoque, oficina, peças, findings) e um
"Executive Pack" focado em recuperação de receita pela IA, mas não há uma visão
consolidada de negócio para o dono da concessionária (vendas, margem, oficina,
estoque de veículos, floor plan e peças) num só lugar. O widget `ChartCard` (#13)
e as views analíticas (#14) já existem, mas ninguém os consome ainda. Esta tela
fecha essa lacuna entregando um painel "Fast BI" de leitura rápida.

Aterramento no código (ground truth):
- Telas nativas vivem em `frontend-portal/src/portal/renderers/screens/` e seguem o
  padrão de `ExecutivePack.tsx` / `AgentsDashboard.tsx` (componentes React,
  `kind=component`), usando `ScreenShell` + `KpiCard` de `./ui`, `formatBRL`/`formatPct`
  de `./format`, e `ChartCard` de `./ChartCard`.
- Registro de telas: `frontend-portal/src/portal/renderers/registry.ts`
  (`componentKey -> componente lazy`).
- Menu de navegação: `MOCK_MENU` em `frontend-portal/src/portal/lib/portalApi.ts`.
- Acesso a dados: helpers em `frontend-portal/src/portal/lib/agentsApi.ts`, que leem
  views via `supabase.from(view).select(cols)`.
- Views analíticas (nomes/colunas exatos):
  - `v_dia_owner_kpis` (linha única): `as_of, sales_units_month, sales_revenue_month,
    margin_month, service_orders_open, service_revenue_month, service_avg_turnaround,
    inventory_vehicle_value, floor_plan_total, avg_days_in_stock, parts_inventory_value,
    parts_critical_count`.
  - `v_dia_sales_trend`: `sale_date, units_sold, revenue` (90 dias, diário).
  - `v_dia_inventory_summary`: `age_band ('0-30'|'31-60'|'61-90'|'90+'), brand, store,
    vehicles_count, inventory_value, floor_plan_cost`.

(Observação: o corpo da issue cita caminhos `frontend/src/...` e arquivos JSON de
página/`nav-config.ts` que NÃO existem neste repositório — foram desconsiderados.)

## Acceptance Criteria
- [ ] Existe uma nova tela "Visão do Dono" registrada com `componentKey`
      **`dia-overview`** em `registry.ts`, e ela abre sem erros no Portal.
- [ ] A tela exibe uma banda de KpiCards lendo `v_dia_owner_kpis` com, no mínimo:
      vendas do mês (unidades + R$), margem do mês, OS abertas, faturamento de
      oficina, valor de estoque de veículos, floor plan total, valor de estoque de
      peças e contagem de peças críticas — valores monetários formatados em R$ e
      percentuais como percentual.
- [ ] A tela exibe ao menos 2 gráficos via `ChartCard`: (a) um gráfico de linha
      "Tendência de vendas" a partir de `v_dia_sales_trend` (eixo X `sale_date`,
      séries `revenue` e `units_sold`); e (b) um gráfico de barras "Estoque por
      faixa de idade" a partir de `v_dia_inventory_summary` (eixo X `age_band`,
      série `vehicles_count` ou `inventory_value`).
- [ ] Existe um item de menu "Visão do Dono" sob uma seção "Fast BI" em `MOCK_MENU`
      apontando para `componentKey` `dia-overview`.
- [ ] A tela trata estados de carregamento/vazio e de erro (espelhando os padrões de
      `ExecutivePack`/`AgentsDashboard`): em erro, mostra mensagem; sem dados, os
      cards/gráficos mostram placeholder em vez de quebrar.
- [ ] Os dados são lidos por novos helpers em `agentsApi.ts`
      (`getOwnerKpis`, `getSalesTrend`, `getInventorySummary`), cada um usando
      `.select` com as colunas exatas das respectivas views.
- [ ] As verificações estáticas do repositório passam (typecheck/lint/build e o
      verificador estrutural no estilo do repo).

## Non-Goals
- Dashboards de drill-down (clicar num KPI/gráfico para abrir detalhamento).
- Seção de alertas/insights proativos na tela.
- Filtros interativos (por loja, marca, período) na primeira versão.
- Qualquer migração de banco ou alteração nas views analíticas.

## Out-of-Scope
- Issues irmãs de Fast BI (#16–#18) e quaisquer outras telas de dashboard.
- Endpoints `/api/v1/portal/*` reais (o menu continua via `MOCK_MENU`).
- Exportação (PDF/Excel) ou agendamento de relatórios.
- Internacionalização além do pt-BR já em uso.

## File Touch-List
- `frontend-portal/src/portal/renderers/screens/DiaOverview.tsx` — nova tela
  "Visão do Dono" (novo arquivo).
- `frontend-portal/src/portal/renderers/registry.ts` — registrar
  `'dia-overview' -> lazy import` da nova tela.
- `frontend-portal/src/portal/lib/agentsApi.ts` — novos tipos + helpers
  `getOwnerKpis`, `getSalesTrend`, `getInventorySummary` (leitura por `.select`).
- `frontend-portal/src/portal/lib/portalApi.ts` — adicionar seção "Fast BI" com o
  item "Visão do Dono" em `MOCK_MENU`.

Reutilizados (sem alteração): `ChartCard` de
`frontend-portal/src/portal/renderers/screens/ChartCard.tsx`; `KpiCard`/`ScreenShell`
de `frontend-portal/src/portal/renderers/screens/ui`; `formatBRL`/`formatPct` de
`frontend-portal/src/portal/renderers/screens/format`.
