// Teste de CONTRATO SQL — LLM usage metering (issue #70, T-008), contra o
// Postgres VIVO. Mesma estrategia de vehicle_aging_contract.test.mjs / ops_credit_proposal.sql:
// SEM Supabase CLI, SEM `supabase db reset` — apenas node:test + node:assert
// chamando o psql do container Docker via child_process.execFileSync.
//
// IMPORTANTE: o banco e' COMPARTILHADO. Este teste NUNCA reseta nem persiste nada:
// tudo roda dentro de uma unica transacao BEGIN; ... ROLLBACK; que aplica a
// migration 20260627130000_llm_usage_metering.sql e SO ENTAO faz as assercoes.
// O ROLLBACK garante idempotencia e seguranca mesmo que a migration ainda nao
// tenha sido aplicada ao banco vivo.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/llm_usage_metering_contract.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/70-feat-temporal-supabase-metering-de.md) que verifica.

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
// -t -A -F'|' = tuplas-only, unaligned, separador pipe (parse simples). Notices
// vao para stderr (err), valores selecionados para stdout (out).
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
  resolve(REPO_ROOT, 'supabase/migrations/20260627130000_llm_usage_metering.sql'),
  'utf8',
)

// Abre a transacao e aplica a migration do #70 (idempotente). Tudo e' revertido
// pelo ROLLBACK de cada teste.
const APPLY_FIXTURE = `begin;\n${MIGRATION}\n`

function withFixture(assertionsSql, opts = {}) {
  return psql(`${APPLY_FIXTURE}\n${assertionsSql}\nrollback;\n`, opts)
}

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)
const find = (out, key) => lines(out).find((l) => l.startsWith(`${key}|`))?.split('|')

// ---------------------------------------------------------------------------
// AC-007 — Isolamento multi-tenant (RLS): authenticated NAO insere e so le o
//          proprio tenant; service_role insere/le.
// ---------------------------------------------------------------------------
test('AC-007: authenticated INSERT em ops_llm_usage_event e negado e SELECT so ve o tenant do claim', () => {
  const { ok, out, err } = withFixture(`
-- Dois tenants distintos; service_role (write path do worker) grava um evento p/ cada.
insert into public.tenants (tenant_key, name) values ('llm-rls-a', 'LLM RLS A'), ('llm-rls-b', 'LLM RLS B');

set local role service_role;
insert into public.ops_llm_usage_event
    (tenant_id, agent_key, idempotency_key, metering_status, chargeable, provider_cost_usd, billable_cost_usd)
  values
    ((select id from public.tenants where tenant_key = 'llm-rls-a'), 'credit-analyst', 'rls-a', 'ok', true, 0.0012, 0.00156),
    ((select id from public.tenants where tenant_key = 'llm-rls-b'), 'credit-analyst', 'rls-b', 'ok', true, 0.0012, 0.00156);
reset role;

-- Authenticated, claim do tenant A.
set local role authenticated;
select set_config('request.jwt.claims', '{"app_metadata":{"role":"admin","tenant":"llm-rls-a"}}', true);

-- INSERT deve ser NEGADO (sem grant de insert p/ authenticated). Se passar, e' violacao.
do $$
declare v_denied boolean := false;
begin
  begin
    insert into public.ops_llm_usage_event (tenant_id, agent_key, idempotency_key)
      values ((select id from public.tenants where tenant_key = 'llm-rls-a'), 'credit-analyst', 'rls-attempt');
  exception
    when insufficient_privilege then v_denied := true;
    when sqlstate '42501'       then v_denied := true;
  end;
  if not v_denied then
    raise exception 'AC-007: authenticated INSERT into ops_llm_usage_event was NOT denied';
  end if;
end $$;

-- SELECT: o claim do tenant A so ve a propria linha (1), nenhuma de outro tenant (0).
select 'visible_total', count(*) from public.ops_llm_usage_event;
select 'visible_foreign', count(*)
  from public.ops_llm_usage_event
  where tenant_id <> (select id from public.tenants where tenant_key = 'llm-rls-a');
reset role;
`)
  // psql so termina ok se o DO block NAO levantou excecao (i.e. o insert foi negado).
  assert.ok(ok, `AC-007 falhou (insert authenticated nao foi negado ou erro inesperado): ${err || out}`)
  assert.deepEqual(find(out, 'visible_total'), ['visible_total', '1'], `tenant A deveria ver 1 linha; saida=${out}`)
  assert.deepEqual(
    find(out, 'visible_foreign'),
    ['visible_foreign', '0'],
    `claim do tenant A nao deveria ver linhas de outro tenant; saida=${out}`,
  )
})

test('AC-007: service_role enxerga ambos os tenants (write path nao e tenant-scoped)', () => {
  const { ok, out, err } = withFixture(`
insert into public.tenants (tenant_key, name) values ('llm-rls-a', 'LLM RLS A'), ('llm-rls-b', 'LLM RLS B');
set local role service_role;
insert into public.ops_llm_usage_event
    (tenant_id, agent_key, idempotency_key, metering_status, chargeable, provider_cost_usd, billable_cost_usd)
  values
    ((select id from public.tenants where tenant_key = 'llm-rls-a'), 'credit-analyst', 'svc-a', 'ok', true, 0.0012, 0.00156),
    ((select id from public.tenants where tenant_key = 'llm-rls-b'), 'credit-analyst', 'svc-b', 'ok', true, 0.0012, 0.00156);
select 'svc_total', count(*) from public.ops_llm_usage_event where idempotency_key in ('svc-a', 'svc-b');
reset role;
`)
  assert.ok(ok, `service_role write/read falhou: ${err || out}`)
  assert.deepEqual(find(out, 'svc_total'), ['svc_total', '2'], `service_role deveria ver as 2 linhas; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC-006 — Sem dupla contagem (camada DB): o mesmo idempotency_key gravado duas
//          vezes pelo MESMO caminho on_conflict que a activity usa
//          (PostgREST upsert on_conflict=idempotency_key == SQL `on conflict
//          (idempotency_key) do update`) deixa EXATAMENTE 1 linha, sem erro.
//          Prova que a constraint unique(idempotency_key) existe e que o alvo do
//          on_conflict bate com ela (um desalinhamento passaria verde nos fakes).
// ---------------------------------------------------------------------------
test('AC-006: upsert on_conflict(idempotency_key) duas vezes deixa 1 linha e atualiza campos', () => {
  const { ok, out, err } = withFixture(`
insert into public.tenants (tenant_key, name) values ('llm-idem-t', 'LLM Idem T');
set local role service_role;

-- 1a gravacao do evento (custo ainda nao precificado).
insert into public.ops_llm_usage_event
    (tenant_id, agent_key, idempotency_key, metering_status, chargeable, prompt_tokens, completion_tokens, provider_cost_usd, billable_cost_usd)
  values
    ((select id from public.tenants where tenant_key = 'llm-idem-t'), 'credit-analyst', 'idem-key-1', 'ok', true, 1000, 500, null, null)
  on conflict (idempotency_key) do update
    set prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        provider_cost_usd = excluded.provider_cost_usd,
        billable_cost_usd = excluded.billable_cost_usd;

-- 2a gravacao (retry da activity, MESMO idempotency_key) agora com custo precificado.
insert into public.ops_llm_usage_event
    (tenant_id, agent_key, idempotency_key, metering_status, chargeable, prompt_tokens, completion_tokens, provider_cost_usd, billable_cost_usd)
  values
    ((select id from public.tenants where tenant_key = 'llm-idem-t'), 'credit-analyst', 'idem-key-1', 'ok', true, 1000, 512, 0.0012, 0.00156)
  on conflict (idempotency_key) do update
    set prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        provider_cost_usd = excluded.provider_cost_usd,
        billable_cost_usd = excluded.billable_cost_usd;

-- Exatamente 1 linha para esse idempotency_key, com os campos do merge.
select 'idem_rows', count(*) from public.ops_llm_usage_event where idempotency_key = 'idem-key-1';
select 'idem_merged', completion_tokens, provider_cost_usd, billable_cost_usd
  from public.ops_llm_usage_event where idempotency_key = 'idem-key-1';
reset role;
`)
  assert.ok(ok, `AC-006 upsert idempotente falhou (constraint/on_conflict ausente?): ${err || out}`)
  assert.deepEqual(find(out, 'idem_rows'), ['idem_rows', '1'], `esperado exatamente 1 linha apos 2 upserts; saida=${out}`)
  const merged = find(out, 'idem_merged')
  assert.ok(merged, `linha merged ausente; saida=${out}`)
  const [, completionTokens, providerCost, billableCost] = merged
  // O merge atualizou de fato os campos (nao foi no-op de identidade).
  assert.equal(completionTokens, '512', `completion_tokens deveria refletir o 2o upsert; saida=${out}`)
  assert.ok(Math.abs(parseFloat(providerCost) - 0.0012) < 1e-9, `provider_cost_usd deveria virar 0.0012; obtido=${providerCost}`)
  assert.ok(Math.abs(parseFloat(billableCost) - 0.00156) < 1e-9, `billable_cost_usd deveria virar 0.00156; obtido=${billableCost}`)
})

// ---------------------------------------------------------------------------
// AC-008 — Rollup por cliente/dia: 2 eventos cobraveis (T,D) -> 1 linha com as
//          somas; eventos 'missing' e nao-cobraveis ficam de fora.
// ---------------------------------------------------------------------------
test('AC-008: ops_llm_cost_by_tenant_day agrega 2 eventos cobraveis em 1 linha com as somas', () => {
  const { ok, out, err } = withFixture(`
insert into public.tenants (tenant_key, name) values ('llm-day-t', 'LLM Day T');

-- service_role grava: 2 eventos cobraveis (entram no rollup) + 1 'missing' + 1
-- nao-cobravel (ambos devem ser EXCLUIDOS do rollup cobravel).
set local role service_role;
insert into public.ops_llm_usage_event
    (tenant_id, agent_key, idempotency_key, metering_status, chargeable, provider_cost_usd, billable_cost_usd)
  values
    ((select id from public.tenants where tenant_key = 'llm-day-t'), 'credit-analyst', 'day-1', 'ok', true, 0.0012, 0.00156),
    ((select id from public.tenants where tenant_key = 'llm-day-t'), 'credit-analyst', 'day-2', 'ok', true, 0.0024, 0.00312),
    -- 'missing': sem tokens/custo -> nao cobravel no rollup (AC-002).
    ((select id from public.tenants where tenant_key = 'llm-day-t'), 'credit-analyst', 'day-missing', 'missing', true, null, null),
    -- schema_repair: provider cost > 0 mas chargeable=false (AC-005) -> fora do rollup cobravel.
    ((select id from public.tenants where tenant_key = 'llm-day-t'), 'credit-analyst', 'day-repair', 'ok', false, 0.0005, 0.0005);
reset role;

-- A view e' security_invoker e nao foi concedida a service_role; o owner (runner
-- da migration) le o rollup para asserir a agregacao.
select 'rows', count(*) from public.ops_llm_cost_by_tenant_day
  where tenant_id = (select id from public.tenants where tenant_key = 'llm-day-t');
select 'agg', event_count, provider_cost_usd, billable_cost_usd
  from public.ops_llm_cost_by_tenant_day
  where tenant_id = (select id from public.tenants where tenant_key = 'llm-day-t');
`)
  assert.ok(ok, `AC-008 psql falhou: ${err || out}`)
  // Os 4 eventos sao do mesmo tenant/dia, mas so os 2 cobraveis viram 1 linha de rollup.
  assert.deepEqual(find(out, 'rows'), ['rows', '1'], `esperado exatamente 1 linha (T,D); saida=${out}`)
  const agg = find(out, 'agg')
  assert.ok(agg, `linha de agregacao ausente; saida=${out}`)
  const [, eventCount, providerSum, billableSum] = agg
  assert.equal(eventCount, '2', `event_count deveria contar apenas os 2 cobraveis; saida=${out}`)
  assert.ok(
    Math.abs(parseFloat(providerSum) - 0.0036) < 1e-9,
    `sum(provider_cost_usd) deveria ser 0.0036; obtido=${providerSum}`,
  )
  assert.ok(
    Math.abs(parseFloat(billableSum) - 0.00468) < 1e-9,
    `sum(billable_cost_usd) deveria ser 0.00468; obtido=${billableSum}`,
  )
})
