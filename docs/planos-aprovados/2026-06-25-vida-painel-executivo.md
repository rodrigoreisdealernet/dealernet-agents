# Dar "mais vida" ao Painel Executivo — Dono (Tier B)

- **Data de aprovação:** 2026-06-25
- **Versão:** v0.1
- **Status:** Aprovado

## Context
Os dashboards do Portal DIA estão visualmente "chapados": grades de KPI em texto, sem
tendência, cor semântica, gráficos ou drill-down. O dono pediu para ajustar **cada**
dashboard começando pelo **Painel Executivo — Dono** (`ExecutivePack`), que hoje é o mais
mínimo: 6 `KpiCard` puros vindos de `getHomeKpis()` + `getFindingKpis()`.

O objetivo é dar vida ao painel **usando apenas dados que já existem** (sem backend novo) —
há várias funções em `agentsApi.ts` com dados ricos ainda não usados nesta tela. Decisão do
dono: entregar o **Tier B completo** (polish + gráficos + alertas + breakdown por agente +
micro-animações) e, ao fechar o plano, **abrir a issue e implementar via `/ship-issue`**.

Esta é a primeira de uma série (uma issue por dashboard); os 4 primitivos compartilhados
criados aqui (`TrendBadge`, `Sparkline`, `ProgressBar`, `KpiCard` com acento) são o retorno
reutilizável para os próximos.

## Restrições / fatos que travam o desenho
- **Sem backend novo.** Só funções já expostas em `frontend-portal/src/portal/lib/agentsApi.ts`.
- **Navegação é via store, não router**: `usePortalStore().openWindow({ kind:'component', componentKey, title, params })`. Molde em `FindingsQueue.tsx` (drill p/ `finding-detail` com `params.findingId`; drill p/ `findings-queue` com `params.agentKey`).
- **`ChartCard`** só faz `line | bar | pie` (sem area/donut/sparkline). Props: `{title, type, data, xKey, series[], valueFormat, height, emptyMessage}`. Wiring de referência pronto em `DiaOverview.tsx` com `getSalesTrend()`.
- **i18n com paridade obrigatória** (`scripts/verify-i18n-parity.mjs`): toda chave nova entra em `pt-BR.json` **e** `en-US.json`, mesma árvore, sem folhas vazias.
- **Moeda enxuta** já é padrão (issue #54/#59): KPIs usam `formatBRLKpi` + legenda "Valores em R$". Manter.
- **Cuidado de agregação** (lição do MorningBrief): em `v_dia_owner_brief_by_brand`, `fp_units_at_risk`/`fp_value_at_risk` são somáveis por marca; `pecas_value`/`at_value` são group-wide (repetidos) — **não somar**.
- `framer-motion` 11 já instalado/usado no shell; base CSS já respeita `prefers-reduced-motion`. Tokens semânticos (`--success/-tint`, `--warning`, `--danger`, `--info`) + motion (`--dur-base`/`--ease`) prontos.

## Abordagem — novo layout do ExecutivePack (Tier B)
Manter `ScreenShell` (title/subtitle/legend) e adicionar estado `loading`; carregar tudo num
único `Promise.all([...].catch(()=>null))`.

**Seção A — Hero KPIs com vida** (grid 2→3 col, `KpiCard` com acento):

| Card | Dado | Função |
|---|---|---|
| Receita do período + **Sparkline 90d** + **TrendBadge** ▲/▼% (verde/vermelho) | `period_revenue` vs `prior_period_revenue`; série `revenue` por `sale_date` | `getHomeKpis` + `getSalesTrend` |
| Recuperável (IA) + hint pendentes | `recoverable_delta`, `pending_count` | `getFindingKpis` |
| Aprovados no ciclo | `approved_this_cycle` | `getFindingKpis` |
| Negócios ativos | `assets_on_rent` | `getHomeKpis` |
| Utilização da capacidade + **ProgressBar** (verde<60 / âmbar 60–85 / vermelho>85) | `fleet_utilization_pct` | `getHomeKpis` |
| Ações atrasadas (accent `danger` se >0) | `overdue_returns_count` | `getHomeKpis` |

**Seção B — Linha de gráficos** (`lg:grid-cols-2`, reusa `ChartCard`):
- Tendência de receita 90d: `line`, `xKey="sale_date"`, série `revenue` (currency) + `units_sold` (number) — `getSalesTrend`.
- Resultado por marca: `bar`, `xKey="brand_name"`, série `resultado` (currency) — `getOwnerBriefByBrand`.

**Seção C — "O que a IA encontrou"** (top findings preview → drill):
Lista compacta dos maiores Δ (`getFindings({ limit: 6 })`, já ordenado por delta desc).
Cada linha: `customer_name ?? contract_label ?? line_item_label`, `Badge severityTone(severity)`,
`Δ formatBRLKpi(delta)`, `Badge statusTone(status)`. Linha inteira clicável →
`openWindow({ componentKey:'finding-detail', params:{ findingId: f.id } })`.

**Seção D — Faixa de alertas "em risco"** (aparece só com risco; estilo `border-destructive/30 bg-destructive/10`):
- "Floor plan em risco: N un · R$ X" — Σ `fp_units_at_risk`, Σ `fp_value_at_risk` (`getOwnerBriefByBrand`).
- "Peças críticas: N" — `parts_critical_count` (`getOwnerKpis`).

**Breakdown por agente** (mini-lista): `getAgentStatus()` → `agent_key`, `identified_delta`,
`pending_findings`, saúde (`succeeded_runs`/`failed_runs`); linha → drill `findings-queue` com `params.agentKey`.

**Micro-animações** (framer-motion): fade/translate-y dos cards na montagem; hover lift na lista
de findings; durações curtas via `--dur-base`, confiando no `prefers-reduced-motion`.

## Primitivos compartilhados a adicionar em `ui.tsx` (payoff reutilizável)
Mínimos, token-driven, presentacionais — retrocompatíveis (props novas opcionais):
1. **`TrendBadge`** `{ delta, format?:'pct'|'currency'|'number' }` — ▲/▼ + valor; cor success/danger/neutro. Substitui o ternário inline atual (ExecutivePack ~L42-46).
2. **`Sparkline`** `{ data:number[], tone?, width?, height? }` — SVG `<polyline>` puro (não puxa recharts), cabe dentro do `KpiCard`.
3. **`ProgressBar`** `{ value /*0..100*/, tone? }` — tom automático por faixa; trilho `bg-muted`, transição `--dur-base var(--ease)`.
4. **`KpiCard` estendido** — add `accent?:'neutral'|'success'|'warning'|'danger'|'info'` (borda/tint à esquerda) + slots `trend?:ReactNode` e `sparkline?:ReactNode`. Não quebra os ~6 dashboards que já usam `KpiCard`.

## Arquivos a tocar
- `frontend-portal/src/portal/renderers/screens/ui.tsx` — novos primitivos + extensão do `KpiCard`.
- `frontend-portal/src/portal/renderers/screens/ExecutivePack.tsx` — reescrita do corpo.
- `frontend-portal/src/i18n/messages/pt-BR.json` e `en-US.json` — chaves novas sob `screens.executivePack` (mesma árvore nos dois).
- (opcional) `frontend-portal/scripts/verify-executive-pack.mjs` — novo verify (molde `verify-issue43-wiring.mjs`).

## Verificação
1. `cd frontend-portal && npm run build` (`tsc -b && vite build`) — gate de tipo.
2. `npm run lint` — sem erros novos.
3. `node --test scripts/verify-i18n-parity.mjs`, `scripts/verify-kpi-format.mjs`, `scripts/verify-chartcard.mjs`, e a suíte `node --test scripts/*.mjs`.
4. Novo `verify-executive-pack.mjs`: assertar chamadas `getSalesTrend`/`getFindings`, o drill `openWindow({...componentKey:'finding-detail'...})` e os exports `TrendBadge`/`Sparkline`/`ProgressBar` em `ui.tsx`.
5. Eyeball: `npm run dev` → http://localhost:5174, abrir "Painel Executivo — Dono" (`executive-pack`); testar tema claro/escuro e reduced-motion.

## Sequenciamento da entrega
1. Primitivos em `ui.tsx` (`TrendBadge` → `ProgressBar` → `Sparkline` → `KpiCard` accent).
2. ExecutivePack Tier A (hero + Seção C drill) → build + i18n parity.
3. ExecutivePack Tier B (charts row, at-risk strip, per-agent, micro-anim) → build + verify.

## Próximo passo
1. Abrir a **issue** "Dar vida ao Painel Executivo — Dono (Tier B)".
2. Rodar **`/ship-issue <n> --approved`**, parando no gate de merge.
