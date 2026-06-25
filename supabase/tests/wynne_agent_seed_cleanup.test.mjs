// Teste de CONTRATO SQL — cleanup de agentes Wynne removidos do seed (issue #60),
// contra o Postgres VIVO. Mesma estrategia do vehicle_crud.test.mjs: SEM Supabase
// CLI, SEM runner instalavel — apenas node:test + node:assert chamando psql no
// container Docker.
//
// IMPORTANTE: este teste NUNCA roda `supabase db reset` (o banco e' compartilhado).
// O arquivo seed.sql contem seus proprios BEGIN/COMMIT; para manter o teste seguro,
// a harness remove somente essas linhas de controle transacional, envolve o seed
// inteiro em BEGIN ... ROLLBACK e aplica o seed duas vezes antes das assercoes.
// O seed nao cria findings de vehicle-aging-analyst; por isso AC3 (findings
// "permanecem") e' provado com uma fixture inserida antes do replay final, que
// a limpeza escopada dos agentes Wynne NAO deve apagar.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/wynne_agent_seed_cleanup.test.mjs
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

const SEED = readFileSync(resolve(REPO_ROOT, 'supabase/seed.sql'), 'utf8')

// seed.sql tem transacoes internas; remove apenas linhas standalone begin;/commit;
// para que o ROLLBACK externo continue protegendo o banco compartilhado.
const SEED_IN_ROLLBACK = SEED.replace(/^\s*(begin|commit);\s*$/gim, '-- transaction control stripped by test harness')

const REMOVED_AGENT_KEYS = [
  'revrec-analyst',
  'fleet-auditor',
  'credit-analyst',
  'account-health-queue',
  'territory-account-brief',
]
const REMOVED_AGENT_LIST_SQL = REMOVED_AGENT_KEYS.map((key) => `'${key}'`).join(',')
const VEHICLE_AGENT_KEY = 'vehicle-aging-analyst'

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)
const find = (out, key) => lines(out).find((l) => l.startsWith(`${key}|`))?.split('|')

function withSeedReplay(assertionsSql) {
  return psql(`begin;
${SEED_IN_ROLLBACK}
insert into finding (tenant_id, agent_key, finding_type, severity, fingerprint)
values ((select id from tenants where tenant_key = 'demo-ops-a'),
        '${VEHICLE_AGENT_KEY}', 'aging', 'medium', 'test-va-fixture-1');
${SEED_IN_ROLLBACK}
${assertionsSql}
rollback;
`)
}

test('AC #60: seed replay remove agentes Wynne e preserva vehicle-aging-analyst', () => {
  const { ok, out, err } = withSeedReplay(`
select 'ops_agent_config_removed', count(*)
  from ops_agent_config
  where agent_key in (${REMOVED_AGENT_LIST_SQL});
select 'ops_agent_config_current_removed', count(*)
  from ops_agent_config_current
  where agent_key in (${REMOVED_AGENT_LIST_SQL});
select 'ops_agent_config_current_vehicle', count(*)
  from ops_agent_config_current
  where agent_key = '${VEHICLE_AGENT_KEY}';
select 'finding_removed', count(*)
  from finding
  where agent_key in (${REMOVED_AGENT_LIST_SQL});
select 'finding_vehicle_fixture', count(*)
  from finding
  where agent_key = '${VEHICLE_AGENT_KEY}'
    and fingerprint = 'test-va-fixture-1';
select 'ops_agent_status_view_removed', count(*)
  from ops_agent_status_view
  where agent_key in (${REMOVED_AGENT_LIST_SQL});
select 'ops_findings_view_removed', count(*)
  from ops_findings_view
  where agent_key in (${REMOVED_AGENT_LIST_SQL});
`)

  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'ops_agent_config_removed'), ['ops_agent_config_removed', '0'], `ops_agent_config deveria limpar agentes Wynne; saida=${out}`)
  assert.deepEqual(
    find(out, 'ops_agent_config_current_removed'),
    ['ops_agent_config_current_removed', '0'],
    `ops_agent_config_current deveria limpar agentes Wynne; saida=${out}`,
  )
  assert.ok(
    Number(find(out, 'ops_agent_config_current_vehicle')?.[1] ?? 0) > 0,
    `vehicle-aging-analyst deveria permanecer em ops_agent_config_current; saida=${out}`,
  )
  assert.deepEqual(find(out, 'finding_removed'), ['finding_removed', '0'], `finding deveria limpar agentes Wynne; saida=${out}`)
  assert.deepEqual(
    find(out, 'finding_vehicle_fixture'),
    ['finding_vehicle_fixture', '1'],
    `fixture de finding vehicle-aging-analyst deveria sobreviver ao replay final do seed; saida=${out}`,
  )
  assert.deepEqual(
    find(out, 'ops_agent_status_view_removed'),
    ['ops_agent_status_view_removed', '0'],
    `ops_agent_status_view nao deveria expor agentes Wynne; saida=${out}`,
  )
  assert.deepEqual(
    find(out, 'ops_findings_view_removed'),
    ['ops_findings_view_removed', '0'],
    `ops_findings_view nao deveria expor agentes Wynne; saida=${out}`,
  )
})
