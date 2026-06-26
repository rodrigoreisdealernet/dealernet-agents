// Teste de CONTRATO SQL — Vehicle Inventory Analyst (analise antecipatoria),
// contra o Postgres VIVO. Mesma estrategia do vehicle_crud.test.mjs: SEM Supabase
// CLI, SEM runner instalavel — apenas node:test + node:assert chamando o psql do
// container Docker via child_process.execFileSync.
//
// IMPORTANTE: este teste NUNCA roda `supabase db reset` (o banco e' compartilhado
// por outros pipelines). Em vez disso ele e' AUTO-CONTIDO: dentro de uma unica
// transacao BEGIN; ... ROLLBACK; aplica os artefatos (a migration de registry v2
// + os dois blocos DO da seed que criam os 15 veiculos demo e a config do agente)
// e SO ENTAO faz as assercoes. O ROLLBACK garante que nada e' persistido.
//
// A LOGICA DE ESCOPO (quais veiculos viram finding) agora vive no motor de sinais
// em Python (temporal/src/agents/vehicle_inventory_signals.py) e e' coberta por
// temporal/tests/test_vehicle_inventory_signals.py + test_ops_vehicle_aging.py.
// Este teste de contrato cobre apenas os fatos a NIVEL DE BANCO: a view de
// veiculos, a config v2 do agente e a linha de registry do schema v2.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/vehicle_aging_contract.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const CONTAINER = 'supabase_db_dealernet-agents'
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

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

// Extrai um bloco `DO $$ ... $$;` da seed que contenha um marcador unico.
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
  resolve(REPO_ROOT, 'supabase/migrations/20260628120000_vehicle_aging_agent_v2.sql'),
  'utf8',
)
const VEHICLE_SEED_BLOCK = extractDoBlock(SEED, 'demo-dia-vehicle-013')
const AGENT_CONFIG_SEED_BLOCK = extractDoBlock(SEED, 'vehicle_aging_finding_v2')

const APPLY_FIXTURE = `
begin;
select set_config('request.jwt.claim.role', 'service_role', true) \\g /dev/null
${MIGRATION}
${VEHICLE_SEED_BLOCK}
${AGENT_CONFIG_SEED_BLOCK}
`

function withFixture(assertionsSql) {
  return psql(`${APPLY_FIXTURE}\n${assertionsSql}\nrollback;\n`)
}

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)
const find = (out, key) => lines(out).find((l) => l.startsWith(`${key}|`))?.split('|')

// ---------------------------------------------------------------------------
// AC: a seed cria exatamente 15 veiculos demo na view de veiculos.
// ---------------------------------------------------------------------------
test('AC seed: v_dia_vehicle_current tem exatamente 15 veiculos demo-dia-vehicle-%', () => {
  const { ok, out, err } = withFixture(
    `select 'count', count(*) from v_dia_vehicle_current where source_record_id like 'demo-dia-vehicle-%';`,
  )
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'count'), ['count', '15'], `esperado 15 veiculos demo; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC: o controle "velho mas saudavel" (009) existe em estoque com 240 dias e
//     margem ampla (sale_price - cost). Prova de que o dataset inclui um veiculo
//     ANTIGO que NAO deve gerar finding — "velho" sozinho nao basta. (A decisao
//     de nao-escopo e' validada nos testes Python do motor de sinais.)
// ---------------------------------------------------------------------------
test('AC controle: 009 em_estoque ~240d com margem ampla (velho porem saudavel)', () => {
  const { ok, out, err } = withFixture(`
select 'ctl',
       status,
       (days_in_stock >= 240)::text,
       ((sale_price - cost) >= 25000)::text
  from v_dia_vehicle_current
  where source_record_id = 'demo-dia-vehicle-009';
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    find(out, 'ctl'),
    ['ctl', 'em_estoque', 'true', 'true'],
    `009 deveria ser em_estoque, >=240d e margem ampla; saida=${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC: o dataset cobre os tres problemas antecipatorios — ha veiculos perto de uma
//     borda de faixa de floor plan, com margem fina, e novos de ano-modelo
//     anterior (carryover). Verificacao a nivel de dados (a classificacao em si
//     e' Python): existe pelo menos 1 novo com model_year < ano corrente.
// ---------------------------------------------------------------------------
test('AC carryover: ha veiculo novo com model_year abaixo do ano corrente', () => {
  const { ok, out, err } = withFixture(`
select 'carry', count(*)
  from v_dia_vehicle_current
  where source_record_id like 'demo-dia-vehicle-%'
    and status = 'em_estoque'
    and condition = 'novo'
    and model_year < extract(year from now())::int;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  const row = find(out, 'carry')
  assert.ok(row && Number(row[1]) >= 1, `esperado >=1 novo carryover; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC config: vehicle-aging-analyst para demo-ops-a com enabled=true,
//            schedule.enabled=false, output_schema_key=v2 e thresholds.floor_plan.
// ---------------------------------------------------------------------------
test('AC config: vehicle-aging-analyst v2 para demo-ops-a (schema v2 + floor_plan thresholds)', () => {
  const { ok, out, err } = withFixture(`
select 'cfg',
       enabled::text,
       coalesce(schedule->>'enabled', 'null'),
       output_schema_key,
       auto_apply::text,
       (thresholds ? 'floor_plan')::text
  from ops_agent_config_current
  where agent_key = 'vehicle-aging-analyst'
    and tenant_id = (select id from tenants where tenant_key = 'demo-ops-a');
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    find(out, 'cfg'),
    ['cfg', 'true', 'false', 'vehicle_aging_finding_v2', 'false', 'true'],
    `config do agente inesperada; saida=${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC registry: ops_output_schema_registry tem vehicle_aging_finding_v2 com title
//              VehicleAgingFindingV2, required corretos, propriedade `signals` e
//              SEM o artefato legado `aging_bucket`.
// ---------------------------------------------------------------------------
test('AC registry: vehicle_aging_finding_v2 com title/required/signals e sem aging_bucket', () => {
  const { ok, out, err } = withFixture(`
select 'reg',
       schema_json->>'title',
       (schema_json->>'additionalProperties'),
       (select string_agg(value, ',' order by value)
          from jsonb_array_elements_text(schema_json->'required')) as required_keys,
       (schema_json->'properties' ? 'signals')::text,
       (schema_json->'properties' ? 'aging_bucket')::text
  from ops_output_schema_registry where schema_key = 'vehicle_aging_finding_v2';
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    find(out, 'reg'),
    ['reg', 'VehicleAgingFindingV2', 'false', 'rationale,recommended_action,vehicle_id', 'true', 'false'],
    `linha de registry inesperada; saida=${out}`,
  )
})
