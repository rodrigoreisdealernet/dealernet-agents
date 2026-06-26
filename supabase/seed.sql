-- Demo seed data for UI usability — DIA DMS automotivo.
--
-- O antigo baseline Wynne (rental: contratos, clientes, ativos, faturas e os
-- agentes/findings do Operations Factory revrec/credit/fleet/account-health/
-- territory + 500 placeholders) foi REMOVIDO: o produto agora é o DMS automotivo
-- (DIA). Apenas os tenants compartilhados demo-ops-a/b são preservados — o
-- domínio DIA (config do agente vehicle-aging e ops findings) os reutiliza.

begin;
set local request.jwt.claim.role = 'service_role';

-- Tenants compartilhados de ops (preservados do baseline Wynne removido).
INSERT INTO tenants (tenant_key, name) VALUES
  ('demo-ops-a', 'Demo Ops Tenant A'),
  ('demo-ops-b', 'Demo Ops Tenant B')
ON CONFLICT (tenant_key) DO UPDATE SET name = EXCLUDED.name;

commit;

-- ===========================================================================
-- Purga do legado Wynne (rental / Operations Factory) — idempotente.
-- Remove os dados de demo herdados do template de aluguel que não fazem parte do
-- produto DIA (DMS automotivo). Mantém os tenants (acima) e o domínio DIA
-- (abaixo). Os findings/config do agente DIA vehicle-aging-analyst são preservados
-- (agent_key/namespace distintos). Ordem child→parent respeita as FKs
-- (invoice_adjustment_draft/credit_change_proposal → finding → ops_workflow_run).
-- ===========================================================================
begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_wynne_agents text[] := ARRAY[
    'revrec-analyst','credit-analyst','fleet-auditor',
    'account-health-queue','territory-account-brief'
  ];
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Drafts/propostas que referenciam findings (FK → finding).
  DELETE FROM invoice_adjustment_draft;
  DELETE FROM credit_change_proposal;

  -- Tokens de escopo do portal que referenciam contratos demo-baseline.
  DELETE FROM portal_intake_scope_tokens;
  DELETE FROM portal_contract_scope_tokens;

  -- Findings dos agentes Wynne (revrec/credit/fleet/account-health/territory)
  -- + os 500 placeholders. Os do agente DIA (vehicle-aging-analyst) ficam.
  DELETE FROM finding WHERE agent_key = ANY(v_wynne_agents);

  -- Runs de workflow agora sem findings (legado Wynne). Mantém os referenciados.
  DELETE FROM ops_workflow_run
  WHERE run_id NOT IN (SELECT run_id FROM finding WHERE run_id IS NOT NULL);

  -- Config desses agentes (tabela base + entity store).
  DELETE FROM ops_agent_config WHERE agent_key = ANY(v_wynne_agents);
  DELETE FROM entities
  WHERE entity_type = 'agent_config'
    AND split_part(source_record_id, ':', 3) = ANY(v_wynne_agents);

  -- Schemas de saída do legado (mantém apenas o do agente DIA).
  DELETE FROM ops_output_schema_registry WHERE schema_key <> 'vehicle_aging_finding_v1';

  -- Câmbio multi-moeda (Wynne); o DIA opera em BRL.
  DELETE FROM fx_rates;

  -- Entidades do baseline rental (cascade → entity_versions, entity_facts,
  -- time_series_points, relationships_v2).
  DELETE FROM entities WHERE source_record_id LIKE 'demo-baseline-%';
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — RESET / zera banco (issue #46)
-- Apaga TODOS os registros dos tipos DIA antes de repopular, para um dataset
-- limpo (remove inclusive sobras não-demo que inflavam as contagens das views).
-- O tipo 'company' era COMPARTILHADO com o antigo domínio rental; o baseline
-- Wynne foi removido (bloco de purga acima), então aqui mantemos a limpeza do
-- namespace DIA (demo-dia-company-%) por idempotência.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Tipos exclusivos do domínio DIA: apaga tudo (demo e não-demo).
  DELETE FROM entities
  WHERE entity_type IN ('vehicle', 'brand', 'part', 'part_sale', 'service_order');

  -- 'company' é compartilhado com rental: remove apenas o namespace DIA.
  DELETE FROM entities
  WHERE entity_type = 'company'
    AND source_record_id LIKE 'demo-dia-company-%';
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo fleet, high volume (issue #4, ampliado #46)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-fleet-%'.
-- ~120 veículos GERADOS POR LOJA (8 lojas, 15 cada) para concentrar os dados do
-- BI: cada veículo herda a 'brand' e o 'store' da sua loja (marca consistente com
-- a loja, alinhado às 4 marcas / 8 lojas do bloco de empresas abaixo). Cobre
-- condition novo/usado, status em_estoque/vendido e days_in_stock de 0 a ~420
-- (variando floor_plan_cost). Reuses rental_upsert_entity_current_state.
-- NOTA: este namespace é o 'demo-dia-fleet-%' (volume p/ dashboards). Os 15
-- veículos determinísticos do Vehicle Stock-Aging Analyst (#32) vivem no bloco
-- 'demo-dia-vehicle-%' logo abaixo — namespaces separados de propósito.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_now timestamptz := now();
  -- store/brand alinhados às 4 marcas e 8 lojas (2 por marca). cost_base reflete
  -- o segmento (motos baratas, caminhões caros) e cada loja tem seus modelos.
  -- A geração (days_in_stock 0..~420) inclui veículos em_estoque na faixa 75-90d
  -- e acima de 90d, cobrindo o que o Vehicle Stock-Aging Analyst (#32) precisa.
  v_lojas jsonb := jsonb_build_array(
    jsonb_build_object('store','Fiat São Paulo','brand','Fiat','cost_base',85000,'models',jsonb_build_array('Pulse','Argo','Mobi','Cronos','Toro','Strada')),
    jsonb_build_object('store','Fiat Campinas','brand','Fiat','cost_base',82000,'models',jsonb_build_array('Pulse','Argo','Mobi','Cronos','Fastback','Fiorino')),
    jsonb_build_object('store','Volkswagen Porto Alegre','brand','Volkswagen','cost_base',95000,'models',jsonb_build_array('Polo','Nivus','T-Cross','Virtus','Golf','Saveiro')),
    jsonb_build_object('store','Volkswagen Curitiba','brand','Volkswagen','cost_base',98000,'models',jsonb_build_array('Polo','Nivus','T-Cross','Virtus','Taos','Amarok')),
    jsonb_build_object('store','Volvo Caminhões Manaus','brand','Volvo','cost_base',420000,'models',jsonb_build_array('FH 460','VM 270','FH 540','VM 220')),
    jsonb_build_object('store','Volvo Caminhões Brasília','brand','Volvo','cost_base',460000,'models',jsonb_build_array('FH 460','VM 270','FH 540','FMX 500')),
    jsonb_build_object('store','Honda Motos Belo Horizonte','brand','Honda','cost_base',18000,'models',jsonb_build_array('CG 160','Biz 125','CB 500','XRE 300','PCX 160')),
    jsonb_build_object('store','Honda Motos Salvador','brand','Honda','cost_base',16000,'models',jsonb_build_array('CG 160','Biz 125','CB 300','XRE 190','Pop 110'))
  );
  v_loja jsonb;
  v_models jsonb;
  v_nmodels int;
  v_seq int := 0;
  k int;
  v_cond text;
  v_status text;
  v_cost numeric;
  v_model text;
  v_days int;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo fleet, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'vehicle'
    AND source_record_id LIKE 'demo-dia-fleet-%';

  FOR v_loja IN SELECT * FROM jsonb_array_elements(v_lojas)
  LOOP
    v_models  := v_loja -> 'models';
    v_nmodels := jsonb_array_length(v_models);

    FOR k IN 1..15 LOOP
      v_seq    := v_seq + 1;
      v_cond   := CASE WHEN k % 2 = 0 THEN 'novo' ELSE 'usado' END;
      v_status := CASE WHEN k % 7 = 0 THEN 'vendido' ELSE 'em_estoque' END;
      v_model  := v_models ->> (k % v_nmodels);
      v_days   := (k * 29) % 420;
      v_cost   := (v_loja ->> 'cost_base')::numeric
                  + ((k % 8) * ((v_loja ->> 'cost_base')::numeric * 0.05));

      PERFORM rental_upsert_entity_current_state(
        p_entity_type => 'vehicle',
        p_source_record_id => format('demo-dia-fleet-%s', lpad(v_seq::text, 3, '0')),
        p_data => jsonb_build_object(
          'name', concat_ws(' ', v_loja ->> 'brand', v_model, (2018 + (k % 9))::text),
          'condition', v_cond,
          'brand', v_loja ->> 'brand',
          'model', v_model,
          'model_year', CASE WHEN v_cond = 'novo' THEN 2026 ELSE 2018 + (k % 8) END,
          'cost', round(v_cost, 2),
          'sale_price', round(v_cost * 1.18, -2),
          'purchase_date', to_char((v_now - (v_days || ' days')::interval)::date, 'YYYY-MM-DD'),
          'status', v_status,
          'store', v_loja ->> 'store',
          'source_record_id', format('demo-dia-fleet-%s', lpad(v_seq::text, 3, '0'))
        )
      );
    END LOOP;
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — Vehicle Stock-Aging Analyst fixtures (issue #32)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-vehicle-%' (EXATAMENTE 15).
-- Conjunto determinístico que alimenta o contrato do #32
-- (supabase/tests/vehicle_aging_contract.test.mjs): 9 em escopo (em_estoque,
-- days_in_stock >= 75) e 6 controles (5 abaixo de 75d + 1 vendido). Separado do
-- fleet de alto volume acima (demo-dia-fleet-%). days_in_stock é derivado como
-- now()::date - purchase_date, então purchase_date = current_date - N dias.
-- brand/store reutilizam as 4 marcas / 8 lojas existentes p/ manter o owner-brief
-- alinhado. Reuses rental_upsert_entity_current_state sob o guard service_role.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_today date := now()::date;
  -- (sr, days_in_stock, status, brand, store, model, condition, cost) — as 9
  -- linhas em_estoque com days>=75 produzem a ordem esperada por days desc:
  -- 009=240, 005=200, 008=160, 002=120, 007=90, 015=89, 014=86, 013=80, 001=75.
  v_fix jsonb := jsonb_build_array(
    jsonb_build_object('sr','demo-dia-vehicle-001','days', 75,'status','em_estoque','brand','Fiat','store','Fiat São Paulo','model','Pulse','condition','usado','cost', 85000),
    jsonb_build_object('sr','demo-dia-vehicle-002','days',120,'status','em_estoque','brand','Fiat','store','Fiat Campinas','model','Argo','condition','novo','cost', 82000),
    jsonb_build_object('sr','demo-dia-vehicle-003','days', 40,'status','em_estoque','brand','Volkswagen','store','Volkswagen Porto Alegre','model','Polo','condition','usado','cost', 95000),
    jsonb_build_object('sr','demo-dia-vehicle-004','days', 30,'status','em_estoque','brand','Volkswagen','store','Volkswagen Curitiba','model','Nivus','condition','novo','cost', 98000),
    jsonb_build_object('sr','demo-dia-vehicle-005','days',200,'status','em_estoque','brand','Volvo','store','Volvo Caminhões Manaus','model','FH 460','condition','usado','cost',420000),
    jsonb_build_object('sr','demo-dia-vehicle-006','days', 60,'status','em_estoque','brand','Honda','store','Honda Motos Belo Horizonte','model','CG 160','condition','novo','cost', 18000),
    jsonb_build_object('sr','demo-dia-vehicle-007','days', 90,'status','em_estoque','brand','Honda','store','Honda Motos Salvador','model','Biz 125','condition','usado','cost', 16000),
    jsonb_build_object('sr','demo-dia-vehicle-008','days',160,'status','em_estoque','brand','Fiat','store','Fiat São Paulo','model','Toro','condition','novo','cost', 90000),
    jsonb_build_object('sr','demo-dia-vehicle-009','days',240,'status','em_estoque','brand','Volkswagen','store','Volkswagen Porto Alegre','model','T-Cross','condition','usado','cost', 99000),
    jsonb_build_object('sr','demo-dia-vehicle-010','days', 20,'status','em_estoque','brand','Volvo','store','Volvo Caminhões Brasília','model','VM 270','condition','novo','cost',460000),
    jsonb_build_object('sr','demo-dia-vehicle-011','days', 50,'status','em_estoque','brand','Honda','store','Honda Motos Belo Horizonte','model','CB 500','condition','usado','cost', 35000),
    jsonb_build_object('sr','demo-dia-vehicle-012','days',100,'status','vendido','brand','Fiat','store','Fiat Campinas','model','Mobi','condition','usado','cost', 75000),
    jsonb_build_object('sr','demo-dia-vehicle-013','days', 80,'status','em_estoque','brand','Volkswagen','store','Volkswagen Curitiba','model','Virtus','condition','novo','cost', 96000),
    jsonb_build_object('sr','demo-dia-vehicle-014','days', 86,'status','em_estoque','brand','Volvo','store','Volvo Caminhões Manaus','model','FH 540','condition','usado','cost',480000),
    jsonb_build_object('sr','demo-dia-vehicle-015','days', 89,'status','em_estoque','brand','Honda','store','Honda Motos Salvador','model','XRE 190','condition','novo','cost', 22000)
  );
  v_v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior deterministic demo vehicles, then recreate exactly 15.
  DELETE FROM entities
  WHERE entity_type = 'vehicle'
    AND source_record_id LIKE 'demo-dia-vehicle-%';

  FOR v_v IN SELECT * FROM jsonb_array_elements(v_fix)
  LOOP
    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'vehicle',
      p_source_record_id => v_v ->> 'sr',
      p_data => jsonb_build_object(
        'name', concat_ws(' ', v_v ->> 'brand', v_v ->> 'model',
          CASE WHEN v_v ->> 'condition' = 'novo' THEN '2026' ELSE '2020' END),
        'condition', v_v ->> 'condition',
        'brand', v_v ->> 'brand',
        'model', v_v ->> 'model',
        'model_year', CASE WHEN v_v ->> 'condition' = 'novo' THEN 2026 ELSE 2020 END,
        'cost', (v_v ->> 'cost')::numeric,
        'sale_price', round((v_v ->> 'cost')::numeric * 1.18, -2),
        'purchase_date', to_char(v_today - ((v_v ->> 'days')::int), 'YYYY-MM-DD'),
        'status', v_v ->> 'status',
        'store', v_v ->> 'store',
        'source_record_id', v_v ->> 'sr'
      )
    );
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- Vehicle Stock-Aging Analyst agent config (issue #32)
-- Seeds `vehicle-aging-analyst` for demo-ops-a and demo-ops-b in BOTH the
-- entity store (entity_type='agent_config'; read by ops_agent_config_current →
-- ops_load_agent_config and by the worker schedule reconcile) and the base
-- `ops_agent_config` table (parity). enabled=true but schedule.enabled=false so
-- the recurring run stays off by default. The output schema registry row is
-- owned by migration 20260626140001_vehicle_aging_agent.sql (applied first).
-- Idempotent via ON CONFLICT upserts; tenants come from the main ops seed above.
-- ===========================================================================
DO $$
DECLARE
  v_agent_key   text  := 'vehicle-aging-analyst';
  v_schema_key  text  := 'vehicle_aging_finding_v1';
  v_model       jsonb := '{"provider":"azure_openai","deployment":"gpt-4.1-mini","api_version":"2024-12-01-preview"}'::jsonb;
  v_system_prompt text := 'You are the Vehicle Stock-Aging Analyst for a vehicle dealership. Rank in-stock vehicles approaching the 90-day floor-plan exposure line for tenant {tenant_id}. Recommend a reviewable next action (monitor, markdown, transfer, prioritize_sale, wholesale_auction) using days in stock, floor-plan cost, store, and pricing. Never apply markdowns, transfers, or sales automatically; surface evidence and keep uncertainty explicit.';
  v_user_prompt text := 'Assess vehicle {vehicle_id} ({brand} {model} {model_year}) at store {store} for tenant {tenant_id}. Days in stock: {days_in_stock}. Aging bucket: {aging_bucket}. Floor-plan cost: {floor_plan_cost}. Cost: {cost}. Sale price: {sale_price}. Recommend the next human-approved action with supporting evidence. Evidence:\n{evidence_json}';
  v_tools       jsonb := '[]'::jsonb;
  v_thresholds  jsonb := '{"aging_warning_days":75,"aging_breach_days":90}'::jsonb;
  v_bounds      jsonb := '{"max_findings_per_run":50,"max_tool_rounds":2}'::jsonb;
  v_schedule    jsonb := '{"cron":"0 6 * * 1-5","enabled":false}'::jsonb;
  v_tenant_keys text[] := ARRAY['demo-ops-a','demo-ops-b'];
  v_tenant_key  text;
  v_tenant_id   uuid;
  v_entity_id   uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOREACH v_tenant_key IN ARRAY v_tenant_keys
  LOOP
    SELECT id INTO v_tenant_id FROM tenants WHERE tenant_key = v_tenant_key;
    IF v_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Vehicle aging seed requires tenant % (run the main ops seed first)', v_tenant_key;
    END IF;

    -- Idempotent reset: drop any prior current version first. The SCD2 BEFORE
    -- INSERT trigger forbids ON CONFLICT from re-updating an existing current
    -- version in the same command, so a clean delete (cascading to versions)
    -- keeps a re-applied seed replay-safe.
    DELETE FROM entities
    WHERE entity_type = 'agent_config'
      AND source_record_id = format('demo-ops-agent-config:%s:%s', v_tenant_id, v_agent_key);

    -- Canonical config in the entity store (read by ops_agent_config_current).
    INSERT INTO entities (entity_type, source_record_id)
    VALUES ('agent_config', format('demo-ops-agent-config:%s:%s', v_tenant_id, v_agent_key))
    ON CONFLICT (entity_type, source_record_id) DO UPDATE
      SET source_record_id = EXCLUDED.source_record_id
    RETURNING id INTO v_entity_id;

    INSERT INTO entity_versions (entity_id, version_number, data)
    VALUES (
      v_entity_id,
      1,
      jsonb_build_object(
        'tenant_id', v_tenant_id,
        'agent_key', v_agent_key,
        'enabled', true,
        'model', v_model,
        'system_prompt', v_system_prompt,
        'user_prompt_template', v_user_prompt,
        'tools', v_tools,
        'output_schema_key', v_schema_key,
        'thresholds', v_thresholds,
        'bounds', v_bounds,
        'schedule', v_schedule,
        'auto_apply', false
      )
    )
    ON CONFLICT (entity_id, version_number) DO UPDATE
      SET data = EXCLUDED.data,
          is_current = true,
          valid_to = NULL;

    -- Base-table parity row.
    INSERT INTO ops_agent_config (
      tenant_id, agent_key, enabled, model,
      system_prompt, user_prompt_template,
      tools, output_schema_key, thresholds, bounds, schedule, auto_apply
    )
    VALUES (
      v_tenant_id, v_agent_key, true, v_model,
      v_system_prompt, v_user_prompt,
      v_tools, v_schema_key, v_thresholds, v_bounds, v_schedule, false
    )
    ON CONFLICT (tenant_id, agent_key) DO UPDATE
      SET enabled              = EXCLUDED.enabled,
          model                = EXCLUDED.model,
          system_prompt        = EXCLUDED.system_prompt,
          user_prompt_template = EXCLUDED.user_prompt_template,
          tools                = EXCLUDED.tools,
          output_schema_key    = EXCLUDED.output_schema_key,
          thresholds           = EXCLUDED.thresholds,
          bounds               = EXCLUDED.bounds,
          schedule             = EXCLUDED.schedule,
          auto_apply           = EXCLUDED.auto_apply,
          updated_at           = now();
  END LOOP;
END
$$;

-- ===========================================================================
-- DIA dealership domain — demo companies + brands (issue #5)
-- Idempotent namespaces: source_record_id LIKE 'demo-dia-company-%' / '-brand-%'.
-- Reuses rental_upsert_entity_current_state (the generic SCD2 upsert) under the
-- service_role write guard.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  -- 4 marcas distintas cobrindo os 3 segmentos (automoveis x2 + caminhoes + motos).
  v_brands jsonb := jsonb_build_array(
    jsonb_build_object('sr','demo-dia-brand-1','name','Fiat','segment','automoveis','status','ativo'),
    jsonb_build_object('sr','demo-dia-brand-2','name','Volkswagen','segment','automoveis','status','ativo'),
    jsonb_build_object('sr','demo-dia-brand-3','name','Volvo','segment','caminhoes','status','ativo'),
    jsonb_build_object('sr','demo-dia-brand-4','name','Honda','segment','motos','status','ativo')
  );
  -- 8 lojas divididas entre as 4 marcas (2 por marca) para CONCENTRAR os dados.
  -- O trade_name de cada loja é reutilizado no campo 'store' dos veículos, então
  -- os veículos agrupam por loja/marca. Uma loja fica inativa (filtro de status).
  v_companies jsonb := jsonb_build_array(
    jsonb_build_object('sr','demo-dia-company-1','brand_sr','demo-dia-brand-1','legal_name','DIA Fiat São Paulo Ltda','trade_name','Fiat São Paulo','cnpj','12.345.678/0001-90','city','São Paulo','state','SP','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-2','brand_sr','demo-dia-brand-1','legal_name','DIA Fiat Campinas Ltda','trade_name','Fiat Campinas','cnpj','12.345.678/0002-71','city','Campinas','state','SP','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-3','brand_sr','demo-dia-brand-2','legal_name','DIA VW Porto Alegre Ltda','trade_name','Volkswagen Porto Alegre','cnpj','12.345.678/0003-52','city','Porto Alegre','state','RS','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-4','brand_sr','demo-dia-brand-2','legal_name','DIA VW Curitiba Ltda','trade_name','Volkswagen Curitiba','cnpj','12.345.678/0004-33','city','Curitiba','state','PR','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-5','brand_sr','demo-dia-brand-3','legal_name','DIA Volvo Manaus Ltda','trade_name','Volvo Caminhões Manaus','cnpj','12.345.678/0005-14','city','Manaus','state','AM','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-6','brand_sr','demo-dia-brand-3','legal_name','DIA Volvo Brasília Ltda','trade_name','Volvo Caminhões Brasília','cnpj','12.345.678/0006-04','city','Brasília','state','DF','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-7','brand_sr','demo-dia-brand-4','legal_name','DIA Honda BH Ltda','trade_name','Honda Motos Belo Horizonte','cnpj','12.345.678/0007-87','city','Belo Horizonte','state','MG','status','ativo'),
    jsonb_build_object('sr','demo-dia-company-8','brand_sr','demo-dia-brand-4','legal_name','DIA Honda Salvador Ltda','trade_name','Honda Motos Salvador','cnpj','12.345.678/0008-68','city','Salvador','state','BA','status','inativo')
  );
  v_item jsonb;
  v_brand_id uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo companies/brands, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'company'
    AND source_record_id LIKE 'demo-dia-company-%';

  DELETE FROM entities
  WHERE entity_type = 'brand'
    AND source_record_id LIKE 'demo-dia-brand-%';

  -- Brands first so companies can resolve their brand_id.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_brands)
  LOOP
    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'brand',
      p_source_record_id => v_item ->> 'sr',
      p_data => jsonb_build_object(
        'name', v_item ->> 'name',
        'segment', v_item ->> 'segment',
        'status', v_item ->> 'status',
        'source_record_id', v_item ->> 'sr'
      )
    );
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_companies)
  LOOP
    -- Resolve the brand entity_id from its demo source_record_id.
    SELECT id INTO v_brand_id
    FROM entities
    WHERE entity_type = 'brand'
      AND source_record_id = v_item ->> 'brand_sr';

    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'company',
      p_source_record_id => v_item ->> 'sr',
      p_data => jsonb_build_object(
        'name', v_item ->> 'trade_name',
        'legal_name', v_item ->> 'legal_name',
        'trade_name', v_item ->> 'trade_name',
        'cnpj', v_item ->> 'cnpj',
        'city', v_item ->> 'city',
        'state', v_item ->> 'state',
        'status', v_item ->> 'status',
        'brand_id', v_brand_id::text,
        'source_record_id', v_item ->> 'sr'
      )
    );
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo service orders / Oficina (issue #7)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-service-%'.
-- 18 ordens CURADAS cobrindo todos os status (aberta/em_andamento/concluida/
-- cancelada), todas abertas DENTRO do mês corrente (conceito MÊS ATUAL do
-- Morning Brief, #46 — clamp no 1º dia do mês). Pelo menos 2 'concluida' com
-- closed_at p/ popular turnaround_hours. O VOLUME em massa vive no namespace
-- separado 'demo-dia-svcvol-%' abaixo (não colide com este LIKE).
-- Reuses rental_upsert_entity_current_state (the generic SCD2 upsert) under
-- the service_role write guard.
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_now timestamptz := now();
  -- open_days = days ago the order was opened; turn_h = hours to close (null = open).
  v_orders jsonb := jsonb_build_array(
    jsonb_build_object('sr','demo-dia-service-001','order_number','OS-2026-001','customer','Maria Souza','vehicle','BRA2E19','description','Revisão de 10.000 km','status','concluida','open_days',55,'turn_h',6,'revenue',850.00,'technician','Carlos'),
    jsonb_build_object('sr','demo-dia-service-002','order_number','OS-2026-002','customer','João Lima','vehicle','RIO3F45','description','Troca de pastilhas de freio','status','concluida','open_days',40,'turn_h',3,'revenue',520.00,'technician','Ana'),
    jsonb_build_object('sr','demo-dia-service-003','order_number','OS-2026-003','customer','Pedro Alves','vehicle','SAO7G88','description','Alinhamento e balanceamento','status','concluida','open_days',20,'turn_h',2,'revenue',280.00,'technician','Carlos'),
    jsonb_build_object('sr','demo-dia-service-004','order_number','OS-2026-004','customer','Lucas Reis','vehicle','BHZ1H22','description','Diagnóstico eletrônico','status','em_andamento','open_days',5,'turn_h',null,'revenue',150.00,'technician','Ana'),
    jsonb_build_object('sr','demo-dia-service-005','order_number','OS-2026-005','customer','Fernanda Dias','vehicle','POA9J33','description','Troca de óleo e filtros','status','em_andamento','open_days',3,'turn_h',null,'revenue',420.00,'technician','Bruno'),
    jsonb_build_object('sr','demo-dia-service-006','order_number','OS-2026-006','customer','Roberto Nunes','vehicle','CWB4K11','description','Reparo do ar-condicionado','status','aberta','open_days',2,'turn_h',null,'revenue',null,'technician',null),
    jsonb_build_object('sr','demo-dia-service-007','order_number','OS-2026-007','customer','Camila Rocha','vehicle','REC6L77','description','Substituição de embreagem','status','aberta','open_days',1,'turn_h',null,'revenue',null,'technician','Bruno'),
    jsonb_build_object('sr','demo-dia-service-008','order_number','OS-2026-008','customer','Tiago Melo','vehicle','SSA2M55','description','Revisão geral pré-viagem','status','aberta','open_days',0,'turn_h',null,'revenue',null,'technician',null),
    jsonb_build_object('sr','demo-dia-service-009','order_number','OS-2026-009','customer','Juliana Castro','vehicle','FOR8N99','description','Troca de bateria','status','em_andamento','open_days',7,'turn_h',null,'revenue',680.00,'technician','Carlos'),
    jsonb_build_object('sr','demo-dia-service-010','order_number','OS-2026-010','customer','Marcelo Pinto','vehicle','VIX5P44','description','Reparo na suspensão','status','aberta','open_days',1,'turn_h',null,'revenue',null,'technician','Ana'),
    -- concluídas adicionais (turnaround variado)
    jsonb_build_object('sr','demo-dia-service-011','order_number','OS-2026-011','customer','Beatriz Gomes','vehicle','CGR1Q66','description','Revisão de 20.000 km','status','concluida','open_days',48,'turn_h',8,'revenue',1120.00,'technician','Bruno'),
    jsonb_build_object('sr','demo-dia-service-012','order_number','OS-2026-012','customer','Rafael Teixeira','vehicle','NAT3R12','description','Troca de correia dentada','status','concluida','open_days',33,'turn_h',12,'revenue',1450.00,'technician','Carlos'),
    jsonb_build_object('sr','demo-dia-service-013','order_number','OS-2026-013','customer','Patrícia Moraes','vehicle','MCZ8S21','description','Reparo de embreagem','status','concluida','open_days',15,'turn_h',5,'revenue',980.00,'technician','Ana'),
    -- em andamento adicionais
    jsonb_build_object('sr','demo-dia-service-014','order_number','OS-2026-014','customer','Gustavo Barros','vehicle','BSB6T34','description','Funilaria e pintura','status','em_andamento','open_days',9,'turn_h',null,'revenue',2300.00,'technician','Bruno'),
    jsonb_build_object('sr','demo-dia-service-015','order_number','OS-2026-015','customer','Sandra Lopes','vehicle','GYN2U55','description','Diagnóstico de ruído na suspensão','status','em_andamento','open_days',4,'turn_h',null,'revenue',null,'technician','Carlos'),
    -- abertas adicionais
    jsonb_build_object('sr','demo-dia-service-016','order_number','OS-2026-016','customer','Eduardo Pires','vehicle','THE9V77','description','Troca de fluido de freio','status','aberta','open_days',0,'turn_h',null,'revenue',null,'technician',null),
    -- canceladas (validam o status cancelada na view)
    jsonb_build_object('sr','demo-dia-service-017','order_number','OS-2026-017','customer','Vanessa Cardoso','vehicle','SLZ4W88','description','Orçamento de motor recusado pelo cliente','status','cancelada','open_days',12,'turn_h',null,'revenue',null,'technician','Ana'),
    jsonb_build_object('sr','demo-dia-service-018','order_number','OS-2026-018','customer','Henrique Dantas','vehicle','PMW7X99','description','Serviço cancelado — peça indisponível','status','cancelada','open_days',6,'turn_h',null,'revenue',null,'technician','Bruno')
  );
  v_item jsonb;
  v_opened timestamptz;
  v_data jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo service orders, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'service_order'
    AND source_record_id LIKE 'demo-dia-service-%';

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_orders)
  LOOP
    -- Conceito MÊS ATUAL (#46): toda OS é aberta DENTRO do mês corrente. Mantém
    -- 'open_days' como dias-atrás, mas trava no 1º dia do mês (clamp) para não
    -- vazar para o mês anterior.
    v_opened := greatest(
      date_trunc('month', now()),
      v_now - ((v_item ->> 'open_days')::int || ' days')::interval
    );

    v_data := jsonb_build_object(
      'name', concat_ws(' - ', v_item ->> 'order_number', v_item ->> 'customer'),
      'order_number', v_item ->> 'order_number',
      'customer', v_item ->> 'customer',
      'vehicle', v_item ->> 'vehicle',
      'description', v_item ->> 'description',
      'status', v_item ->> 'status',
      'opened_at', to_char(v_opened, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'technician', v_item ->> 'technician',
      'source_record_id', v_item ->> 'sr'
    );

    IF nullif(v_item ->> 'revenue', '') IS NOT NULL THEN
      v_data := v_data || jsonb_build_object('revenue', (v_item ->> 'revenue')::numeric);
    END IF;

    IF nullif(v_item ->> 'turn_h', '') IS NOT NULL THEN
      v_data := v_data || jsonb_build_object(
        'closed_at',
        to_char(v_opened + ((v_item ->> 'turn_h')::int || ' hours')::interval, 'YYYY-MM-DD"T"HH24:MI:SSOF')
      );
    END IF;

    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'service_order',
      p_source_record_id => v_item ->> 'sr',
      p_data => v_data
    );
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo parts (issue #8)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-part-%'.
-- 15 parts covering every stock_status (zerado/critico/baixo/ok) so both
-- v_dia_part_current and v_dia_parts_critical have representative rows.
-- Reuses rental_upsert_entity_current_state (the generic SCD2 upsert) under
-- the service_role write guard.
-- stock_status precedence (assumes min_stock <= reorder_point):
--   zerado qty=0 > critico qty<=min_stock > baixo qty<=reorder_point > ok
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_parts jsonb := jsonb_build_array(
    -- part_number, description, manufacturer, unit_cost, unit_price, qty, min_stock, reorder_point, location, status -> expected stock_status
    -- ok (qty > reorder_point)
    jsonb_build_object('sr','demo-dia-part-001','part_number','FLT-OIL-001','description','Filtro de óleo motor 1.0','manufacturer','Tecfil','unit_cost',18.50,'unit_price',39.90,'qty',120,'min_stock',10,'reorder_point',30,'location','A1-03','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-002','part_number','FLT-AIR-002','description','Filtro de ar condicionado','manufacturer','Mann','unit_cost',32.00,'unit_price',74.90,'qty',80,'min_stock',8,'reorder_point',25,'location','A1-04','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-003','part_number','BRK-PAD-003','description','Pastilha de freio dianteira','manufacturer','Bosch','unit_cost',95.00,'unit_price',189.90,'qty',60,'min_stock',6,'reorder_point',20,'location','B2-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-004','part_number','SPK-PLG-004','description','Vela de ignição iridium','manufacturer','NGK','unit_cost',28.00,'unit_price',59.90,'qty',200,'min_stock',20,'reorder_point',50,'location','B2-02','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-005','part_number','WPR-BLD-005','description','Palheta limpador 24"','manufacturer','Bosch','unit_cost',22.00,'unit_price',49.90,'qty',45,'min_stock',5,'reorder_point',15,'location','C3-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-006','part_number','BAT-12V-006','description','Bateria 60Ah','manufacturer','Moura','unit_cost',280.00,'unit_price',459.90,'qty',18,'min_stock',3,'reorder_point',8,'location','D4-01','status','ativo'),
    -- baixo (qty <= reorder_point, > min_stock)
    jsonb_build_object('sr','demo-dia-part-007','part_number','FLT-FUEL-007','description','Filtro de combustível','manufacturer','Tecfil','unit_cost',24.00,'unit_price',54.90,'qty',12,'min_stock',5,'reorder_point',15,'location','A1-05','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-008','part_number','BLT-ALT-008','description','Correia do alternador','manufacturer','Gates','unit_cost',45.00,'unit_price',98.90,'qty',9,'min_stock',4,'reorder_point',12,'location','C3-02','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-009','part_number','LMP-H4-009','description','Lâmpada farol H4','manufacturer','Philips','unit_cost',15.00,'unit_price',34.90,'qty',20,'min_stock',8,'reorder_point',25,'location','C3-03','status','ativo'),
    -- critico (qty <= min_stock, > 0)
    jsonb_build_object('sr','demo-dia-part-010','part_number','BRK-DSC-010','description','Disco de freio ventilado','manufacturer','Fremax','unit_cost',140.00,'unit_price',279.90,'qty',3,'min_stock',4,'reorder_point',10,'location','B2-03','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-011','part_number','SHK-ABS-011','description','Amortecedor dianteiro','manufacturer','Cofap','unit_cost',210.00,'unit_price',389.90,'qty',2,'min_stock',3,'reorder_point',8,'location','D4-02','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-012','part_number','CLT-KIT-012','description','Kit de embreagem','manufacturer','LuK','unit_cost',420.00,'unit_price',749.90,'qty',1,'min_stock',2,'reorder_point',6,'location','D4-03','status','ativo'),
    -- zerado (qty = 0)
    jsonb_build_object('sr','demo-dia-part-013','part_number','RAD-CLN-013','description','Radiador de arrefecimento','manufacturer','Valeo','unit_cost',360.00,'unit_price',629.90,'qty',0,'min_stock',2,'reorder_point',5,'location','D4-04','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-014','part_number','TBL-FRT-014','description','Bieleta dianteira','manufacturer','Nakata','unit_cost',38.00,'unit_price',84.90,'qty',0,'min_stock',5,'reorder_point',12,'location','C3-04','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-015','part_number','SNR-O2-015','description','Sensor de oxigênio (sonda lambda)','manufacturer','Bosch','unit_cost',180.00,'unit_price',329.90,'qty',0,'min_stock',3,'reorder_point',7,'location','D4-05','status','ativo'),
    -- ok adicionais (qty > reorder_point)
    jsonb_build_object('sr','demo-dia-part-016','part_number','OIL-5W30-016','description','Óleo motor sintético 5W30 1L','manufacturer','Mobil','unit_cost',38.00,'unit_price',74.90,'qty',300,'min_stock',30,'reorder_point',80,'location','A2-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-017','part_number','FLT-CAB-017','description','Filtro de cabine antipólen','manufacturer','Mann','unit_cost',26.00,'unit_price',58.90,'qty',95,'min_stock',10,'reorder_point',30,'location','A2-02','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-018','part_number','FLU-BRK-018','description','Fluido de freio DOT4 500ml','manufacturer','Bosch','unit_cost',19.00,'unit_price',42.90,'qty',150,'min_stock',15,'reorder_point',40,'location','A2-03','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-019','part_number','TER-CLN-019','description','Aditivo de radiador 1L','manufacturer','Paraflu','unit_cost',21.00,'unit_price',45.90,'qty',110,'min_stock',12,'reorder_point',35,'location','A2-04','status','ativo'),
    -- baixo (qty <= reorder_point, > min_stock)
    jsonb_build_object('sr','demo-dia-part-020','part_number','BLT-DST-020','description','Correia dentada','manufacturer','Gates','unit_cost',82.00,'unit_price',169.90,'qty',14,'min_stock',5,'reorder_point',16,'location','C4-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-021','part_number','JNT-CAB-021','description','Junta do cabeçote','manufacturer','Sabó','unit_cost',120.00,'unit_price',239.90,'qty',10,'min_stock',4,'reorder_point',12,'location','C4-02','status','ativo'),
    -- critico (qty <= min_stock, > 0)
    jsonb_build_object('sr','demo-dia-part-022','part_number','BMB-WTR-022','description','Bomba d''água','manufacturer','Schadek','unit_cost',155.00,'unit_price',299.90,'qty',2,'min_stock',3,'reorder_point',8,'location','D5-01','status','ativo'),
    jsonb_build_object('sr','demo-dia-part-023','part_number','TRM-STT-023','description','Válvula termostática','manufacturer','Wahler','unit_cost',58.00,'unit_price',119.90,'qty',1,'min_stock',2,'reorder_point',6,'location','D5-02','status','ativo'),
    -- zerado (qty = 0)
    jsonb_build_object('sr','demo-dia-part-024','part_number','CMP-AC-024','description','Compressor de ar-condicionado','manufacturer','Denso','unit_cost',780.00,'unit_price',1399.90,'qty',0,'min_stock',2,'reorder_point',5,'location','D5-03','status','ativo'),
    -- inativo (não some da view; status inativo para validar filtro)
    jsonb_build_object('sr','demo-dia-part-025','part_number','OLD-CRB-025','description','Carburador (linha descontinuada)','manufacturer','Weber','unit_cost',0,'unit_price',0,'qty',0,'min_stock',0,'reorder_point',0,'location','X9-99','status','inativo'),
    jsonb_build_object('sr','demo-dia-part-026','part_number','FLT-OIL-026','description','Filtro de óleo motor 2.0','manufacturer','Tecfil','unit_cost',24.00,'unit_price',49.90,'qty',75,'min_stock',8,'reorder_point',25,'location','A2-05','status','ativo')
  );
  v_item jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo parts, then recreate.
  DELETE FROM entities
  WHERE entity_type = 'part'
    AND source_record_id LIKE 'demo-dia-part-%';

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_parts)
  LOOP
    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'part',
      p_source_record_id => v_item ->> 'sr',
      p_data => jsonb_build_object(
        'name', concat_ws(' ', v_item ->> 'part_number', v_item ->> 'description'),
        'part_number', v_item ->> 'part_number',
        'description', v_item ->> 'description',
        'manufacturer', v_item ->> 'manufacturer',
        'unit_cost', (v_item ->> 'unit_cost')::numeric,
        'unit_price', (v_item ->> 'unit_price')::numeric,
        'quantity_in_stock', (v_item ->> 'qty')::numeric,
        'min_stock', (v_item ->> 'min_stock')::numeric,
        'reorder_point', (v_item ->> 'reorder_point')::numeric,
        'location', v_item ->> 'location',
        'status', v_item ->> 'status',
        'source_record_id', v_item ->> 'sr'
      )
    );
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — demo part sales (issue #10)
-- Idempotent namespace: source_record_id LIKE 'demo-dia-part-sale-%'.
-- ~12 sales referencing the demo parts (demo-dia-part-NNN). Created via the
-- atomic RPC create_part_sale so the stock decrement is applied consistently:
-- the parts block above re-seeds parts from scratch each run, so re-running the
-- whole seed restores stock to its baseline and then applies these sales once
-- (no double-decrement). The prior DELETE drops cancelled history too.
-- Quantities are chosen so a few parts reach critico/zerado after the sales:
--   part-006 (qty 18, min 3) sell 15 -> 3  = critico
--   part-007 (qty 12, min 5) sell 8  -> 4  = critico
--   part-010 (qty 3,  min 4) sell 3  -> 0  = zerado
--   part-012 (qty 1,  min 2) sell 1  -> 0  = zerado
--   part-008 (qty 9,  min 4, reorder 12) sell 6 -> 3 = critico
-- ===========================================================================

begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_sales jsonb := jsonb_build_array(
    -- sr, part_sr, qty, unit_price, discount, customer, salesperson, month_offset, day
    jsonb_build_object('sr','demo-dia-part-sale-001','part_sr','demo-dia-part-001','qty',20,'unit_price',39.90,'discount',0,'customer','Auto Center Vitória','salesperson','Marina Souza','mo',-1,'day',5),
    jsonb_build_object('sr','demo-dia-part-sale-002','part_sr','demo-dia-part-002','qty',10,'unit_price',74.90,'discount',5.00,'customer','Oficina do Zé','salesperson','Carlos Lima','mo',-1,'day',9),
    jsonb_build_object('sr','demo-dia-part-sale-003','part_sr','demo-dia-part-003','qty',8,'unit_price',189.90,'discount',0,'customer','Frota Rápida Ltda','salesperson','Marina Souza','mo',-1,'day',14),
    jsonb_build_object('sr','demo-dia-part-sale-004','part_sr','demo-dia-part-004','qty',30,'unit_price',59.90,'discount',20.00,'customer','Mecânica Central','salesperson','João Pedro','mo',-1,'day',20),
    jsonb_build_object('sr','demo-dia-part-sale-005','part_sr','demo-dia-part-005','qty',6,'unit_price',49.90,'discount',0,'customer','Cliente Balcão','salesperson','Carlos Lima','mo',-1,'day',24),
    jsonb_build_object('sr','demo-dia-part-sale-006','part_sr','demo-dia-part-006','qty',15,'unit_price',459.90,'discount',50.00,'customer','TransLog Transportes','salesperson','Marina Souza','mo',0,'day',2),
    jsonb_build_object('sr','demo-dia-part-sale-007','part_sr','demo-dia-part-007','qty',8,'unit_price',54.90,'discount',0,'customer','Oficina do Zé','salesperson','João Pedro','mo',0,'day',4),
    jsonb_build_object('sr','demo-dia-part-sale-008','part_sr','demo-dia-part-008','qty',6,'unit_price',98.90,'discount',0,'customer','Auto Center Vitória','salesperson','Carlos Lima','mo',0,'day',6),
    jsonb_build_object('sr','demo-dia-part-sale-009','part_sr','demo-dia-part-009','qty',5,'unit_price',34.90,'discount',0,'customer','Cliente Balcão','salesperson','Marina Souza','mo',0,'day',8),
    jsonb_build_object('sr','demo-dia-part-sale-010','part_sr','demo-dia-part-010','qty',3,'unit_price',279.90,'discount',0,'customer','Frota Rápida Ltda','salesperson','João Pedro','mo',0,'day',10),
    jsonb_build_object('sr','demo-dia-part-sale-011','part_sr','demo-dia-part-012','qty',1,'unit_price',749.90,'discount',30.00,'customer','Mecânica Central','salesperson','Carlos Lima','mo',0,'day',12,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-012','part_sr','demo-dia-part-004','qty',12,'unit_price',59.90,'discount',0,'customer','Cliente Balcão','salesperson','Marina Souza','mo',0,'day',14,'cancel',false),
    -- vendas adicionais referenciando peças com estoque suficiente
    jsonb_build_object('sr','demo-dia-part-sale-013','part_sr','demo-dia-part-016','qty',40,'unit_price',74.90,'discount',0,'customer','Auto Center Vitória','salesperson','Marina Souza','mo',-1,'day',7,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-014','part_sr','demo-dia-part-017','qty',20,'unit_price',58.90,'discount',10.00,'customer','Oficina do Zé','salesperson','João Pedro','mo',-1,'day',18,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-015','part_sr','demo-dia-part-018','qty',25,'unit_price',42.90,'discount',0,'customer','Mecânica Central','salesperson','Carlos Lima','mo',0,'day',3,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-016','part_sr','demo-dia-part-020','qty',2,'unit_price',169.90,'discount',0,'customer','Frota Rápida Ltda','salesperson','Marina Souza','mo',0,'day',5,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-017','part_sr','demo-dia-part-026','qty',10,'unit_price',49.90,'discount',5.00,'customer','Cliente Balcão','salesperson','João Pedro','mo',0,'day',9,'cancel',false),
    jsonb_build_object('sr','demo-dia-part-sale-018','part_sr','demo-dia-part-001','qty',15,'unit_price',39.90,'discount',0,'customer','TransLog Transportes','salesperson','Carlos Lima','mo',0,'day',11,'cancel',false),
    -- vendas canceladas (exercitam cancel_part_sale + estorno de estoque; somem da view)
    jsonb_build_object('sr','demo-dia-part-sale-019','part_sr','demo-dia-part-019','qty',8,'unit_price',45.90,'discount',0,'customer','Auto Center Vitória','salesperson','Marina Souza','mo',0,'day',13,'cancel',true),
    jsonb_build_object('sr','demo-dia-part-sale-020','part_sr','demo-dia-part-003','qty',4,'unit_price',189.90,'discount',0,'customer','Oficina do Zé','salesperson','Carlos Lima','mo',0,'day',15,'cancel',true)
  );
  v_item jsonb;
  v_part_id uuid;
  v_sale_id uuid;
  v_sale_date text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior demo sales (parts are re-seeded above, so stock is
  -- back to baseline before these sales re-apply their decrements).
  DELETE FROM entities
  WHERE entity_type = 'part_sale'
    AND source_record_id LIKE 'demo-dia-part-sale-%';

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_sales)
  LOOP
    SELECT id INTO v_part_id
    FROM entities
    WHERE entity_type = 'part'
      AND source_record_id = v_item ->> 'part_sr';

    IF v_part_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Conceito MÊS ATUAL (#46): ignora o offset de mês ('mo') e ancora a venda no
    -- mês corrente (dia 'day'), travando em hoje para não gerar data futura.
    v_sale_date := to_char(
      least(
        (date_trunc('month', now()) + (((v_item ->> 'day')::int - 1) || ' days')::interval)::date,
        now()::date
      ),
      'YYYY-MM-DD'
    );

    SELECT entity_id INTO v_sale_id
    FROM create_part_sale(
      jsonb_build_object(
        'part_id', v_part_id::text,
        'quantity', (v_item ->> 'qty')::numeric,
        'unit_price', (v_item ->> 'unit_price')::numeric,
        'discount', (v_item ->> 'discount')::numeric,
        'sale_date', v_sale_date,
        'customer', v_item ->> 'customer',
        'salesperson', v_item ->> 'salesperson',
        'channel', 'balcao',
        'source_record_id', v_item ->> 'sr'
      )
    );

    -- Sales flagged cancel: exercise cancel_part_sale (restocks the part; the
    -- cancelled sale is filtered out of v_dia_part_sale_current).
    IF (v_item ->> 'cancel')::boolean THEN
      PERFORM cancel_part_sale(v_sale_id);
    END IF;
  END LOOP;
END
$$;

commit;

-- ===========================================================================
-- DIA dealership domain — VOLUME EM MASSA (issue #46)
-- Os blocos acima criam um conjunto CURADO que garante a cobertura de todas as
-- situações distintas (stock_status, status de OS, vendas canceladas, etc.).
-- Os blocos abaixo geram VOLUME ADICIONAL via generate_series para deixar o
-- banco bem mais populado, sem comprometer a coerência:
--   * peças em massa nascem com estoque amplo ('ok');
--   * vendas em massa só referenciam essas peças com quantidades pequenas, então
--     nunca disparam o guard de estoque insuficiente.
-- Namespaces dedicados (sufixo 'svcvol'/'-bNNN' SEM o prefixo 'demo-dia-service-')
-- para NÃO colidir com o conjunto curado 'demo-dia-service-%'. ATENÇÃO: um sufixo
-- como '-bNNN' aplicado ao MESMO prefixo ('demo-dia-service-b001') ainda casa com
-- LIKE 'demo-dia-service-%' — por isso o volume usa 'demo-dia-svcvol-%'.
-- ===========================================================================

-- (As marcas/empresas e os veículos NÃO têm bloco "em massa": as 4 marcas, as
--  8 lojas e os ~120 veículos por loja já são criados nos blocos curados acima.
--  Aqui em baixo geram-se apenas OS, peças e vendas em massa.)

-- --- Ordens de serviço em massa (~82) -------------------------------------
begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_now timestamptz := now();
  v_statuses text[] := ARRAY['aberta','em_andamento','concluida','cancelada'];
  v_descs    text[] := ARRAY['Revisão programada','Troca de óleo','Reparo de freios','Diagnóstico eletrônico','Alinhamento e balanceamento','Troca de embreagem','Reparo de suspensão','Funilaria e pintura','Troca de bateria','Reparo do ar-condicionado'];
  v_techs    text[] := ARRAY['Carlos','Ana','Bruno','Diego','Eduardo',null];
  v_custs    text[] := ARRAY['Cliente A','Cliente B','Cliente C','Cliente D','Cliente E','Cliente F','Cliente G','Cliente H'];
  i int;
  v_status text;
  v_opened timestamptz;
  v_data jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Idempotent: drop prior mass service orders (namespace próprio, não-colidente).
  DELETE FROM entities
  WHERE entity_type = 'service_order'
    AND source_record_id LIKE 'demo-dia-svcvol-%';

  FOR i IN 1..82 LOOP
    v_status := v_statuses[1 + (i % 4)];
    -- MÊS ATUAL (#46): abre dentro do mês corrente (clamp no 1º dia do mês).
    v_opened := greatest(
      date_trunc('month', now()),
      v_now - (((i * 3) % 28) || ' days')::interval
    );

    v_data := jsonb_build_object(
      'name', format('OS-2026-B%s - %s', lpad(i::text, 3, '0'), v_custs[1 + (i % array_length(v_custs, 1))]),
      'order_number', format('OS-2026-B%s', lpad(i::text, 3, '0')),
      'customer', v_custs[1 + (i % array_length(v_custs, 1))],
      'vehicle', format('%s%s%s%s', chr(65 + (i % 26)), chr(65 + ((i * 2) % 26)), chr(65 + ((i * 3) % 26)), lpad((i % 10000)::text, 4, '0')),
      'description', v_descs[1 + (i % array_length(v_descs, 1))],
      'status', v_status,
      'opened_at', to_char(v_opened, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'technician', v_techs[1 + (i % array_length(v_techs, 1))],
      'source_record_id', format('demo-dia-svcvol-%s', lpad(i::text, 3, '0'))
    );

    -- Concluídas ganham closed_at (turnaround) e receita; em_andamento receita parcial.
    IF v_status = 'concluida' THEN
      v_data := v_data || jsonb_build_object(
        'closed_at', to_char(v_opened + (((i % 12) + 2) || ' hours')::interval, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
        'revenue', 200 + ((i % 20) * 95)
      );
    ELSIF v_status = 'em_andamento' AND i % 2 = 0 THEN
      v_data := v_data || jsonb_build_object('revenue', 150 + ((i % 15) * 70));
    END IF;

    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'service_order',
      p_source_record_id => format('demo-dia-svcvol-%s', lpad(i::text, 3, '0')),
      p_data => v_data
    );
  END LOOP;
END
$$;

commit;

-- --- Peças em massa (~74, estoque amplo -> 'ok') --------------------------
begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_mfrs  text[] := ARRAY['Bosch','Tecfil','Mann','NGK','Gates','Cofap','Nakata','Philips','Valeo','Denso','Mobil','LuK'];
  v_descs text[] := ARRAY['Filtro de óleo','Filtro de ar','Pastilha de freio','Vela de ignição','Correia','Amortecedor','Bieleta','Lâmpada','Sensor','Rolamento','Junta','Bomba'];
  i int;
  v_cost numeric;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOR i IN 1..74 LOOP
    v_cost := 12 + ((i % 30) * 11);

    PERFORM rental_upsert_entity_current_state(
      p_entity_type => 'part',
      p_source_record_id => format('demo-dia-part-b%s', lpad(i::text, 3, '0')),
      p_data => jsonb_build_object(
        'name', format('BULK-%s %s', lpad(i::text, 4, '0'), v_descs[1 + (i % array_length(v_descs, 1))]),
        'part_number', format('BULK-%s', lpad(i::text, 4, '0')),
        'description', format('%s (linha %s)', v_descs[1 + (i % array_length(v_descs, 1))], 1 + (i % 5)),
        'manufacturer', v_mfrs[1 + (i % array_length(v_mfrs, 1))],
        'unit_cost', v_cost,
        'unit_price', round(v_cost * 2.1, 2),
        -- estoque sempre >> reorder_point => stock_status 'ok'
        'quantity_in_stock', 120 + ((i % 12) * 40),
        'min_stock', 10,
        'reorder_point', 30,
        'location', format('%s%s-%s', chr(65 + (i % 6)), 1 + (i % 9), lpad((i % 99)::text, 2, '0')),
        'status', 'ativo',
        'source_record_id', format('demo-dia-part-b%s', lpad(i::text, 3, '0'))
      )
    );
  END LOOP;
END
$$;

commit;

-- --- Vendas em massa (~88, só contra as peças em massa de estoque amplo) ---
begin;
set local request.jwt.claim.role = 'service_role';

DO $$
DECLARE
  v_custs text[] := ARRAY['Auto Center Vitória','Oficina do Zé','Frota Rápida Ltda','Mecânica Central','Cliente Balcão','TransLog Transportes','Garagem Premium','Oficina Bairro'];
  v_sellers text[] := ARRAY['Marina Souza','Carlos Lima','João Pedro','Aline Costa','Rafael Dias'];
  i int;
  v_part_id uuid;
  v_part_sr text;
  v_unit_price numeric;
  v_sale_date text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOR i IN 1..88 LOOP
    -- referencia peças em massa (1..74), cada uma com estoque amplo
    v_part_sr := format('demo-dia-part-b%s', lpad((1 + ((i - 1) % 74))::text, 3, '0'));

    SELECT id INTO v_part_id
    FROM entities
    WHERE entity_type = 'part' AND source_record_id = v_part_sr;

    CONTINUE WHEN v_part_id IS NULL;

    SELECT unit_price INTO v_unit_price
    FROM v_dia_part_current WHERE entity_id = v_part_id;

    -- MÊS ATUAL (#46): todas as vendas no mês corrente (sem recuar meses),
    -- travadas em hoje para não gerar data futura.
    v_sale_date := to_char(
      least(
        (date_trunc('month', now()) + (((i * 7) % 27) || ' days')::interval)::date,
        now()::date
      ),
      'YYYY-MM-DD'
    );

    PERFORM create_part_sale(
      jsonb_build_object(
        'part_id', v_part_id::text,
        'quantity', 1 + (i % 5),                 -- 1..5, << estoque (>=120)
        'unit_price', coalesce(v_unit_price, 49.90),
        'discount', CASE WHEN i % 4 = 0 THEN round((i % 30)::numeric, 2) ELSE 0 END,
        'sale_date', v_sale_date,
        'customer', v_custs[1 + (i % array_length(v_custs, 1))],
        'salesperson', v_sellers[1 + (i % array_length(v_sellers, 1))],
        'channel', 'balcao',
        'source_record_id', format('demo-dia-part-sale-b%s', lpad(i::text, 3, '0'))
      )
    );
  END LOOP;
END
$$;

commit;
