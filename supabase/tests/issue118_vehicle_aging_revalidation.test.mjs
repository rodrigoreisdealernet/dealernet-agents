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
  resolve(REPO_ROOT, 'supabase/migrations/20260628120000_vehicle_aging_agent_v2.sql'),
  'utf8',
)
const AGENT_CONFIG_SEED_BLOCK = extractDoBlock(SEED, 'vehicle_aging_finding_v2')

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

// ---------------------------------------------------------------------------
// AC2 (sub-clausula de visibilidade): um achado `floor_plan_band_escalation` do agente
//      vehicle-aging-analyst, registrado como pending_approval para um tenant
//      demo, DEVE aflorar nas views de operacao consumidas pelo painel:
//        - ops_agent_status_view  (linha do agente: pending_findings, badge,
//          identified_delta)   def: migrations/20260608200000_ops_agent_identified_delta.sql:13-65
//        - ops_finding_kpis       (KPIs do tenant: pending_count, recoverable_delta)
//          def: migrations/20260607170000_ops_factory_persistence.sql:368-435
//
// Para ser pegador-de-regressao (e nao um "row existe / not null" tautologico),
// medimos um BASELINE das duas views ANTES do insert e afirmamos o DELTA exato
// que o achado provoca — se a view deixasse de refletir o achado, o delta seria
// 0 e o teste falharia. delta=12500 e' escolhido para casar identified_delta
// (status->qualquer) e recoverable_delta (status pending/approved).
// ---------------------------------------------------------------------------
test('AC2 visibilidade: achado floor_plan_band_escalation aflora em ops_agent_status_view e ops_finding_kpis', () => {
  const { ok, out, err } = withFixture(`
create temp table _bl as
select
  (select pending_findings from ops_agent_status_view v
     where v.tenant_id = (select id from tenants where tenant_key = 'demo-ops-a')
       and v.agent_key = 'vehicle-aging-analyst') as asv_pending,
  (select identified_delta from ops_agent_status_view v
     where v.tenant_id = (select id from tenants where tenant_key = 'demo-ops-a')
       and v.agent_key = 'vehicle-aging-analyst') as asv_delta,
  (select pending_count from ops_finding_kpis k
     where k.tenant_id = (select id from tenants where tenant_key = 'demo-ops-a')) as kpi_pending,
  (select recoverable_delta from ops_finding_kpis k
     where k.tenant_id = (select id from tenants where tenant_key = 'demo-ops-a')) as kpi_delta;

insert into finding (tenant_id, agent_key, finding_type, severity, status,
                     expected, billed, evidence, delta, fingerprint)
select t.id, 'vehicle-aging-analyst', 'floor_plan_band_escalation', 'high', 'pending_approval',
       '{}', '{}', '{}', 12500.00, 'issue118-aging-visibility-fixture'
  from tenants t
 where t.tenant_key = 'demo-ops-a';

select 'vis',
       (v.pending_findings - b.asv_pending)::text,        -- +1 achado pendente do agente
       (v.identified_delta - b.asv_delta)::text,          -- +12500 no identified_delta do agente
       v.has_pending_badge::text,                         -- badge de pendencia ligado
       (k.pending_count - b.kpi_pending)::text,           -- +1 no pending_count do tenant
       (k.recoverable_delta - b.kpi_delta)::text          -- +12500 no recoverable_delta do tenant
  from _bl b,
       ops_agent_status_view v,
       ops_finding_kpis k
 where v.tenant_id = (select id from tenants where tenant_key = 'demo-ops-a')
   and v.agent_key = 'vehicle-aging-analyst'
   and k.tenant_id = (select id from tenants where tenant_key = 'demo-ops-a');
`)
  assert.ok(ok, `psql falhou: ${err}`)
  // O achado recem-inserido tem que mover AMBAS as views exatamente do esperado.
  assert.deepEqual(
    find(out, 'vis'),
    ['vis', '1', '12500.00', 'true', '1', '12500.00'],
    `achado floor_plan_band_escalation nao aflorou nas views de operacao; saida=${out}`,
  )
})
