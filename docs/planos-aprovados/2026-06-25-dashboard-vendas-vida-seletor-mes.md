# Dar vida ao dashboard Vendas (VN/VU)

- **Data de aprovação:** 2026-06-25
- **Versão:** v0.1
- **Status:** Aprovado

## Context

A tela **Vendas (VN/VU)** (`frontend-portal/src/portal/renderers/screens/SalesDashboard.tsx`) é um dashboard read-only que lê as views `v_dia_sales_summary` / `v_dia_sales_trend`. Hoje tem três problemas:

1. **Sem seletor de mês.** O "mês atual" é apenas o último `period_month` detectado nos dados; não dá para navegar entre meses nem fica claro qual mês está em tela.
2. **Só existe 1 mês de dados.** No `supabase/seed.sql` os veículos vendidos não têm `sold_at`, então a view cai no fallback `valid_from = now()` (`supabase/migrations/20260625170000_dia_fast_bi_analytics.sql:58`) e tudo colapsa em 2026-06. Isso também gera o "Dias p/ vender = 292" irreal (compra espalhada 0–420 dias × venda sempre "hoje").
3. **Visual apagado.** Barras todas em uma cor só; KPIs monocromáticos.

Objetivo: navegar por mês com setas (◄ Junho/2026 ►), KPIs/barras/mix refletindo o mês escolhido (tendência mantém a série completa), cards de KPI coloridos, e **6 meses de histórico** real com dias-p/-vender plausíveis. Tudo dentro dos tokens do design system (CLAUDE.md do portal proíbe hardcode de cor).

## Decisões alinhadas com o usuário

- **Seletor de mês:** setas `◄ Mês ►` com o nome do mês entre elas.
- **Escopo:** KPIs + "Vendas por marca" + "Mix" seguem o mês selecionado; "Vendas ao longo do tempo" mostra a série completa.
- **Cores:** cards de KPI tonalizados + barra por marca colorida + mix colorido, todos via tokens do DS.
- **Dados:** 6 meses de histórico no seed, reaplicado no banco compartilhado via `docker exec`.

## Parte 1 — Frontend

### 1.1 Seletor de mês com setas — `SalesDashboard.tsx`
- Derivar `months` = `period_month` distintos de `filtered`, ordenados asc.
- Estado `selectedMonth`; default = último mês. Quando `months` muda e `selectedMonth` sai da lista, reposicionar para o último mês.
- Controle `◄ Mês ►` na faixa de filtros, com `aria-label` (prev/next) e label com `aria-live="polite"`; botões desabilitados nos extremos.
- KPIs: usar `selectedMonth` em vez de `currentMonth`.
- `byBrandData` e `mixData`: filtrar por `r.period_month === selectedMonth`.
- `trendData`: permanece série completa.

### 1.2 Formatador de mês — `format.ts`
- `formatMonthLabel(period)` → `'2026-06-01'` vira `'Junho/2026'` (pt-BR, inicial maiúscula).

### 1.3 Cards de KPI coloridos — `ui.tsx`
- Prop opcional `tone?: Tone` no `KpiCard` (tints via tokens). Sem `tone` mantém o atual.
- SalesDashboard: VN→`info`, VU→`success`, Total→`neutral`, Dias→`warning`; receitas/margem acompanham o grupo de cor das unidades.

### 1.4 Barra por marca colorida — `ChartCard.tsx`
- Prop opcional `colorByPoint?: boolean`: bar com série única renderiza `<Cell>` por ponto ciclando `DEFAULT_PALETTE`. Sem a prop, comportamento atual.

### 1.5 i18n — `pt-BR.json` / `en-US.json`
- `screens.salesDashboard`: `month`, `prevMonth`, `nextMonth` (espelhado nos dois locais).

## Parte 2 — Dados (seed + banco compartilhado)

### 2.1 Vendidos do mês atual — bloco fleet existente
- Para `v_status='vendido'`: `sold_at` no mês corrente e `purchase_date = sold_at - (25..65 dias)`. Não alterar `purchase_date` dos `em_estoque`.

### 2.2 Novo bloco histórico — `demo-dia-fleet-hist-%`
- Bloco `DO` idempotente (DELETE por namespace → recria), gerando vendidos nos 5 meses anteriores espalhados por lojas/marcas/condições, cada um com `sold_at` no mês e `purchase_date = sold_at - (25..65 dias)`.

### 2.3 Aplicar no banco compartilhado
- `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -v ON_ERROR_STOP=1`. Nunca `supabase db reset`.

## Verificação

1. `cd frontend-portal && npm run lint && npm run build`.
2. Aplicar blocos via `docker exec`; conferir `select period_month, condition, sum(units_sold) from v_dia_sales_summary group by 1,2 order by 1;` (6 meses) e `avg_days_to_sell` plausível.
3. Preview do Portal: setas trocam mês, KPIs/barras/mix por mês, tendência com 6 meses, KPIs tonalizados, barras coloridas; screenshot final.
