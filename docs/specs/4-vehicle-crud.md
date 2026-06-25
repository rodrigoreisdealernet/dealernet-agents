# Spec — Issue #4: Veículo — entidade + CRUD (fatia de validação)

> **STATUS: DRAFT** — aguarda aprovação humana (gate #1 do /ship-issue) antes de qualquer código.

## Overview

Criar a entidade `vehicle` (novo/usado) com CRUD completo (migration + RPCs endurecidas + RLS + view + tela UIEngine + seed) no modelo genérico (`entities` + `entity_versions` JSONB), validando o caminho de ponta a ponta do piloto DIA com uma única entidade antes de expandir.

## Problem / Context

Primeira entidade do domínio de concessionária. Valida: modelo genérico reusável; caminho de escrita endurecido (RPC `SECURITY DEFINER` + guarda de role + `GRANT EXECUTE`); RLS + view com derivados; integração UIEngine (página JSON + rota chamando RPCs). Floor plan: custo diário a partir de `cost × (0.13/365) × dias_em_estoque`, exibido como campo derivado read-only (não persistido).

## Acceptance Criteria

- [ ] **Migration** nova (`supabase/migrations/<novo timestamp>.sql`) define o entity_type `vehicle` e três RPCs endurecidas — `create_vehicle`, `update_vehicle`, `delete_vehicle` (soft-delete/retire) — seguindo o padrão de `create_stock_item` (`SECURITY DEFINER`, `set search_path = public, pg_temp`, guarda de role `admin`/`branch_manager`, `GRANT EXECUTE` para `authenticated, service_role`), com escrita direta do cliente bloqueada.
- [ ] **Campos** em `entity_versions.data`: `condition` (`novo`|`usado`), `brand`, `model`, `model_year`, `cost` (numeric), `sale_price` (numeric), `purchase_date`, `status` (`em_estoque`|`vendido`), `store` (textos simples nesta fatia).
- [ ] **RLS**: leitura para `authenticated`; escrita apenas via RPC (sem INSERT/UPDATE direto), respeitando roles existentes (`admin`/`branch_manager` escrevem; `read_only` não).
- [ ] **View `v_dia_vehicle_current`** com `security_invoker = true`: lista veículos correntes (`is_current`) com os campos acima + derivados `days_in_stock` (de `purchase_date`) e `floor_plan_cost` (`cost × 0.13/365 × days_in_stock`). `GRANT SELECT` para `authenticated, service_role`.
- [ ] **Tela `/dia/vehicles`** (UIEngine): `frontend/src/pages/dia-vehicles.json` (dataSource = `v_dia_vehicle_current`) + `frontend/src/routes/dia/vehicles.tsx` + item em `frontend/src/components/nav-config.ts`. Lista (condition, preço, `days_in_stock`, `floor_plan_cost`, status) e permite **criar/editar/remover** via os RPCs.
- [ ] **Seed** (`supabase/seed.sql`): ~12 veículos demo idempotentes (`source_record_id LIKE 'demo-dia-vehicle-%'`), mistura novo/usado com `purchase_date` variados (alguns "envelhecidos" para floor plan > 0). Reusar `rental_upsert_entity_current_state`.
- [ ] **Validação**: aplicando a migration + seed no Postgres rodando, `SELECT entity_id, condition, brand, days_in_stock, floor_plan_cost FROM v_dia_vehicle_current ORDER BY days_in_stock DESC;` retorna ~12 linhas com `floor_plan_cost` > 0 para os mais antigos; criar/editar/remover pela tela reflete no banco; `read_only` não consegue escrever.

## Non-Goals

- Relações formais para `brand`/`store` (texto simples aqui).
- Vendas (`vehicle_sale`), Oficina (`service_order`) e KPIs/views agregadas do dono — issues seguintes.
- Configuração da taxa de floor plan por tenant (constante de demo 0.13 por enquanto).

## Out-of-scope

- Integração com razão contábil (posting do floor plan no GL).
- Importação em massa de inventário legado.
- Definição de tipos de relacionamento (branch/owner ↔ vehicle).
- Relatórios/BI de idade de estoque / turn-and-earn.

---

## Apêndice técnico — padrões aterrados (referência do coder)

> Os números de linha são pistas; o coder DEVE reabrir cada arquivo e confirmar assinaturas/colunas reais (`get_my_role`, `create_entity_with_version`, `rental_current_entity_state`, colunas `is_current`/`source_record_id`) antes de implementar.

### 1. RPC endurecida — padrão `create_stock_item`
`supabase/migrations/20260611100000_inventory_item_type_model.sql` (≈41–179):
- `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp`
- Retorno `RETURNS TABLE (entity_id uuid, entity_version_id uuid, version_number int)`
- Guarda de role: checa `request.jwt.claim.role` = `service_role` OU (`authenticated` E `get_my_role() IN ('admin','branch_manager')`), senão `RAISE EXCEPTION ... errcode='42501'`.
- Insert em `entities` + `entity_versions`; `GRANT EXECUTE ON FUNCTION ... TO authenticated, service_role;`
- Para `vehicle`: validar `condition IN ('novo','usado')` e `status IN ('em_estoque','vendido')`. `update_vehicle(p_entity_id, p_data)` cria nova versão; `delete_vehicle(p_entity_id)` faz retire/soft-delete (não DELETE físico).

### 2. Helper `rental_upsert_entity_current_state`
`supabase/migrations/20260605154500_rental_master_data_foundation.sql` (≈121–197): assinatura `(p_entity_type text, p_data jsonb, p_entity_id uuid DEFAULT NULL, p_source_record_id text DEFAULT NULL) RETURNS TABLE(...)`. Cria a entidade+versão se não existir (por `entity_type`+`source_record_id`), senão incrementa `version_number`. **Usado no seed** e reutilizável pelas RPCs.

### 3. View `security_invoker` — padrão `rental_current_stock_items`
Mesmo arquivo do item 1 (≈235–259) e `20260607183000_set_security_invoker_on_exposed_views.sql`: `CREATE OR REPLACE VIEW ... WITH (security_invoker = true) AS SELECT ... FROM rental_current_entity_state WHERE entity_type = '...'`. Derivados sugeridos:
```sql
EXTRACT(DAY FROM (now()::date - (data->>'purchase_date')::date))::int AS days_in_stock,
ROUND((data->>'cost')::numeric * (0.13/365.0) *
  EXTRACT(DAY FROM (now()::date - (data->>'purchase_date')::date))::numeric, 2) AS floor_plan_cost
```

### 4. RLS / grants
`supabase/migrations/20260607133000_authenticated_write_rpc_hardening.sql`: escrita via RPC (`SECURITY DEFINER`); leitura pela view `security_invoker`. Confirmar se grants nas tabelas base já cobrem o caso — não abrir INSERT/UPDATE direto a `authenticated` para `vehicle`.

### 5. UIEngine — rota + página JSON + nav
- Página: `frontend/src/pages/dashboard.json` é o molde de `dataSources` + layout/DataTable.
- Rota: padrão de `frontend/src/routes/` carregando `UIEngine page={...}` a partir do JSON importado.
- Nav: `frontend/src/components/nav-config.ts` — adicionar item `/dia/vehicles` (criar seção "DIA" se fizer sentido).
- Ações da tabela devem chamar `create_vehicle`/`update_vehicle`/`delete_vehicle` via client Supabase (`.rpc(...)`).

### 6. Seed idempotente
`supabase/seed.sql`: padrão `source_record_id` `demo-...`. Inserir 12 veículos (≈6 novos + 6 usados) variando `purchase_date` (alguns `now() - interval '60 days'` ou mais) para floor plan visível. Preferir `rental_upsert_entity_current_state('vehicle', jsonb_build_object(...), p_source_record_id => 'demo-dia-vehicle-NNN')`.

## Validação offline (ambiente)
- Sem Supabase CLI; Postgres rodando no container `supabase_db_dealernet-agents`. Aplicar SQL: `docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres < migration.sql` e consultar a view.
- `frontend/` tem vite+vitest+tsc → `npm run typecheck`, `npm run build`, `npm run test` rodam offline.
