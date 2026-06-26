// Teste de CONTRATO SQL — Execute-after-approval / `finding_action` (issue #73),
// contra o Postgres VIVO. Mesma estrategia do vehicle_crud.test.mjs e do
// vehicle_aging_contract.test.mjs: SEM Supabase CLI, SEM runner instalavel —
// apenas node:test + node:assert chamando o psql do container Docker via
// child_process.execFileSync.
//
// IMPORTANTE: este teste NUNCA roda `supabase db reset` (o banco e' compartilhado
// por outros pipelines). Cada cenario roda dentro de uma unica transacao
// BEGIN; ... ROLLBACK;, semeando o seu proprio tenant/veiculo/finding sob a claim
// de service_role e revertendo tudo no fim — idempotente e seguro.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/finding_action.test.mjs
// Pre-requisito: container Postgres do Supabase no ar e a migration
//   20260627130200_finding_action.sql aplicada:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select to_regclass('public.finding_action')"
//
// Trava o contrato de banco que sustenta os criterios de aceite da spec
// docs/specs/73-feat-ops-executar-de-fato.md:
//   AC1  markdown reduz o sale_price via novo entity_version SCD2; a view
//        v_dia_vehicle_current reflete o novo preco; 1 finding_action 'executed'.
//   AC2  idempotencia: 2a finding_action no mesmo finding viola o UNIQUE.
//   AC3  transfer/prioritize/wholesale -> 'pending_execution'; status invalido e' rejeitado.
//   AC4  monitor -> finding_action 'executed' sem novo entity_version.
//   AC6  RLS: authenticated le so o proprio tenant e NAO pode inserir/alterar;
//        service_role tem acesso total.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// O nome do container pode ser sobrescrito via SUPABASE_DB_CONTAINER para
// ambientes de CI que provisionam um container com nome efemero; por padrao usa
// o container compartilhado local.
const CONTAINER = process.env.SUPABASE_DB_CONTAINER || 'supabase_db_dealernet-agents'

// Executa um script SQL no Postgres vivo via psql. Retorna {ok,out,err}.
// -t -A -F'|' = tuplas-only, unaligned, separador pipe (parse simples).
function psql(sql, { expectError = false } = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A', '-F', '|']
  if (!expectError) args.push('-v', 'ON_ERROR_STOP=1')
  try {
    const out = execFileSync('docker', args, { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { ok: true, out: out.trim(), err: '' }
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString().trim(), err: (e.stderr || '').toString().trim() }
  }
}

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)
const find = (out, key) => lines(out).find((l) => l.startsWith(`${key}|`))?.split('|')

// Prefacio: abre transacao e assume a claim de service_role (caminho do backend,
// que escreve as finding_action). Tudo e' revertido pelo ROLLBACK no fim.
const PREFIX = `
begin;
select set_config('request.jwt.claim.role', 'service_role', true) \\g /dev/null
`

// Semeia tenant + veiculo (entity 'vehicle' + entity_version v1) + finding
// aprovado, com proposed_action configuravel. Os ids ficam na temp table _ids.
// purchase_date = hoje-100 garante que o veiculo aparece como em_estoque na view.
function seed(action, salePrice = '100000') {
  return `
create temp table _ids on commit drop as
with t as (
  insert into tenants (tenant_key, name)
    values ('fa73-' || gen_random_uuid()::text, 'FA73 Test') returning id, tenant_key
), e as (
  insert into entities (entity_type, source_record_id)
    values ('vehicle', 'fa73-veh-' || gen_random_uuid()::text) returning id
), v as (
  insert into entity_versions (entity_id, version_number, data)
    select e.id, 1, jsonb_build_object(
      'sale_price', '${salePrice}', 'cost', '80000',
      'purchase_date', (now()::date - 100)::text,
      'status', 'em_estoque', 'brand', 'VW', 'model', 'Polo'
    ) from e returning entity_id
), f as (
  insert into finding (tenant_id, agent_key, finding_type, severity, status, fingerprint, contract_id, proposed_action)
    select t.id, 'vehicle-aging-analyst', 'stock_aging_90d', 'high', 'approved',
           'fa73-fp-' || gen_random_uuid()::text, e.id, '${action}'
    from t, e returning id, tenant_id, contract_id
)
select t.id as tenant_id, t.tenant_key as tenant_key, e.id as vehicle_id, f.id as finding_id
from t, e, f;
`
}

// ---------------------------------------------------------------------------
// AC1: markdown reduz o sale_price via novo entity_version SCD2 (preco antigo
//      preservado no historico), a view v_dia_vehicle_current reflete o novo
//      preco, e ha exatamente 1 finding_action 'executed' com payload before/after.
// ---------------------------------------------------------------------------
test('AC1 markdown: novo entity_version reduz preco em 10%, view reflete e finding_action=executed', () => {
  const { ok, out, err } = psql(`${PREFIX}${seed('markdown')}
-- preco corrente antes da execucao
select 'price_before', sale_price from v_dia_vehicle_current where entity_id = (select vehicle_id from _ids);

-- SIMULA o efeito do backend (execute_finding_action -> markdown):
-- 1) novo entity_version com sale_price = round(old*0.9, 2)
insert into entity_versions (entity_id, version_number, data)
  select _ids.vehicle_id, 2,
         jsonb_set(ev.data, '{sale_price}',
                   to_jsonb(round((ev.data->>'sale_price')::numeric * (1 - 0.10), 2)::text))
  from _ids join entity_versions ev on ev.entity_id = _ids.vehicle_id and ev.version_number = 1;
-- 2) registro auditavel finding_action 'executed'
insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status, payload)
  select tenant_id, finding_id, vehicle_id, 'markdown', 'executed',
         jsonb_build_object('old_sale_price', 100000, 'new_sale_price', 90000, 'markdown_pct', 0.10)
  from _ids;

-- a view (preco corrente do negocio) reflete o novo preco
select 'price_after', sale_price from v_dia_vehicle_current where entity_id = (select vehicle_id from _ids);
-- exatamente uma versao corrente
select 'current_versions', count(*) from entity_versions where entity_id = (select vehicle_id from _ids) and is_current;
-- a versao antiga foi fechada (historico preservado)
select 'old_is_current', is_current::text from entity_versions where entity_id = (select vehicle_id from _ids) and version_number = 1;
select 'old_price_preserved', data->>'sale_price' from entity_versions where entity_id = (select vehicle_id from _ids) and version_number = 1;
-- exatamente um finding_action 'executed' com payload before/after
select 'fa_count', count(*) from finding_action where finding_id = (select finding_id from _ids);
select 'fa_row', status, action_type, payload->>'old_sale_price', payload->>'new_sale_price'
  from finding_action where finding_id = (select finding_id from _ids);
rollback;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'price_before'), ['price_before', '100000'], `preco inicial inesperado; saida=${out}`)
  assert.deepEqual(find(out, 'price_after'), ['price_after', '90000.00'], `view deveria mostrar 90000 apos markdown; saida=${out}`)
  assert.deepEqual(find(out, 'current_versions'), ['current_versions', '1'], `deveria haver 1 versao corrente; saida=${out}`)
  assert.deepEqual(find(out, 'old_is_current'), ['old_is_current', 'false'], `versao antiga deveria virar is_current=false; saida=${out}`)
  assert.deepEqual(find(out, 'old_price_preserved'), ['old_price_preserved', '100000'], `historico deveria preservar o preco antigo; saida=${out}`)
  assert.deepEqual(find(out, 'fa_count'), ['fa_count', '1'], `deveria haver exatamente 1 finding_action; saida=${out}`)
  assert.deepEqual(
    find(out, 'fa_row'),
    ['fa_row', 'executed', 'markdown', '100000', '90000'],
    `finding_action de markdown inesperado; saida=${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC2: idempotencia — uma 2a finding_action no mesmo finding_id viola o UNIQUE
//      (finding_action_finding_uk), garantindo no maximo um efeito por finding.
// ---------------------------------------------------------------------------
test('AC2 idempotencia: 2a finding_action no mesmo finding_id viola o UNIQUE(finding_id)', () => {
  const { ok, out, err } = psql(`${PREFIX}${seed('markdown')}
insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status)
  select tenant_id, finding_id, vehicle_id, 'markdown', 'executed' from _ids;
create temp table _r(outcome text) on commit drop;
do $$ begin
  insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status)
    select tenant_id, finding_id, vehicle_id, 'markdown', 'executed' from _ids;
  insert into _r values ('NO_ERROR');
exception when unique_violation then insert into _r values ('UNIQUE_VIOLATION');
end $$;
select 'second_insert', outcome from _r;
select 'fa_total', count(*) from finding_action where finding_id = (select finding_id from _ids);
rollback;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'second_insert'), ['second_insert', 'UNIQUE_VIOLATION'], `2a insercao deveria violar o UNIQUE; saida=${out}`)
  assert.deepEqual(find(out, 'fa_total'), ['fa_total', '1'], `ainda deveria haver apenas 1 finding_action; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC3: transfer/prioritize_sale/wholesale_auction -> finding_action
//      'pending_execution', disposition marcada no veiculo, sale_price intacto.
//      Um status fora do dominio do check constraint e' rejeitado.
// ---------------------------------------------------------------------------
test('AC3 nao-monetario: transfer -> pending_execution, disposition marcada, preco inalterado', () => {
  const { ok, out, err } = psql(`${PREFIX}${seed('transfer')}
-- backend (disposition): novo entity_version com data.disposition, preco inalterado
insert into entity_versions (entity_id, version_number, data)
  select _ids.vehicle_id, 2, jsonb_set(ev.data, '{disposition}', to_jsonb('transfer'::text))
  from _ids join entity_versions ev on ev.entity_id = _ids.vehicle_id and ev.version_number = 1;
insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status, payload)
  select tenant_id, finding_id, vehicle_id, 'transfer', 'pending_execution', jsonb_build_object('disposition', 'transfer')
  from _ids;
select 'fa_status', status, action_type from finding_action where finding_id = (select finding_id from _ids);
select 'price_unchanged', sale_price from v_dia_vehicle_current where entity_id = (select vehicle_id from _ids);
select 'disposition_set', data->>'disposition' from entity_versions where entity_id = (select vehicle_id from _ids) and is_current;
rollback;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'fa_status'), ['fa_status', 'pending_execution', 'transfer'], `transfer deveria ficar pending_execution; saida=${out}`)
  assert.deepEqual(find(out, 'price_unchanged'), ['price_unchanged', '100000'], `sale_price NAO deveria mudar em transfer; saida=${out}`)
  assert.deepEqual(find(out, 'disposition_set'), ['disposition_set', 'transfer'], `disposition deveria estar marcada no veiculo; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC3 (cont.): o check constraint finding_action_status_chk rejeita um status
//      fora de {executed, pending_execution, failed}.
// ---------------------------------------------------------------------------
test('AC3 dominio de status: um status invalido e rejeitado pelo check constraint', () => {
  const { ok, out, err } = psql(`${PREFIX}${seed('transfer')}
create temp table _r(outcome text) on commit drop;
do $$ begin
  insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status)
    select tenant_id, finding_id, vehicle_id, 'transfer', 'bogus_status' from _ids;
  insert into _r values ('NO_ERROR');
exception when check_violation then insert into _r values ('CHECK_VIOLATION');
end $$;
select 'invalid_status', outcome from _r;
rollback;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'invalid_status'), ['invalid_status', 'CHECK_VIOLATION'], `status invalido deveria ser rejeitado; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC4: monitor -> finding_action 'executed' SEM novo entity_version (no-op
//      auditavel; o veiculo permanece na versao 1, preco intacto).
// ---------------------------------------------------------------------------
test('AC4 monitor: finding_action=executed sem novo entity_version (no-op auditavel)', () => {
  const { ok, out, err } = psql(`${PREFIX}${seed('monitor')}
-- backend (monitor): nenhuma mudanca no veiculo, apenas o registro auditavel
insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status, payload)
  select tenant_id, finding_id, vehicle_id, 'monitor', 'executed', jsonb_build_object('note', 'monitor')
  from _ids;
select 'fa_status', status, action_type from finding_action where finding_id = (select finding_id from _ids);
select 'version_count', count(*) from entity_versions where entity_id = (select vehicle_id from _ids);
select 'still_v1', version_number::text from entity_versions where entity_id = (select vehicle_id from _ids) and is_current;
select 'price_unchanged', sale_price from v_dia_vehicle_current where entity_id = (select vehicle_id from _ids);
rollback;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'fa_status'), ['fa_status', 'executed', 'monitor'], `monitor deveria ficar executed; saida=${out}`)
  assert.deepEqual(find(out, 'version_count'), ['version_count', '1'], `monitor NAO deveria criar nova entity_version; saida=${out}`)
  assert.deepEqual(find(out, 'still_v1'), ['still_v1', '1'], `veiculo deveria permanecer na versao 1; saida=${out}`)
  assert.deepEqual(find(out, 'price_unchanged'), ['price_unchanged', '100000'], `preco deveria permanecer intacto; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC6: RLS. Grants — authenticated tem SELECT mas NAO INSERT/UPDATE;
//      service_role tem INSERT. E em nivel de linha: authenticated le apenas o
//      proprio tenant (cross-tenant retorna zero) e nao consegue inserir.
// ---------------------------------------------------------------------------
test('AC6 grants: authenticated tem SELECT mas nao INSERT/UPDATE; service_role tem INSERT; RLS ligada', () => {
  const { ok, out, err } = psql(`
select 'auth_select', has_table_privilege('authenticated', 'public.finding_action', 'SELECT')::text;
select 'auth_insert', has_table_privilege('authenticated', 'public.finding_action', 'INSERT')::text;
select 'auth_update', has_table_privilege('authenticated', 'public.finding_action', 'UPDATE')::text;
select 'svc_insert', has_table_privilege('service_role', 'public.finding_action', 'INSERT')::text;
select 'rls_enabled', relrowsecurity::text from pg_class where oid = 'public.finding_action'::regclass;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'auth_select'), ['auth_select', 'true'], `authenticated deveria ter SELECT; saida=${out}`)
  assert.deepEqual(find(out, 'auth_insert'), ['auth_insert', 'false'], `authenticated NAO deveria ter INSERT; saida=${out}`)
  assert.deepEqual(find(out, 'auth_update'), ['auth_update', 'false'], `authenticated NAO deveria ter UPDATE; saida=${out}`)
  assert.deepEqual(find(out, 'svc_insert'), ['svc_insert', 'true'], `service_role deveria ter INSERT; saida=${out}`)
  assert.deepEqual(find(out, 'rls_enabled'), ['rls_enabled', 'true'], `RLS deveria estar habilitada; saida=${out}`)
})

test('AC6 row-level: authenticated le so o proprio tenant e nao consegue inserir', () => {
  const { ok, out, err } = psql(`${PREFIX}
create temp table _ids on commit drop as
with t1 as (
  insert into tenants (tenant_key, name) values ('fa73-own-' || gen_random_uuid()::text, 'own') returning id, tenant_key
), t2 as (
  insert into tenants (tenant_key, name) values ('fa73-other-' || gen_random_uuid()::text, 'other') returning id, tenant_key
), e1 as (insert into entities (entity_type, source_record_id) values ('vehicle', 'fa73-e1-' || gen_random_uuid()::text) returning id),
   e2 as (insert into entities (entity_type, source_record_id) values ('vehicle', 'fa73-e2-' || gen_random_uuid()::text) returning id),
   f1 as (insert into finding (tenant_id, agent_key, finding_type, severity, status, fingerprint, contract_id, proposed_action)
            select t1.id, 'vehicle-aging-analyst', 'stock_aging_90d', 'high', 'approved', 'fp1-' || gen_random_uuid()::text, e1.id, 'markdown' from t1, e1 returning id, tenant_id, contract_id),
   f2 as (insert into finding (tenant_id, agent_key, finding_type, severity, status, fingerprint, contract_id, proposed_action)
            select t2.id, 'vehicle-aging-analyst', 'stock_aging_90d', 'high', 'approved', 'fp2-' || gen_random_uuid()::text, e2.id, 'markdown' from t2, e2 returning id, tenant_id, contract_id),
   a1 as (insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status) select tenant_id, id, contract_id, 'markdown', 'executed' from f1 returning id),
   a2 as (insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status) select tenant_id, id, contract_id, 'markdown', 'executed' from f2 returning id)
select (select id from a1) as own_action, (select id from a2) as other_action, (select tenant_key from t1) as own_key,
       (select id from t1) as own_tenant, (select contract_id from f1) as own_vehicle;
grant select on _ids to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"app_metadata":{"role":"admin","tenant":"' || (select own_key from _ids) || '"}}', true) \\g /dev/null
select 'own_visible', count(*) from finding_action where id = (select own_action from _ids);
select 'other_visible', count(*) from finding_action where id = (select other_action from _ids);

create temp table _r(outcome text) on commit drop;
do $$ begin
  insert into finding_action (tenant_id, finding_id, vehicle_id, action_type, status)
    select own_tenant, gen_random_uuid(), own_vehicle, 'markdown', 'executed' from _ids;
  insert into _r values ('NO_ERROR');
exception when insufficient_privilege then insert into _r values ('RLS_BLOCKED');
  when others then insert into _r values ('OTHER=' || SQLSTATE);
end $$;
select 'auth_insert_attempt', outcome from _r;
rollback;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'own_visible'), ['own_visible', '1'], `authenticated deveria ver a propria linha; saida=${out}`)
  assert.deepEqual(find(out, 'other_visible'), ['other_visible', '0'], `cross-tenant deveria retornar zero; saida=${out}`)
  assert.deepEqual(find(out, 'auth_insert_attempt'), ['auth_insert_attempt', 'RLS_BLOCKED'], `authenticated NAO deveria conseguir inserir; saida=${out}`)
})
