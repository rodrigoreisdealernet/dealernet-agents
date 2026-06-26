# Spec — Issue #91: Morning Brief — voltar a janela de MÊS CORRENTE (MTD) para DIA ANTERIOR

> **STATUS: DRAFT** — aguarda aprovação humana (gate #1 do /ship-issue) antes de qualquer código.

## Overview

O Morning Brief do Dono, que agregava o **dia anterior** desde sua criação (issue #43), foi migrado para **mês-a-data (MTD)** na migration `20260627120000_dia_owner_brief_month_to_date.sql` — porque o seed distribuído por vários meses deixava a tela vazia. Essa mesma migration corrigiu defeitos do setor Peças e conectou o AT/Oficina. A decisão do produto é reverter **apenas a janela temporal** de volta ao **dia anterior** (`now()::date - 1`), preservando integralmente as correções de Peças/AT que vieram junto no MTD. O motivo original da mudança (tela vazia) já foi resolvido pela issue #85, que semeia transações datadas de ontem.

## Problem / Context

- **Origem:** O Morning Brief (#43) agregava o dia anterior (`now()::date - 1`) e mostrava métricas de "como fechou ontem" — alinhado à mensagem matinal para o dono.
- **Desvio (MTD):** A migration `20260627120000_dia_owner_brief_month_to_date.sql` (PR #59) trocou a janela para mês corrente (1º dia → agora) porque o seed histórico (distribuído ao longo de meses) deixava a tela quase vazia — não havia transações relativamente recentes.
- **Correções que vieram junto (e devem ser preservadas):**
  - **Peças:** lê `entity_type = 'part_sale'` (singular), filtra por `sale_date` (não `sold_at`), calcula valor como `quantity*unit_price - coalesce(discount,0)` (total não é persistido), exclui vendas `cancelada`.
  - **AT/Oficina:** soma `revenue` das OS abertas no período, exclui `status = 'cancelada'`.
- **Resolução do vazio (issue #85):** Seed agora popula transações com `sale_date` / `opened_at` relativamente recentes (ontem/hoje), eliminando o motivo para MTD.
- **Decisão:** Reverter para dia anterior, mantendo intactas as correções de Peças/AT e o conceito FP "as of now".

## Acceptance Criteria

- [ ] As views `v_dia_owner_brief_by_brand` e `v_dia_owner_brief_by_store` agregam Novos, Usados, Peças e AT **somente do dia anterior** (`now()::date - 1`) — uma venda de anteontem, de semana passada ou do mês anterior não contam; uma venda de ontem conta.
- [ ] As correções de **Peças** (`entity_type 'part_sale'`, `sale_date`, total calculado `quantity*unit_price - coalesce(discount,0)`, exclui `cancelada`) e de **AT** (revenue das OS, exclui `cancelada`) funcionam conforme implementado no MTD — sem regressão ao bug original.
- [ ] **Floor Plan / FP em risco <7d** permanecem "as of now" (estoque atual, sem filtro temporal).
- [ ] O **shape de colunas** das duas views (brand_name, brand_id, store_name/store_count, novos_units/value/margin, usados_units/value/margin, pecas_value/margin, at_value/margin, fp_units/value/at_risk) é **idêntico** ao estado MTD; `security_invoker=true` mantido; helper `dia_owner_brief_at_risk_days()` inalterado (= 83).
- [ ] Com o seed atual (issue #85, transações datadas de ontem), o brief mostra **resultado > 0 do dia anterior** em ≥2 marcas (tela não fica vazia) — validável via `SELECT * FROM v_dia_owner_brief_by_brand ORDER BY resultado DESC;`
- [ ] `v_dia_owner_brief_by_store` continua **consistente** com `by_brand` para o dia anterior (soma das lojas de uma marca = resultado da marca).

## Non-Goals

- Mudança no frontend do Morning Brief (a tela, os deeplinks, o layout e a UI não mudam — alteração é exclusivamente na janela das views).
- Reverter ou remover as correções de Peças/AT (devem ser preservadas).
- Snapshot diário, % de meta ou alertas estruturais.

## Out-of-scope

- Seed ou população de dados (issue #85 já resolveu).
- Refatoração de outras views analíticas (DIA).
- Mudança no helper de risco (`dia_owner_brief_at_risk_days()`) ou na lógica de FP.

## Validação sugerida (apêndice)

```sql
-- Conferir que a janela é dia anterior (ontem) e mostra resultado > 0 em múltiplas marcas:
SELECT 
  brand_name, 
  novos_units, usados_units, pecas_value, at_value, 
  resultado, fp_units, fp_units_at_risk 
FROM v_dia_owner_brief_by_brand 
ORDER BY resultado DESC;

-- Conferir que uma venda de anteontem (ex.: now()::date - 2) não entra:
-- (após inserir manualmente um veículo vendido em now()::date - 2, a query acima não deve contar)

-- Conferir que by_store soma corretamente para by_brand:
SELECT brand_name, SUM(novos_units + usados_units) as total_units 
FROM v_dia_owner_brief_by_store 
GROUP BY brand_name 
UNION ALL 
SELECT brand_name, novos_units + usados_units 
FROM v_dia_owner_brief_by_brand;
-- (coluna nova = coluna MTD para cada marca)
```
