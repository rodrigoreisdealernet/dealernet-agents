// Teste de CONTRATO SQL — Historico de execucoes por agente DIA
// (issue #128, unidade U5 — observabilidade), contra o Postgres VIVO. Mesma
// estrategia de vehicle_aging_contract.test.mjs / llm_usage_metering_contract.test.mjs:
// SEM Supabase CLI, SEM runner instalavel — apenas node:test + node:assert
// chamando o psql do container Docker via child_process.execFileSync.
//
// IMPORTANTE: o banco e' COMPARTILHADO. Este teste NUNCA reseta nem persiste
// nada: tudo roda dentro de uma unica transacao BEGIN; ... ROLLBACK; que aplica
// a migration 20260626120000_ops_agent_run_history_view.sql e SO ENTAO faz as
// assercoes. O ROLLBACK garante idempotencia mesmo que a migration ainda nao
// tenha sido aplicada ao banco vivo.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/ops_agent_run_history_contract.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/128-feat-ops-historico-de-execucoes.md) que verifica.

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

const MIGRATION = readFileSync(
  resolve(REPO_ROOT, 'supabase/migrations/20260626120000_ops_agent_run_history_view.sql'),
  'utf8',
)

// Abre a transacao e aplica a migration do #128 (create or replace view). Tudo
// e' revertido pelo ROLLBACK de cada teste.
const APPLY_FIXTURE = `begin;\n${MIGRATION}\n`

function withFixture(assertionsSql, opts = {}) {
  return psql(`${APPLY_FIXTURE}\n${assertionsSql}\nrollback;\n`, opts)
}

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)
const find = (out, key) => lines(out).find((l) => l.startsWith(`${key}|`))?.split('|')

// Fixture de dados reutilizavel: dois tenants (hist-a, hist-b), tres execucoes
// do agente "demo-agent" no tenant A (uma em andamento, sem finished_at) e uma
// execucao do MESMO agente no tenant B. Findings: 2 na run a1, 1 na run a3, 0 na
// a2 (achados de status variado para provar que a contagem e' por run_id, nao
// filtrada por status). A run do tenant B tem 1 finding so para provar isolamento.
const SEED_RUNS = `
insert into public.tenants (tenant_key, name) values ('hist-a', 'Hist A'), ('hist-b', 'Hist B');
insert into public.ops_workflow_run (run_id, tenant_id, workflow_key, started_at, finished_at, status) values
  ('h-a1', (select id from public.tenants where tenant_key = 'hist-a'), 'demo-agent', now() - interval '3 hours', now() - interval '2 hours', 'succeeded'),
  ('h-a2', (select id from public.tenants where tenant_key = 'hist-a'), 'demo-agent', now() - interval '2 hours', now() - interval '1 hour',  'failed'),
  ('h-a3', (select id from public.tenants where tenant_key = 'hist-a'), 'demo-agent', now() - interval '1 hour',  null,                       'running'),
  ('h-b1', (select id from public.tenants where tenant_key = 'hist-b'), 'demo-agent', now() - interval '90 minutes', now() - interval '80 minutes', 'succeeded');
insert into public.finding (tenant_id, agent_key, run_id, finding_type, severity, status, fingerprint) values
  ((select id from public.tenants where tenant_key = 'hist-a'), 'demo-agent', 'h-a1', 'overbilling', 'high', 'pending_approval', 'fp-a1-1'),
  ((select id from public.tenants where tenant_key = 'hist-a'), 'demo-agent', 'h-a1', 'overbilling', 'low',  'approved',         'fp-a1-2'),
  ((select id from public.tenants where tenant_key = 'hist-a'), 'demo-agent', 'h-a3', 'overbilling', 'med',  'pending_approval', 'fp-a3-1'),
  ((select id from public.tenants where tenant_key = 'hist-b'), 'demo-agent', 'h-b1', 'overbilling', 'high', 'pending_approval', 'fp-b1-1');
`

// ---------------------------------------------------------------------------
// AC1 — A view expoe as colunas de historico exigidas pela tela: agent_key
//       (alias de workflow_key), started_at, finished_at, duration, status e
//       findings_emitted (alem de run_id/tenant_id para escopo). Sem essas
//       colunas o endpoint/tela nao tem como renderizar inicio/fim/duracao/
//       status/achados.
// ---------------------------------------------------------------------------
test('AC1: ops_agent_run_history_view expoe agent_key, started_at, finished_at, duration, status, findings_emitted', () => {
  const { ok, out, err } = withFixture(`
select 'cols', string_agg(column_name, ',' order by column_name)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'ops_agent_run_history_view';
`)
  assert.ok(ok, `psql falhou: ${err || out}`)
  const cols = find(out, 'cols')?.[1]?.split(',') ?? []
  for (const required of ['agent_key', 'started_at', 'finished_at', 'duration', 'status', 'findings_emitted', 'run_id', 'tenant_id']) {
    assert.ok(cols.includes(required), `view deveria expor a coluna ${required}; colunas=${cols.join(',')}`)
  }
  // A coluna de agente DEVE ser o alias agent_key, nunca o nome cru workflow_key.
  assert.ok(!cols.includes('workflow_key'), `view nao deveria vazar workflow_key (deve ser aliased agent_key); colunas=${cols.join(',')}`)
})

// ---------------------------------------------------------------------------
// AC1 (valores) — uma linha de historico carrega os valores corretos: status da
//                 run, findings_emitted contado por run_id e duration nao-nula
//                 quando ha finished_at / nula enquanto a run esta em andamento.
// ---------------------------------------------------------------------------
test('AC1: cada linha traz status, findings_emitted por run e duration coerente com finished_at', () => {
  const { ok, out, err } = withFixture(`
${SEED_RUNS}
select 'r', run_id, status, findings_emitted, (duration is not null)::text
  from public.ops_agent_run_history_view
 where tenant_id = (select id from public.tenants where tenant_key = 'hist-a')
 order by run_id;
`)
  assert.ok(ok, `psql falhou: ${err || out}`)
  // h-a1: succeeded, 2 achados, terminou -> duration nao-nula.
  assert.deepEqual(lines(out).find((l) => l.startsWith('r|h-a1'))?.split('|'),
    ['r', 'h-a1', 'succeeded', '2', 'true'], `linha h-a1 inesperada; saida=${out}`)
  // h-a2: failed, 0 achados, terminou -> duration nao-nula.
  assert.deepEqual(lines(out).find((l) => l.startsWith('r|h-a2'))?.split('|'),
    ['r', 'h-a2', 'failed', '0', 'true'], `linha h-a2 inesperada; saida=${out}`)
  // h-a3: running, 1 achado, SEM finished_at -> duration nula.
  assert.deepEqual(lines(out).find((l) => l.startsWith('r|h-a3'))?.split('|'),
    ['r', 'h-a3', 'running', '1', 'false'], `linha h-a3 inesperada; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC2 — Ordenacao cronologica: as execucoes saem da mais recente para a mais
//       antiga por started_at. (A view nao impoe ORDER BY; a ordem e' do
//       consumidor — mas o consumidor consegue ordenar de forma determinista.)
// ---------------------------------------------------------------------------
test('AC2: select ... order by started_at desc devolve as runs da mais recente para a mais antiga', () => {
  const { ok, out, err } = withFixture(`
${SEED_RUNS}
select 'ord', string_agg(run_id, ',') from (
  select run_id
    from public.ops_agent_run_history_view
   where tenant_id = (select id from public.tenants where tenant_key = 'hist-a')
     and agent_key = 'demo-agent'
   order by started_at desc
) s;
`)
  assert.ok(ok, `psql falhou: ${err || out}`)
  // h-a3 (1h atras) > h-a2 (2h) > h-a1 (3h).
  assert.deepEqual(find(out, 'ord'), ['ord', 'h-a3,h-a2,h-a1'], `ordem cronologica desc inesperada; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC3 — Contagem coerente apos multiplas execucoes: 3 runs de um agente => 3
//       linhas, cada uma com o status correto e a contagem de achados daquela
//       execucao. (Prova que findings_emitted nao "vaza" de uma run para outra.)
// ---------------------------------------------------------------------------
test('AC3: 3 execucoes de demo-agent => 3 linhas com status e findings_emitted por run', () => {
  const { ok, out, err } = withFixture(`
${SEED_RUNS}
select 'total', count(*)
  from public.ops_agent_run_history_view
 where tenant_id = (select id from public.tenants where tenant_key = 'hist-a')
   and agent_key = 'demo-agent';
-- Soma dos achados emitidos deve bater com os 3 findings semeados para o tenant A.
select 'sum_findings', sum(findings_emitted)
  from public.ops_agent_run_history_view
 where tenant_id = (select id from public.tenants where tenant_key = 'hist-a')
   and agent_key = 'demo-agent';
`)
  assert.ok(ok, `psql falhou: ${err || out}`)
  assert.deepEqual(find(out, 'total'), ['total', '3'], `esperado exatamente 3 linhas para demo-agent/tenant A; saida=${out}`)
  // 2 (h-a1) + 0 (h-a2) + 1 (h-a3) = 3 achados emitidos no total.
  assert.deepEqual(find(out, 'sum_findings'), ['sum_findings', '3'], `soma de findings_emitted deveria ser 3; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC4 — Isolamento por concessionaria (tenant-scoped). A view e' security_invoker;
//       sob o claim do tenant A (role authenticated) so as runs do tenant A
//       aparecem — a run do tenant B nunca vaza. Tambem confirma que a view
//       carrega tenant_id e que filtrar por tenant isola as linhas.
// ---------------------------------------------------------------------------
test('AC4: sob claim do tenant A, a view so mostra runs do tenant A (run do tenant B nunca vaza)', () => {
  const { ok, out, err } = withFixture(`
${SEED_RUNS}
set local role authenticated;
select set_config('request.jwt.claims', '{"app_metadata":{"role":"admin","tenant":"hist-a"}}', true);
-- Total visivel: apenas as 3 runs do tenant A (a run h-b1 do tenant B deve sumir).
select 'vis_total', count(*) from public.ops_agent_run_history_view;
-- Nenhuma linha de outro tenant pode aparecer.
select 'vis_foreign', count(*)
  from public.ops_agent_run_history_view
 where tenant_id <> (select id from public.tenants where tenant_key = 'hist-a');
-- A run do tenant B especificamente nao aparece.
select 'vis_b_run', count(*)
  from public.ops_agent_run_history_view where run_id = 'h-b1';
reset role;
`)
  assert.ok(ok, `psql falhou: ${err || out}`)
  assert.deepEqual(find(out, 'vis_total'), ['vis_total', '3'], `tenant A deveria ver 3 runs; saida=${out}`)
  assert.deepEqual(find(out, 'vis_foreign'), ['vis_foreign', '0'], `claim do tenant A nao deveria ver runs de outro tenant; saida=${out}`)
  assert.deepEqual(find(out, 'vis_b_run'), ['vis_b_run', '0'], `run do tenant B nunca deveria aparecer sob o claim do tenant A; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC5 — Somente leitura: anon nao tem nenhum acesso (revoke all); authenticated
//       e service_role podem LER (SELECT) mas NAO tem nenhum privilegio de
//       mutacao de dados (INSERT/UPDATE/DELETE). Garante que a superficie de
//       historico e' estritamente de leitura no proprio banco.
// ---------------------------------------------------------------------------
test('AC5: grants read-only — anon sem acesso; authenticated/service_role com SELECT e sem INSERT/UPDATE/DELETE', () => {
  const writePrivs = `('INSERT', 'UPDATE', 'DELETE')`
  const { ok, out, err } = withFixture(`
-- anon: nenhum privilegio na view.
select 'anon_any', count(*)
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'ops_agent_run_history_view' and grantee = 'anon';
-- authenticated/service_role: precisam ter SELECT...
select 'auth_select', count(*)
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'ops_agent_run_history_view'
   and grantee = 'authenticated' and privilege_type = 'SELECT';
select 'svc_select', count(*)
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'ops_agent_run_history_view'
   and grantee = 'service_role' and privilege_type = 'SELECT';
-- ...e NAO podem ter nenhum privilegio de mutacao de dados.
select 'auth_write', count(*)
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'ops_agent_run_history_view'
   and grantee = 'authenticated' and privilege_type in ${writePrivs};
select 'svc_write', count(*)
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'ops_agent_run_history_view'
   and grantee = 'service_role' and privilege_type in ${writePrivs};
`)
  assert.ok(ok, `psql falhou: ${err || out}`)
  assert.deepEqual(find(out, 'anon_any'), ['anon_any', '0'], `anon nao deveria ter nenhum privilegio na view; saida=${out}`)
  assert.deepEqual(find(out, 'auth_select'), ['auth_select', '1'], `authenticated deveria ter SELECT; saida=${out}`)
  assert.deepEqual(find(out, 'svc_select'), ['svc_select', '1'], `service_role deveria ter SELECT; saida=${out}`)
  assert.deepEqual(find(out, 'auth_write'), ['auth_write', '0'], `authenticated nao deveria ter INSERT/UPDATE/DELETE; saida=${out}`)
  assert.deepEqual(find(out, 'svc_write'), ['svc_write', '0'], `service_role nao deveria ter INSERT/UPDATE/DELETE; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC7 — Sem regressao: a ops_agent_status_view continua existindo, com o mesmo
//       conjunto de colunas, e seus KPIs (total_runs/succeeded_runs/failed_runs/
//       pending_findings) ainda computam corretamente apos aplicar a migration
//       do #128 (que e' puramente aditiva). Um drop/alter acidental ou colisao
//       de nome seria pego aqui.
// ---------------------------------------------------------------------------
test('AC7: ops_agent_status_view mantem o shape de colunas apos a migration do #128', () => {
  const { ok, out, err } = withFixture(`
select 'cols', string_agg(column_name, ',' order by column_name)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'ops_agent_status_view';
`)
  assert.ok(ok, `psql falhou: ${err || out}`)
  const cols = (find(out, 'cols')?.[1] ?? '').split(',').sort()
  const expected = [
    'agent_key', 'auto_apply', 'enabled', 'failed_runs', 'has_pending_badge',
    'identified_delta', 'last_run_finished_at', 'last_run_id', 'last_run_started_at',
    'last_run_status', 'next_run_at', 'pending_findings', 'succeeded_runs', 'tenant_id',
    'total_runs',
  ].sort()
  assert.deepEqual(cols, expected, `colunas da ops_agent_status_view mudaram (regressao); saida=${out}`)
})

test('AC7: KPIs de ops_agent_status_view (total/succeeded/failed/pending) continuam corretos', () => {
  const { ok, out, err } = withFixture(`
insert into public.tenants (tenant_key, name) values ('kpi-t', 'KPI T');
-- Config do agente vive no entity store (entities + entity_versions); a
-- ops_agent_config_current le dali. Semeamos uma config minima para o agente.
with e as (
  insert into public.entities (entity_type, source_record_id)
  select 'agent_config', (select id from public.tenants where tenant_key = 'kpi-t')::text || ':kpi-agent'
  returning id
)
insert into public.entity_versions (entity_id, version_number, data)
select (select id from e), 1, jsonb_build_object(
  'tenant_id', (select id from public.tenants where tenant_key = 'kpi-t'),
  'agent_key', 'kpi-agent', 'enabled', true, 'auto_apply', false);
-- 3 runs: 2 succeeded, 1 failed.
insert into public.ops_workflow_run (run_id, tenant_id, workflow_key, started_at, finished_at, status) values
  ('kpi-r1', (select id from public.tenants where tenant_key = 'kpi-t'), 'kpi-agent', now() - interval '3 hours', now() - interval '2 hours', 'succeeded'),
  ('kpi-r2', (select id from public.tenants where tenant_key = 'kpi-t'), 'kpi-agent', now() - interval '2 hours', now() - interval '1 hour',  'succeeded'),
  ('kpi-r3', (select id from public.tenants where tenant_key = 'kpi-t'), 'kpi-agent', now() - interval '1 hour',  null,                       'failed');
-- 1 finding pendente.
insert into public.finding (tenant_id, agent_key, run_id, finding_type, severity, status, fingerprint) values
  ((select id from public.tenants where tenant_key = 'kpi-t'), 'kpi-agent', 'kpi-r1', 'overbilling', 'high', 'pending_approval', 'fp-kpi-1');
select 'kpi', total_runs, succeeded_runs, failed_runs, pending_findings
  from public.ops_agent_status_view
 where tenant_id = (select id from public.tenants where tenant_key = 'kpi-t')
   and agent_key = 'kpi-agent';
`)
  assert.ok(ok, `psql falhou: ${err || out}`)
  assert.deepEqual(
    find(out, 'kpi'),
    ['kpi', '3', '2', '1', '1'],
    `KPIs da ops_agent_status_view mudaram (regressao): total=3, succeeded=2, failed=1, pending=1; saida=${out}`,
  )
})
