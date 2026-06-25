# Spec — Issue #13: widget ChartCard (recharts) no UIEngine

## Overview

Adicionar um widget de gráfico reutilizável (`ChartCard`) construído sobre `recharts` aos primitivos visuais do Portal DMS, suportando os tipos `line`, `bar` e `pie`. Ele será a base para os dashboards de "Fast BI" (issues #15-#18 dependem dele). É um widget **presentacional** (recebe dados já carregados via props), não uma tela completa — os dashboards o compõem dentro das próprias telas.

## Problem / Context

Hoje o Portal DMS tem primitivos visuais simples (`KpiCard`, `Badge`, `ScreenShell` em `frontend-portal/src/portal/renderers/screens/ui.tsx`) e formatadores pt-BR (`formatBRL`, `formatPct` em `frontend-portal/src/portal/renderers/screens/format.ts`), mas **não há nenhuma primitiva de gráfico** e `recharts` não está nas dependências. Sem isso, qualquer dashboard precisaria reimplementar visualização do zero. Este widget padroniza a apresentação de séries (linha/barra/pizza), respeita os tokens de tema Tailwind do Portal (foreground, muted-foreground, border, card, primary, etc.) e oferece um estado vazio coerente, destravando os épicos de BI seguintes.

> **NOTA DE DESVIO** — O corpo da issue cita `frontend/src/components/engine/data/`, `frontend/src/registry/index.ts` e páginas JSON. Esses caminhos **não existem** (app `frontend/` foi removida pela migration de prune). A arquitetura real é `frontend-portal/` (React 18 + Vite + Tailwind v4); a "UIEngine" é o registry de componentes em `frontend-portal/src/portal/renderers/registry.ts`, e os widgets visuais ficam em `frontend-portal/src/portal/renderers/screens/`. O `ChartCard` é colocado junto dos demais primitivos como `frontend-portal/src/portal/renderers/screens/ChartCard.tsx`. Esta é uma entrega **frontend-only** (sem banco de dados).

## Acceptance Criteria

- [ ] **Componente existe** — `frontend-portal/src/portal/renderers/screens/ChartCard.tsx` exporta um componente React `ChartCard` que aceita as props: `title` (string), `type` (`'line' | 'bar' | 'pie'`), `data` (array de objetos), `xKey` (string), `series` (array de definições com `key`, `label`, `color?`, `format?`), `valueFormat?` (formatador opcional dos valores do eixo/tooltip, suportando `currency` e `percent`) e configuração de estado vazio. Os tipos de props são declarados e exportados.
- [ ] **Três tipos de gráfico** — Para `type='line'`, `type='bar'` e `type='pie'`, o widget renderiza o gráfico correspondente do `recharts` (`LineChart`/`BarChart`/`PieChart`) usando `xKey` como eixo de categorias e desenhando uma série por item de `series`.
- [ ] **Responsivo** — O gráfico é envolvido por um `ResponsiveContainer` do `recharts` com largura 100%, ajustando-se ao contêiner do dashboard sem largura fixa em pixels.
- [ ] **Formatação de valores** — Quando `valueFormat='currency'`, os valores exibidos (eixo/tooltip/rótulos) usam formatação em R$ (reaproveitando `formatBRL` de `format.ts`); quando `valueFormat='percent'`, usam formatação percentual (reaproveitando `formatPct`). Sem `valueFormat`, exibe o número cru.
- [ ] **Estado vazio** — Quando `data` é vazio (ou ausente), o widget exibe uma mensagem de estado vazio legível (texto em `text-muted-foreground`) dentro do card, em vez de um gráfico em branco ou erro.
- [ ] **Tema e moldura** — O widget renderiza dentro de uma moldura de card consistente com os primitivos existentes (`rounded-lg border border-border bg-card`), com o `title` visível, e usa exclusivamente tokens de tema do Portal (foreground, muted-foreground, border, card, primary) — sem cores hard-coded fora dos tokens.
- [ ] **Dependência registrada** — `recharts` é adicionado às `dependencies` de `frontend-portal/package.json`.
- [ ] **Teste do harness existente** — Um teste roda no harness atual do repo (`node --test` sobre `.mjs` em `frontend-portal/scripts/`, padrão de `verify-vehicle-wiring.mjs`) verificando ao menos: existência de `ChartCard.tsx`, presença de `recharts` em `package.json`, e suporte aos três tipos. Um teste de componente leve runnable é permitido, mas **não** se exige introduzir vitest se ele não existir no repo.

## Non-Goals

- Não carregar dados de uma `dataSource`/API dentro do `ChartCard`: ele é presentacional e recebe `data` já resolvido via props.
- Não criar uma tela de dashboard nem registrá-la no `componentRegistry`/menu (isso é das issues #15-#18).
- Não introduzir um motor de páginas JSON nem reativar a app `frontend/` legada.
- Não tocar em banco de dados, migrations, RPCs, RLS ou views.
- Não adicionar um framework de testes novo (ex.: vitest) se não fizer parte do repo hoje.

## Out-of-Scope

- Os dashboards de Fast BI que consomem o `ChartCard` (issues #15-#18).
- Tipos de gráfico além de `line`/`bar`/`pie` (ex.: area, scatter, stacked, combo).
- Interatividade avançada: drill-down, brush/zoom, export de imagem, legendas clicáveis com toggle de série.
- Tematização de dark/light mode além dos tokens já fornecidos pela bridge do Portal.
