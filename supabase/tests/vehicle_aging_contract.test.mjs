// Teste de CONTRATO SQL — Vehicle Stock-Aging Analyst (issue #32), contra o
// Postgres VIVO. Mesma estrategia do vehicle_crud.test.mjs: SEM Supabase CLI,
// SEM runner instalavel — apenas node:test + node:assert chamando o psql do
// container Docker via child_process.execFileSync.
//
// IMPORTANTE: este teste NUNCA roda `supabase db reset` (o banco e' compartilhado
// por outros pipelines). Em vez disso ele e' AUTO-CONTIDO: dentro de uma unica
// transacao BEGIN; ... ROLLBACK; aplica os artefatos do #32 (a migration de
// registry + os dois blocos DO da seed que criam os 15 veiculos demo e a config
// do agente) e SO ENTAO faz as assercoes. O ROLLBACK garante que nada e'
// persistido, entao a suite e' idempotente e segura mesmo se a seed nova ainda
// nao tiver sido aplicada ao banco vivo.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/vehicle_aging_contract.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/32-feat-ops-primeiro-agente-dia.md) que verifica.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const CONTAINER = 'supabase_db_dealernet-agents'
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

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

// Extrai um bloco `DO $$ ... $$;` da seed que contenha um marcador unico. Os
// blocos da seed usam `$$` apenas como delimitadores (sem dollar-quoting aninhado),
// entao o proximo `$$;` apos o marcador fecha o bloco de forma inequivoca.
function extractDoBlock(text, marker) {
  const mi = text.indexOf(marker)
  assert.ok(mi >= 0, `marcador nao encontrado na seed: ${marker}`)
  const start = text.lastIndexOf('DO $$', mi)
  assert.ok(start >= 0, `"DO $$" nao encontrado antes do marcador: ${marker}`)
  const endTok = text.indexOf('$$;', mi)
  assert.ok(endTok >= 0, `"$$;" nao encontrado depois do marcador: ${marker}`)
  return text.slice(start, endTok + 3)
}

const SEED = readFileSync(resolve(REPO_ROOT, 'supabase/seed.sql'), 'utf8')
const MIGRATION = readFileSync(
  resolve(REPO_ROOT, 'supabase/migrations/20260626140000_vehicle_aging_agent.sql'),
  'utf8',
)
const VEHICLE_SEED_BLOCK = extractDoBlock(SEED, 'demo-dia-vehicle-013')
const AGENT_CONFIG_SEED_BLOCK = extractDoBlock(SEED, 'vehicle_aging_finding_v1')

// Abre a transacao, assume a claim de service_role (a seed escreve sob esse guard)
// e aplica os artefatos do #32. Tudo isto e' revertido pelo ROLLBACK de cada teste.
const APPLY_FIXTURE = `
begin;
select set_config('request.jwt.claim.role', 'service_role', true) \\g /dev/null
${MIGRATION}
${VEHICLE_SEED_BLOCK}
${AGENT_CONFIG_SEED_BLOCK}
`

// Helper: roda o fixture + as assercoes em SQL, sempre com ROLLBACK no fim.
function withFixture(assertionsSql) {
  return psql(`${APPLY_FIXTURE}\n${assertionsSql}\nrollback;\n`)
}

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)
const find = (out, key) => lines(out).find((l) => l.startsWith(`${key}|`))?.split('|')

// ---------------------------------------------------------------------------
// AC: "v_dia_vehicle_current returns exactly 15 demo vehicles (001-012 + 013/014/015)."
// ---------------------------------------------------------------------------
test('AC seed: v_dia_vehicle_current tem exatamente 15 veiculos demo-dia-vehicle-%', () => {
  const { ok, out, err } = withFixture(
    `select 'count', count(*) from v_dia_vehicle_current where source_record_id like 'demo-dia-vehicle-%';`,
  )
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'count'), ['count', '15'], `esperado 15 veiculos demo; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC: "scope = em_estoque AND days_in_stock>=75, ordered by days desc -> exactly 9
//      (001/002/005/007/008/009 + 013/014/015). Excludes <75d (003/004/006/010/011)
//      and sold 012."
// ---------------------------------------------------------------------------
test('AC scope: 9 veiculos em_estoque >=75d, ordenados por days desc, sem os controles', () => {
  const { ok, out, err } = withFixture(`
select 'scope_count', count(*)
  from v_dia_vehicle_current
  where source_record_id like 'demo-dia-vehicle-%' and status = 'em_estoque' and days_in_stock >= 75;
select 'scope_ids', string_agg(right(source_record_id, 3), ',' order by days_in_stock desc)
  from v_dia_vehicle_current
  where source_record_id like 'demo-dia-vehicle-%' and status = 'em_estoque' and days_in_stock >= 75;
select 'excluded', count(*)
  from v_dia_vehicle_current
  where source_record_id in (
    'demo-dia-vehicle-003','demo-dia-vehicle-004','demo-dia-vehicle-006',
    'demo-dia-vehicle-010','demo-dia-vehicle-011','demo-dia-vehicle-012')
    and status = 'em_estoque' and days_in_stock >= 75;
select 'floor_positive', count(*)
  from v_dia_vehicle_current
  where source_record_id like 'demo-dia-vehicle-%' and status = 'em_estoque' and days_in_stock >= 75
    and floor_plan_cost > 0;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  // Exatamente 9 em escopo.
  assert.deepEqual(find(out, 'scope_count'), ['scope_count', '9'], `esperado 9 em escopo; saida=${out}`)
  // Ordem exata por days_in_stock desc (009=240,005=200,008=160,002=120,007=90,015=89,014=86,013=80,001=75).
  assert.deepEqual(
    find(out, 'scope_ids'),
    ['scope_ids', '009,005,008,002,007,015,014,013,001'],
    `ordem/ids de escopo inesperados; saida=${out}`,
  )
  // Nenhum dos controles (<75d ou vendido) entra no escopo.
  assert.deepEqual(find(out, 'excluded'), ['excluded', '0'], `controles nao deveriam entrar no escopo; saida=${out}`)
  // delta ~ floor_plan_cost: todos os 9 tem exposicao de floor-plan positiva.
  assert.deepEqual(find(out, 'floor_positive'), ['floor_positive', '9'], `floor_plan_cost deveria ser > 0; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC: "013 -> 80d, 014 -> 86d, 015 -> 89d (em_estoque)." Os dias dirigem os buckets
//      de severidade (medium/high) validados na suite Python.
// ---------------------------------------------------------------------------
test('AC novos veiculos: 013/014/015 em_estoque com days_in_stock 80/86/89', () => {
  const { ok, out, err } = withFixture(`
select right(source_record_id, 3), days_in_stock::text, status
  from v_dia_vehicle_current
  where source_record_id in ('demo-dia-vehicle-013','demo-dia-vehicle-014','demo-dia-vehicle-015')
  order by source_record_id;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  const rows = lines(out).map((l) => l.split('|'))
  assert.deepEqual(
    rows,
    [
      ['013', '80', 'em_estoque'],
      ['014', '86', 'em_estoque'],
      ['015', '89', 'em_estoque'],
    ],
    `013/014/015 deveriam ter days 80/86/89 em_estoque; saida=${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC: "ops_agent_config_current shows vehicle-aging-analyst for demo-ops-a with
//      enabled=true and schedule.enabled=false." (agenda permanece desligada)
// ---------------------------------------------------------------------------
test('AC config: vehicle-aging-analyst para demo-ops-a com enabled=true e schedule.enabled=false', () => {
  const { ok, out, err } = withFixture(`
select 'cfg',
       enabled::text,
       coalesce(schedule->>'enabled', 'null'),
       output_schema_key,
       auto_apply::text
  from ops_agent_config_current
  where agent_key = 'vehicle-aging-analyst'
    and tenant_id = (select id from tenants where tenant_key = 'demo-ops-a');
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    find(out, 'cfg'),
    ['cfg', 'true', 'false', 'vehicle_aging_finding_v1', 'false'],
    `config do agente inesperada (enabled/schedule.enabled/output_schema_key/auto_apply); saida=${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC: "the vehicle_aging_finding_v1 row exists in ops_output_schema_registry."
//      O schema registrado tem o titulo e os campos obrigatorios do modelo pydantic.
// ---------------------------------------------------------------------------
test('AC registry: ops_output_schema_registry tem vehicle_aging_finding_v1 com title e required corretos', () => {
  const { ok, out, err } = withFixture(`
select 'reg',
       schema_json->>'title',
       (schema_json->>'additionalProperties'),
       (select string_agg(value, ',' order by value)
          from jsonb_array_elements_text(schema_json->'required')) as required_keys
  from ops_output_schema_registry where schema_key = 'vehicle_aging_finding_v1';
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    find(out, 'reg'),
    ['reg', 'VehicleAgingFindingV1', 'false', 'rationale,recommended_action,vehicle_id'],
    `linha de registry inesperada; saida=${out}`,
  )
})
