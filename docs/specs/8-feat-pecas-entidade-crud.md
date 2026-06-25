# Spec — Issue #8: Peças — entidade + CRUD

> **STATUS: APROVADA (auto-aprovação batch /ship-issue)**

## Overview

Criar a entidade `part` (peça) com CRUD completo e estado de estoque crítico (migration + RPCs endurecidas + RLS + views + tela nativa no portal + seed) sobre o mesmo modelo genérico SCD2 (`entities` + `entity_versions` JSONB) já validado por Veículo (#4). Entrega a base de leitura corrente reutilizável que a Venda de Peças (#10) e o Alerta de reposição (issue D) vão consumir.

## Problem / Context

Segunda entidade do domínio de concessionária. O piloto DIA precisa cadastrar e gerir o estoque de peças, e — diferente de Veículo — derivar um **estado de estoque** (zerado/crítico/baixo/ok) e um **valor de estoque** para destacar peças que precisam de reposição. O caminho de escrita endurecido e a view `security_invoker` já existem para `vehicle` (migration `20260625130000_dia_vehicle_entity_crud.sql`); esta fatia replica esse padrão para `part` e adiciona uma view secundária de criticidade. Como #10 (Venda de Peças) depende da entidade e da view corrente de peças, a modelagem deve ser limpa e reutilizável.

### Decisão de modelagem (RECOMENDAÇÃO para o coder)

**Entidade dedicada `entity_type = 'part'`** no modelo genérico (`entities` + `entity_versions` JSONB), seguindo exatamente o padrão de `vehicle`, **e NÃO reusar `stock_item` (kind=`part`)**. Justificativa:

1. **`stock_item` foi podado do schema vivo.** A migration `20260625120000_dia_core_prune_wynne_domain.sql` removeu o RPC `create_stock_item`; a quantidade vivia em `time_series_points` (eventos), não em campo escalar. Peças aqui precisam de `quantity_in_stock`/`min_stock`/`reorder_point` como campos diretos consultáveis, com derivação simples de `stock_status` em view — o que casa com o padrão JSONB+view de `vehicle`, não com o fluxo de eventos do antigo `stock_item`.
2. **Paridade e reuso.** Uma entidade dedicada dá RPCs próprias (`create_part`/`update_part`/`delete_part`), enum de status próprio e uma view `v_dia_part_current` autocontida — exatamente o contrato estável que #10 consegue consumir.
3. **Consistência com #4.** O coder copia o esqueleto de `vehicle`, reduzindo risco.

### Precedência do `stock_status`

Regra normativa, da maior para a menor severidade (primeira condição satisfeita vence):

1. `zerado` — `quantity_in_stock = 0`
2. `critico` — `quantity_in_stock <= min_stock` (e > 0)
3. `baixo` — `quantity_in_stock <= reorder_point` (e > min_stock)
4. `ok` — acima de `reorder_point`

Pressuposto de dado consistente: `min_stock <= reorder_point`.

## Acceptance Criteria

- [ ] **Migration** nova (`supabase/migrations/<novo timestamp>_dia_part_entity_crud.sql`) registra o `entity_type` `part` no catálogo vivo (`rental_entity_type_catalog`) e define três RPCs endurecidas — `create_part`, `update_part`, `delete_part` (delete = soft-delete/inativar, sem DELETE físico) — espelhando `vehicle`: `SECURITY DEFINER`, `set search_path = public, pg_temp`, guarda de role (`service_role` OU `authenticated` + `get_my_role() IN ('admin','branch_manager')`, com `errcode='42501'`), e `GRANT EXECUTE` para `authenticated, service_role`. Escrita direta do cliente permanece bloqueada.
- [ ] **Campos** em `entity_versions.data`: `part_number`, `description`, `manufacturer`, `unit_cost` (numeric), `unit_price` (numeric), `quantity_in_stock` (numeric), `min_stock` (numeric), `reorder_point` (numeric), `location`, `status` (`ativo`|`inativo`). `part_number` e `description` são obrigatórios; `create_part` rejeita `status` fora do enum.
- [ ] **RLS**: leitura para `authenticated` via views `security_invoker`; escrita apenas via RPC (sem INSERT/UPDATE direto), respeitando roles (`admin`/`branch_manager` escrevem; `read_only` recebe erro `42501`).
- [ ] **View `v_dia_part_current`** (`security_invoker = true`): peças correntes não inativadas com todos os campos acima MAIS derivados `stock_value` (`quantity_in_stock × unit_cost`) e `stock_status`. `GRANT SELECT` para `authenticated, service_role`.
- [ ] **View `v_dia_parts_critical`** (`security_invoker = true`): apenas peças com `stock_status IN ('baixo','critico','zerado')`, ordenadas por criticidade (zerado → critico → baixo) e depois por `part_number`. `GRANT SELECT` para `authenticated, service_role`.
- [ ] **Tela `dia-parts`** (portal nativo): nova tela em `frontend-portal/src/portal/renderers/screens/` registrada sob a chave `dia-parts` em `registry.ts` e exposta no menu via `portalApi.ts` (seção DIA). Lê de `v_dia_part_current` via helper em `agentsApi.ts`; lista `quantity_in_stock`, `unit_price` e `stock_value`, e **destaca** `stock_status` com badge (crítico/zerado em destaque). Permite **criar/editar/inativar** via os RPCs.
- [ ] **Seed** (`supabase/seed.sql`): ~15 peças demo idempotentes (`source_record_id LIKE 'demo-dia-part-%'`), reusando `rental_upsert_entity_current_state('part', ...)`, com pelo menos uma peça em cada `stock_status` (incluindo `critico` e `zerado`).
- [ ] **Validação**: aplicando migration + seed, `v_dia_part_current` retorna ~15 linhas com `stock_value` correto e cada `stock_status` representado; `v_dia_parts_critical` retorna apenas linhas em `baixo/critico/zerado` na ordem de criticidade; criar/editar/inativar pela tela reflete no banco; `read_only` não escreve (erro `42501`).

## Non-Goals

- Venda/baixa de peças e movimentação transacional de estoque — issue #10.
- Disparo do alerta de reposição (notificação/agente) — issue D; aqui só a view base `v_dia_parts_critical`.
- Relações formais para `manufacturer`/`location`/branch (texto simples nesta fatia).
- Histórico de movimentação via `time_series_points`/`entity_facts`.

## Out-of-scope

- Integração com razão contábil (posting de valor de estoque no GL).
- Importação em massa de catálogo legado.
- Tabela de preços por cliente/canal ou margem dinâmica.
- Cálculo de ponto de reposição por demanda/lead-time.

---

## Apêndice técnico — padrões aterrados (referência do coder)

> O schema vivo foi podado (`20260625120000_dia_core_prune_wynne_domain.sql`) — `create_stock_item` NÃO existe mais; espelhe `vehicle`, não o antigo inventário.

1. **Migration de referência primária:** `supabase/migrations/20260625130000_dia_vehicle_entity_crud.sql` — copiar o esqueleto: (a) recriar `rental_entity_type_catalog` `security_invoker` adicionando `('part')`; (b) `dia_assert_part_writer()`; (c) `dia_validate_part_data(jsonb)` validando `status IN ('ativo','inativo')` e exigindo `part_number`/`description`; (d) `create_part`/`update_part` (merge SCD2); (e) `delete_part` = soft-delete `status='inativo'` + `retired=true`/`retired_at`.
2. **Views `security_invoker`:** padrão `v_dia_vehicle_current` sobre `rental_current_entity_state WHERE entity_type='part' AND coalesce((data->>'retired')::boolean,false)=false`. `stock_value = round(qty * unit_cost, 2)`; `stock_status` via `CASE` na ordem zerado→critico→baixo→ok. `v_dia_parts_critical` filtra por `stock_status IN ('baixo','critico','zerado')` com `ORDER BY` por rank de criticidade.
3. **RPC hardening base:** `supabase/migrations/20260607133000_authenticated_write_rpc_hardening.sql` — `create_entity_with_version` e `rental_upsert_entity_current_state` (seed). Confirmar `get_my_role()` e `rental_assert_entity_type`.
4. **Frontend (portal nativo, NÃO o antigo `frontend/` UIEngine):**
   - Tela: nova `frontend-portal/src/portal/renderers/screens/PartsInventory.tsx` (molde: `VehiclesInventory.tsx`).
   - Registry: `frontend-portal/src/portal/renderers/registry.ts` — `'dia-parts': lazy(() => import('.../PartsInventory'))`.
   - Menu: `frontend-portal/src/portal/lib/portalApi.ts` — item com `componentKey: 'dia-parts'`.
   - Dados/CRUD: `frontend-portal/src/portal/lib/agentsApi.ts` — `PartRow`/`PartInput`, `getParts()` lendo `v_dia_part_current`, wrappers `.rpc('create_part'|'update_part'|'delete_part', ...)`. Opcional: `getCriticalParts()` lendo `v_dia_parts_critical`.
5. **Seed:** `supabase/seed.sql` — `rental_upsert_entity_current_state('part', jsonb_build_object(...), p_source_record_id => 'demo-dia-part-NNN')`, ~15 peças cobrindo cada `stock_status`.

## Validação offline (ambiente)
- DB compartilhado: NUNCA `supabase db reset`/`start`/`db push`. Validação por revisão estática do SQL.
- `frontend-portal/` offline: revisão TypeScript estática (build é pesado, opcional).
