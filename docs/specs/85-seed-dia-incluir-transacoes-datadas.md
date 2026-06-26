# Spec #85: Seed DIA — Incluir Transações Datadas de ONTEM para o Morning Brief

## Overview

Ajustar o seed DIA (`supabase/seed.sql`) para garantir que, após um reset, o **Morning Brief do Dono mostre dados populados do dia anterior** (Novos, Usados, Peças e AT). Atualmente, veículos marcados como "vendido" não possuem `sold_at`, causando que a brief fallback para `updated_at` (data do seed = hoje), deixando o dashboard de ontem zerado. O fix é **puramente de dados no seed**: adicionar `sold_at`, `sale_date`, e `closed_at` relativos a `now()::date - 1` para um subconjunto representativo de transações, sem alterar código ou views.

## Problema / Contexto

O **Morning Brief do Dono** (#43) exibe o resultado do **dia anterior** calculado on-the-fly na view `v_dia_owner_brief_by_brand`:

```sql
coalesce(data->>'sold_at', updated_at, valid_from)::date = now()::date - 1
```

A tela funciona corretamente (navegação, ações, RLS), mas os setores **Novos/Usados/Peças/AT vêm R$ 0,00 / "—"** porque **o seed não semeia transações com datas de ontem**.

Detalhamento:

1. **Veículos vendidos ontem:** Na geração em massa (`supabase/seed.sql`, linhas ~161-188), veículos recebem `status = 'vendido'` quando `k % 7 = 0`, mas **nenhuma propriedade `sold_at` é populada** na jsonb. Sem `sold_at`, a view fallback para `updated_at` ou `valid_from` (ambos = data do seed = hoje), então nenhuma venda cai em "ontem" → brief do dia anterior fica vazia.

2. **Peças vendidas ontem:** A seção de `part_sale` (linhas ~646+) já possui um sistema de datas relativas (usando `mo` = month_offset e `day`), mas usa conceito "mês atual" (`date_trunc('month', now())`) em vez de "ontem".

3. **AT (oficina) ontem:** A seção `service_order` (linhas ~459+) semeia OS com status variado, mas apenas as com `turn_h IS NOT NULL` recebem `closed_at`. Nenhuma é datada de ontem.

Resultado prático: ao abrir a brief, só o **Floor Plan** (estoque, independente de data) aparece; o restante mostra "—". Antes havia seeding manual de veículos "vendidos ontem" (brief mostrou ~R$ 590k de resultado), mas o reseed apagou — precisa ser persistente.

## Critérios de Aceite

- [ ] **Novos e Usados não-nulos com `resultado > 0` ontem:** Após um seed do zero, `v_dia_owner_brief_by_brand` retorna linhas com `novos_units > 0` e/ou `usados_units > 0` e `resultado > 0` (receita - custo) para o dia anterior em **pelo menos 2 marcas**; o **Grupo Total** (`resultado` somado) é `> 0`.

- [ ] **Drill por loja consistente:** `v_dia_owner_brief_by_store` mostra as vendas de ontem distribuídas pelas lojas das marcas; totais por loja somam corretamente com o total da marca.

- [ ] **Peças e AT populam quando existem:** A coluna **Peças** (`pecas_value`) e **AT** (`at_value`) aparecem com valor `> 0` para ontem quando houver `part_sale` e/ou `service_order` concluída(s) no seed; caso contrário, permanecem `NULL` (renderizam "—") sem quebrar o layout.

- [ ] **Floor Plan não regride:** As colunas de `fp_value` e `fp_at_risk` (estoque em_estoque, `days_in_stock >= 83`) continuam populando como hoje, sem redução de unidades ou custo comparado ao seed anterior.

- [ ] **Datas relativas, não hard-coded:** Todos os `sold_at`, `sale_date`, `closed_at` são calculados usando `now()::date - 1` ou expressões relativas (p.ex. `(now() - interval '...')::date`), garantindo que o seed roda válido qualquer dia sem manutenção manual.

## Não-Goals

- Mudança no código do Morning Brief ou das views analíticas (`v_dia_owner_brief_by_brand`, `v_dia_owner_brief_by_store` ou `v_dia_sales_summary`) — a lógica de "ontem" já está correta.
- Snapshot diário / job agendado para "ontem" — o brief calcula on-the-fly.
- % de meta ou metas de vendas — apenas valores absolutos.
- Mudanças na forma ou estrutura do schema (`part_sale`, `service_order`, `vehicle`).

## Out-of-Scope

- Seed de volume adicional fora da área DIA (rental ou agentes).
- Validação de regras de negócio (ex.: `sale_price > cost`, coerência de datas abertas/fechadas) — o seed mantém valores realistas; testes unitários validam regras.
- UI responsiva ou comportamento do portal — foco é dados.

---

**STATUS: DRAFT — Aguardando aprovação antes de qualquer escrita de código.**
