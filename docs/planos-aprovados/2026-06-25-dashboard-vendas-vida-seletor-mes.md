# Dar vida ao dashboard Vendas (VN/VU)

- **Data de aprovação:** 2026-06-25
- **Versão:** v0.2
- **Status:** Aprovado

## Context

A tela **Vendas (VN/VU)** (`frontend-portal/src/portal/renderers/screens/SalesDashboard.tsx`) é um dashboard read-only que lê as views `v_dia_sales_summary` / `v_dia_sales_trend`. Objetivos:

1. **Seletor de mês** com setas (◄ Junho/2026 ►), KPIs/barras/mix refletindo o mês escolhido; a tendência mantém a série completa.
2. **Dar vida (cores)**: KPI cards com realce semântico e barra por marca colorida — tudo via tokens do design system.
3. **Dados por período** com dias-p/-vender plausíveis.

> Nota (v0.2): durante a execução, um `git pull` trouxe do remoto (#78 Painel Executivo e #86 histórico de vendas do ano) duas bases novas que cobrem parte do plano:
> - `ui.tsx` já expõe `KpiCard` com prop **`accent`** (realce borda+tinta) — usamos isso em vez de criar `tone`.
> - `seed.sql` já gera **12 meses** de vendas dinâmicas com `sold_at` e `purchase_date` realistas — a Parte 2 original (criar histórico no seed) foi descartada em favor do seed do remoto.

## Frontend

- **Seletor de mês** `◄ Mês ►` na faixa de filtros (botões com `aria-label`, label com `aria-live`, desabilitados nos extremos). Estado `selectedMonth` (default = último mês; reposiciona quando o recorte muda). `formatMonthLabel(period, locale)` em `format.ts` acompanha o idioma ativo (`useLocale`).
- **Escopo por mês**: KPIs + "Vendas por marca" + "Mix" filtram por `selectedMonth`; "Vendas ao longo do tempo" mantém a série completa.
- **Cores**: KPI cards com `accent` (VN→info, VU→success, Total→neutral, Dias→warning; receitas/margem acompanham). Barra por marca com nova prop **`colorByPoint`** no `ChartCard` (renderiza `<Cell>` por ponto ciclando `DEFAULT_PALETTE`). Mix (pie) já é colorido por fatia.
- **i18n**: chaves `month`/`prevMonth`/`nextMonth` em `pt-BR.json` e `en-US.json`.

## Dados

- Seed de histórico provido pelo remoto (#86). Reaplicar o bloco `demo-dia-fleet-%` no banco compartilhado via `docker exec -i supabase_db_dealernet-agents psql ...` (nunca `supabase db reset`).

## Verificação

1. `cd frontend-portal && npm run lint && npm run build`.
2. `select period_month, condition, sum(units_sold) from v_dia_sales_summary group by 1,2 order by 1;` → vários meses; `avg_days_to_sell` plausível.
3. Preview: setas trocam mês; KPIs/barras/mix por mês; tendência completa; KPIs com realce; barras por marca coloridas; screenshot final.
