# Morning Brief Frontend: Rótulo do Período deve dizer ONTEM (dia anterior)

## Overview

O Morning Brief exibe dados do dia anterior (via issue #91), mas o frontend ainda rotula o período como "Mês Atual / Current month". Esta issue alinha o **rótulo frontend** ao conceito de **dia anterior** em mobile e desktop, atualizando a função `briefDateLabel()` e as chaves i18n (`currentMonth` → `previousDay`; `noMonthData` → `noPreviousDayData`) em PT-BR e EN-US.

## Problema / Contexto

A issue #91 reverteu as views do Morning Brief de mês-corrente (MTD) para o **dia anterior**. Os dados na API já retornam apenas transações de ontem. Porém o **frontend** (`MorningBrief.tsx`) ainda traz rótulos MTD, criando uma contradição visível: o cabeçalho diz "Mês Atual · Junho de 2026" enquanto os cards mostram dados de 25 de junho (dia anterior).

**Pontos no código:**
- `briefDateLabel()` (linha ~452–454) retorna `new Date().toLocaleDateString()` formatado como mês/ano — "Junho de 2026".
- Uso de `t('currentMonth')` (linha ~543, mobile; linha ~582, desktop) no período.
- Chaves i18n `currentMonth` e `noMonthData` (pt-BR.json e en-US.json) que precisam ser substituídas.

## Critérios de Aceite

- [ ] O cabeçalho do Morning Brief **mobile** exibe o rótulo do dia anterior (ex.: "Ontem · qui, 25 jun") em vez de "Mês Atual / Current month".
- [ ] O cabeçalho do Morning Brief **desktop** exibe o rótulo do dia anterior no mesmo formato.
- [ ] A função `briefDateLabel()` retorna a **data do dia anterior** formatada localmente (PT-BR: "qui, 25 jun"; EN-US: "Thu, Jun 25"), não mês/ano.
- [ ] O estado vazio (sem dados) diz "Sem vendas ontem" (PT-BR) / "No sales yesterday" (EN-US) em vez de "Sem dados do mês" / "No month data".
- [ ] As chaves i18n `currentMonth` e `noMonthData` são substituídas por `previousDay` e `noPreviousDayData` em ambos os idiomas (PT-BR e EN-US); nenhuma referência órfã remanescente a "mês".
- [ ] `npm run build` (tsc) passa; nenhum erro de tipo ou chave i18n faltante.

## Não-Goals

- Alterar a lógica ou janela de dados das views (já feita em #91).
- Mudar o conceito de "Resumo Matinal" / "Morning Brief" no título.
- Atualizar outras telas (dashboards de Vendas, etc.) que usem "mês corrente".

## Out-of-scope

- Internacionalização adicional (idiomas além de PT-BR e EN-US).
- Ajustes de estilo ou UX do cabeçalho.

---

**STATUS: DRAFT — Aguardando aprovação antes de qualquer escrita de código.**
