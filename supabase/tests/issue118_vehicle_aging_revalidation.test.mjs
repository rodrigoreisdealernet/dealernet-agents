// Teste de CONTRATO SQL — Revalidacao do agente vehicle-aging-analyst (issue #118),
// contra o Postgres VIVO. NON-REGRESSION: nenhum codigo de producao mudou; estes
// testes TRAVAM (lock-in) o formato seedado do agente para que uma futura
// generalizacao estilo #115 (ou qualquer reseed) nao reabilite a execucao
// recorrente nem altere os bounds/thresholds de aging.
//
// Mesma estrategia (e mesmo harness auto-contido) do vehicle_aging_contract.test.mjs:
// SEM Supabase CLI, SEM runner instalavel — apenas node:test + node:assert chamando
// o psql do container Docker. NUNCA roda `supabase db reset` (banco compartilhado);
// aplica a migration + os blocos DO da seed dentro de BEGIN; ... ROLLBACK;.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/issue118_vehicle_aging_revalidation.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/118-feat-ops-revalidar-agente-vehicle.md) que verifica.

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
  resolve(REPO_ROOT, 'supabase/migrations/20260626140001_vehicle_aging_agent.sql'),
  'utf8',
)
const AGENT_CONFIG_SEED_BLOCK = extractDoBlock(SEED, 'vehicle_aging_finding_v1')

const APPLY_FIXTURE = `
begin;
select set_config('request.jwt.claim.role', 'service_role', true) \\g /dev/null
${MIGRATION}
${AGENT_CONFIG_SEED_BLOCK}
`

function withFixture(assertionsSql) {
  return psql(`${APPLY_FIXTURE}\n${assertionsSql}\nrollback;\n`)
}

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)
const find = (out, key) => lines(out).find((l) => l.startsWith(`${key}|`))?.split('|')

// ---------------------------------------------------------------------------
// AC6: "Assist-only preservado" — o schedule recorrente do vehicle-aging-analyst
//      permanece DESABILITADO para AMBOS os tenants demo (demo-ops-a e demo-ops-b),
//      tanto na config canonica (entity store) quanto na linha de paridade da
//      base-table. Nenhuma execucao automatica e' provisionada.
// ---------------------------------------------------------------------------
test('AC6 assist-only: schedule.enabled=false p/ ambos tenants na config canonica', () => {
  const { ok, out, err } = withFixture(`
select c.agent_key || ':' || t.tenant_key as k,
       coalesce(c.schedule->>'enabled', 'null'),
       c.enabled::text,
       c.auto_apply::text
  from ops_agent_config_current c
  join tenants t on t.id = c.tenant_id
 where c.agent_key = 'vehicle-aging-analyst'
   and t.tenant_key in ('demo-ops-a','demo-ops-b')
 order by t.tenant_key;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  // schedule.enabled=false, enabled=true (assist-only), auto_apply=false (sem auto-aplicacao).
  assert.deepEqual(
    find(out, 'vehicle-aging-analyst:demo-ops-a'),
    ['vehicle-aging-analyst:demo-ops-a', 'false', 'true', 'false'],
    `config demo-ops-a inesperada; saida=${out}`,
  )
  assert.deepEqual(
    find(out, 'vehicle-aging-analyst:demo-ops-b'),
    ['vehicle-aging-analyst:demo-ops-b', 'false', 'true', 'false'],
    `config demo-ops-b inesperada; saida=${out}`,
  )
})

test('AC6 assist-only: a linha de paridade ops_agent_config tambem mantem schedule.enabled=false', () => {
  const { ok, out, err } = withFixture(`
select 'parity',
       coalesce(schedule->>'enabled', 'null'),
       auto_apply::text,
       count(*)::text
  from ops_agent_config
 where agent_key = 'vehicle-aging-analyst'
   and tenant_id in (select id from tenants where tenant_key in ('demo-ops-a','demo-ops-b'))
 group by 1, 2, 3;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  // Ambas as linhas (2 tenants) com schedule desligado e sem auto-aplicacao.
  assert.deepEqual(
    find(out, 'parity'),
    ['parity', 'false', 'false', '2'],
    `paridade base-table inesperada; saida=${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC3: "Ação recomendada válida e dedupe" depende dos thresholds de aging e dos
//      bounds de maximo por run. Trava os valores seedados: warning=75, breach=90
//      e um bound positivo de findings por run (sem auto-aplicacao).
// ---------------------------------------------------------------------------
test('AC3 config: thresholds de aging (75/90) e bound max_findings_per_run positivo seedados', () => {
  const { ok, out, err } = withFixture(`
select 'shape',
       thresholds->>'aging_warning_days',
       thresholds->>'aging_breach_days',
       bounds->>'max_findings_per_run',
       (coalesce((bounds->>'max_findings_per_run')::int, 0) > 0)::text
  from ops_agent_config_current
 where agent_key = 'vehicle-aging-analyst'
   and tenant_id = (select id from tenants where tenant_key = 'demo-ops-a');
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    find(out, 'shape'),
    ['shape', '75', '90', '50', 'true'],
    `thresholds/bounds inesperados; saida=${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC2/Non-Goal: o system prompt mantem o conjunto fechado de acoes recomendadas
//      (monitor, markdown, transfer, prioritize_sale, wholesale_auction) e proibe
//      aplicacao automatica — alinhado ao set validado na suite Python.
// ---------------------------------------------------------------------------
test('AC3 prompt: as 5 acoes recomendadas + proibicao de auto-aplicacao seguem no system prompt', () => {
  const { ok, out, err } = withFixture(`
select 'prompt',
       (system_prompt like '%monitor%')::text,
       (system_prompt like '%markdown%')::text,
       (system_prompt like '%transfer%')::text,
       (system_prompt like '%prioritize_sale%')::text,
       (system_prompt like '%wholesale_auction%')::text,
       (system_prompt like '%Never apply%')::text
  from ops_agent_config_current
 where agent_key = 'vehicle-aging-analyst'
   and tenant_id = (select id from tenants where tenant_key = 'demo-ops-a');
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    find(out, 'prompt'),
    ['prompt', 'true', 'true', 'true', 'true', 'true', 'true'],
    `system prompt nao cobre as 5 acoes + proibicao de auto-aplicacao; saida=${out}`,
  )
})
