# Spec — Issue #17: feat(frontend) — Dashboard Oficina (Fast BI)

## Overview

Nova tela de dashboard "Oficina" na área **Insights / Fast BI** do `frontend-portal`, mostrando a situação das ordens de serviço (OS): volume por status, faturamento da oficina no mês e ao longo do tempo, tempo médio de atravessamento (turnaround) e as OS abertas mais antigas. É uma tela React nativa (`kind=component`) que reaproveita os primitivos `KpiCard`/`ScreenShell`/`Badge` e o widget `ChartCard` (#13).

## Problem / Context

O gestor da oficina não tem hoje uma visão consolidada da operação de serviços — só a tela CRUD de Ordens de Serviço (#7). Este dashboard responde "quanto trabalho está aberto, o que já faturei no mês e quão rápido estamos entregando" em uma única tela.

**Decisão de fonte de dados:** os KPIs e gráficos são derivados **no cliente** a partir de `getServiceOrders()` (view `v_dia_service_order_current`, dados reais e ricos: status, opened_at, closed_at, revenue, turnaround_hours). A view analítica `v_dia_service_summary` (#14) **não** é usada porque atualmente retorna 0 linhas (lê um `entity_type` JSON antecipado que não corresponde ao real). `ChartCard` é presentacional e recebe `data` já resolvido — a tela faz a agregação antes de passar para o widget.

## Acceptance Criteria

- [ ] **Tela existe e é um componente default.** O arquivo `frontend-portal/src/portal/renderers/screens/ServiceDashboard.tsx` existe e exporta um componente React como `export default`.
- [ ] **KPIs (5) com `KpiCard`.** A tela renderiza cinco indicadores derivados de `getServiceOrders()`: (1) OS abertas, (2) OS em andamento, (3) OS concluídas no mês, (4) faturamento do mês (formatado com `formatBRL`), (5) turnaround médio em horas. Os rótulos aparecem em pt-BR.
- [ ] **Gráfico 1 — OS por status.** A tela renderiza um `ChartCard` do tipo `pie` (ou `bar`) com a quebra de OS por status (aberta / em andamento / concluída / cancelada).
- [ ] **Gráfico 2 — Faturamento no tempo.** A tela renderiza um `ChartCard` do tipo `line` com faturamento da oficina por período (mês), usando `valueFormat='currency'`.
- [ ] **Lista de OS abertas mais antigas.** A tela exibe uma lista (atenção operacional) das OS com status `aberta` ordenadas da mais antiga para a mais recente por `opened_at`.
- [ ] **Registro no registry.** `frontend-portal/src/portal/renderers/registry.ts` mapeia o componentKey `dia-service-dashboard` para o import lazy de `ServiceDashboard` (distinto do já existente `dia-service-orders`).
- [ ] **Item de menu "Oficina".** `MOCK_MENU` em `frontend-portal/src/portal/lib/portalApi.ts` ganha, dentro do grupo `insights` (text "Insights"), um item de texto **"Oficina"** cujo `spec.componentKey` é `dia-service-dashboard`.
- [ ] **Validação com seeds.** Com os dados/seed atuais, os KPIs e os gráficos refletem as OS mock (contagens por status, faturamento e turnaround batem com `getServiceOrders()`).

## Non-Goals

- Produtividade/agendamento por técnico em detalhe (apenas o turnaround médio agregado entra).
- Nenhuma nova view de banco, migration ou alteração de `v_dia_service_summary` — a tela é **frontend-only** e agrega no cliente.
- Não criar um componente `StatCard` novo — reutiliza-se `KpiCard` (não existe StatCard no projeto).

## Out-of-Scope

- CRUD de ordens de serviço (já entregue em #7, tela `dia-service-orders`).
- Corrigir/popular `v_dia_service_summary` (#14) para que volte a retornar linhas — fica para um issue de backend separado.
- Filtros avançados (por loja, técnico, intervalo de datas customizado) e exportação.
