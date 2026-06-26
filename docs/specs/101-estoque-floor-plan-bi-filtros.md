# Spec: Estoque & Floor Plan (BI) — Filtros Marca/Empresa, Gráfico por Marca, Coluna Única por Métrica

## Overview
Enhance the Vehicle Inventory & Floor Plan dashboard (`VehicleInventoryBI.tsx`) with reactive filters (Marca + Empresa), simplify the brand chart to group by brand only, and replace the dual-series visualization with a metric selector (Valor do estoque OR Floor plan) so each chart shows a single, legible column.

## Problem / Context
The current "Estoque de Veículos & Floor Plan (Fast BI)" dashboard has no filters, so the owner can't focus on a brand or company. The "por marca e loja" chart plots two series (Floor plan + Valor do estoque) at vastly different scales — floor plan becomes an unreadable sliver next to inventory value. The header KPIs come from a global `getOwnerKpis()` that doesn't react to anything. The proven pattern for inline reactive filters already exists in `SalesDashboard.tsx` (Marca/Loja dropdowns via `useState` + `distinct()` + `<select>`); this issue applies it here, groups the chart by brand only, and adds a metric selector that drives both charts. In this data model each empresa is a loja (the `store` field = company trade_name), so the "Empresa" filter operates on `store`.

## Acceptance Criteria

- [ ] **Filtros Marca + Empresa inline** abaixo do título; cada dropdown popula a partir dos valores distintos do summary (`brand`, `store`) com uma opção "Todas". Selecionar atualiza KPIs, gráficos e a tabela de veículos.
- [ ] **Gráfico agrupa só por marca** — o antes "por marca e loja" passa a agrupar apenas por `brand` (xKey `brand`, sem o sufixo de loja). As barras refletem a métrica escolhida.
- [ ] **Seletor de métrica inline** com os filtros — opções "Valor do estoque" e "Floor plan". Os **dois** gráficos (faixa de idade + por marca) passam a mostrar **uma única coluna** da métrica selecionada (não duas séries), usando `ChartCard` com 1 série e `colorByPoint` para cores distintas por barra.
- [ ] **KPIs reagem ao filtro** — os 4 KPIs do topo (Valor do estoque, Floor plan total, Dias médios, Parados +90) são recalculados a partir dos veículos filtrados (`getVehicles`, status `em_estoque`) conforme marca/empresa selecionadas, em vez do `getOwnerKpis()` global.
- [ ] **Moeda enxuta + legenda** — valores monetários (KPIs, tooltips, tabela) usam `formatBRLKpi()`; a tela mostra a legenda "Valores em R$". Sem casas decimais.
- [ ] **Paridade i18n pt-BR/en-US** — chaves novas presentes e idênticas nos dois arquivos (ex.: Empresa/Company, Todas as empresas, Métrica, rótulos das métricas, títulos de gráfico dinâmicos por métrica). `node --test scripts/verify-i18n-parity.mjs` verde.
- [ ] **Build/lint/testes verdes** — `npm run lint && npm run build` exit 0; `node --test scripts/*.mjs` passa, incluindo `verify-vehicle-inventory-bi.mjs` atualizado para o agrupamento só-por-marca e série única (sem duas séries). Tema claro/escuro estável.

## Non-Goals
- Mudanças de schema/migrations no backend (empresa segue mapeada a `store`; sem `empresa_id` separado).
- Redesenho de outros dashboards de BI.
- Export/download dos dados filtrados.
- Drill-down do gráfico por marca para detalhe por loja.

## Out-of-Scope
- Um filtro "Loja" separado de "Empresa" (a decisão fecha em Marca + Empresa).
- Comparação multi-métrica (manter as duas séries) — o seletor substitui as duas séries.
- Opções de filtro vindas do backend / cascata dependente (filtros derivam do summary no cliente).
