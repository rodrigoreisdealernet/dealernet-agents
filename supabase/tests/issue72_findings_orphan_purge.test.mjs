// Teste de CONTRATO SQL — Purga de findings órfãos do vehicle-aging (issue #72),
// contra o Postgres VIVO. Mesma estrategia do vehicle_aging_contract.test.mjs:
// SEM Supabase CLI, SEM runner instalavel — apenas node:test + node:assert
// chamando o psql do container Docker via child_process.execFileSync.
//
// IMPORTANTE: este teste NUNCA roda `supabase db reset` (o banco e' compartilhado
// por outros pipelines). Em vez disso ele e' AUTO-CONTIDO: cada caso roda dentro
// de uma unica transacao BEGIN; ... ROLLBACK;, monta seus proprios fixtures
// (tenant + entidade 'vehicle' atual + findings ancorados) e SO ENTAO faz as
// assercoes, sempre extraindo o DELETE de purga REAL da supabase/seed.sql e a
// migration REAL para nao testar uma copia divergente. O ROLLBACK garante que
// nada e' persistido.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/issue72_findings_orphan_purge.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/72-findings-orfaos-inflam-morning-queue.md) que verifica.

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

// Extrai o statement de purga REAL da seed (DELETE FROM finding f ... ;). O alias
// `f` torna o marcador inequivoco (a outra DELETE da seed nao usa alias), e o
// proximo ponto-e-virgula fecha o statement.
function extractPurgeDelete(text) {
  const start = text.indexOf('DELETE FROM finding f')
  assert.ok(start >= 0, 'statement de purga "DELETE FROM finding f" nao encontrado na seed')
  const end = text.indexOf(';', start)
  assert.ok(end >= 0, '";" final do DELETE de purga nao encontrado na seed')
  return text.slice(start, end + 1)
}

const SEED = readFileSync(resolve(REPO_ROOT, 'supabase/seed.sql'), 'utf8')
const MIGRATION = readFileSync(
  resolve(REPO_ROOT, 'supabase/migrations/20260627130000_finding_status_superseded.sql'),
  'utf8',
)
const PURGE_DELETE = extractPurgeDelete(SEED)

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean)
const find = (out, key) => lines(out).find((l) => l.startsWith(`${key}|`))?.split('|')

// Monta os fixtures comuns dentro da transacao corrente: um tenant de teste, uma
// entidade 'vehicle' ATUAL (id estavel), e tres findings do agente vehicle-aging:
//   - in_scope:    contract_id aponta para a entidade vehicle atual  -> deve sobreviver
//   - orphan:      contract_id aponta para um UUID sem entidade       -> deve ser purgado
//   - other_agent: outro agent_key, tambem orfao                      -> NAO deve ser purgado
// Retorna SQL para ser prefixado dentro de um BEGIN;.
const FIXTURE = `
with t as (
  insert into tenants (id, tenant_key, name)
  values ('72720000-0000-0000-0000-0000000000aa', 'issue72-test', 'Issue 72 Test')
  returning id
), v as (
  insert into entities (id, entity_type, source_record_id)
  values ('72720000-0000-0000-0000-0000000000cc', 'vehicle', 'issue72-vehicle-current')
  returning id
)
insert into finding (id, tenant_id, agent_key, contract_id, finding_type, severity, status, fingerprint)
select * from (
  values
    ('72720000-0000-0000-0000-000000000001'::uuid, '72720000-0000-0000-0000-0000000000aa'::uuid,
     'vehicle-aging-analyst', '72720000-0000-0000-0000-0000000000cc'::uuid,
     'stock_aging_90d', 'high', 'pending_approval', 'fp-in-scope'),
    ('72720000-0000-0000-0000-000000000002'::uuid, '72720000-0000-0000-0000-0000000000aa'::uuid,
     'vehicle-aging-analyst', '72720000-0000-0000-0000-0000000000ee'::uuid,
     'stock_aging_90d', 'high', 'pending_approval', 'fp-orphan'),
    ('72720000-0000-0000-0000-000000000003'::uuid, '72720000-0000-0000-0000-0000000000aa'::uuid,
     'revenue-recognition', '72720000-0000-0000-0000-0000000000ff'::uuid,
     'revrec', 'high', 'pending_approval', 'fp-other-agent')
) as f(id, tenant_id, agent_key, contract_id, finding_type, severity, status, fingerprint);
`

// ---------------------------------------------------------------------------
// AC#4/#5 (migration): "a finding pode ser marcada 'superseded' (status terminal,
// nao-pendente) — e somente porque a migration estende o finding_status_chk."
// Prova de valor: sob o CHECK antigo (4 valores) 'superseded' e' REJEITADO; apos
// aplicar a migration REAL ele e' ACEITO e persistido.
// ---------------------------------------------------------------------------
test('AC migration: finding_status_chk passa a aceitar superseded (rejeitado antes, aceito depois)', () => {
  const { ok, out, err } = psql(`
begin;
${FIXTURE}
create temp table _probe(label text, result text) on commit drop;

-- 1) Reconstroi o CHECK PRE-migration (sem 'superseded').
alter table finding drop constraint if exists finding_status_chk;
alter table finding add constraint finding_status_chk
  check (status in ('pending_approval', 'approved', 'rejected', 'informational'));

do $probe$
begin
  update finding set status = 'superseded' where fingerprint = 'fp-in-scope';
  insert into _probe values ('pre_migration', 'allowed');
exception when check_violation then
  insert into _probe values ('pre_migration', 'rejected');
end
$probe$;

-- 2) Aplica a migration REAL e tenta de novo.
${MIGRATION}

do $probe$
begin
  update finding set status = 'superseded' where fingerprint = 'fp-in-scope';
  insert into _probe values ('post_migration', 'allowed');
exception when check_violation then
  insert into _probe values ('post_migration', 'rejected');
end
$probe$;

select label, result from _probe order by label;
select 'persisted', status from finding where fingerprint = 'fp-in-scope';
-- O CHECK continua real: um status invalido ainda e' barrado.
do $probe$
begin
  update finding set status = 'bogus_status' where fingerprint = 'fp-orphan';
  insert into _probe values ('invalid_status', 'allowed');
exception when check_violation then
  insert into _probe values ('invalid_status', 'rejected');
end
$probe$;
select label, result from _probe where label = 'invalid_status';
rollback;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  const rows = lines(out).map((l) => l.split('|'))
  const byLabel = Object.fromEntries(rows.map(([a, b]) => [a, b]))
  // Antes da migration o CHECK barra 'superseded'...
  assert.equal(byLabel.pre_migration, 'rejected', `pre-migration deveria rejeitar superseded; saida=${out}`)
  // ...depois da migration ele e' aceito e a linha realmente fica 'superseded'.
  assert.equal(byLabel.post_migration, 'allowed', `post-migration deveria aceitar superseded; saida=${out}`)
  assert.equal(byLabel.persisted, 'superseded', `finding deveria persistir status superseded; saida=${out}`)
  // E o CHECK continua enforced (nao virou um campo livre).
  assert.equal(byLabel.invalid_status, 'rejected', `status invalido ainda deveria ser barrado; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC#1/#4 (purge): "Apos um reseed, a Morning Queue nao contem itens cujo veiculo
// nao existe mais." O DELETE de purga remove a finding vehicle-aging orfa
// (contract_id sem entidade 'vehicle' atual) e PRESERVA a in-scope.
// AC#5: a finding que aponta para um veiculo atual permanece visivel/inalterada.
// Out-of-scope: a purga e' escopada ao agent_key 'vehicle-aging-analyst' — uma
// finding orfa de OUTRO agente nao e' tocada.
// ---------------------------------------------------------------------------
test('AC purge: remove a finding vehicle-aging orfa, preserva a in-scope e a de outro agente', () => {
  const { ok, out, err } = psql(`
begin;
${FIXTURE}
-- Antes: as tres findings existem.
select 'before', count(*) from finding where tenant_id = '72720000-0000-0000-0000-0000000000aa';

${PURGE_DELETE}

-- Depois: a orfa (fp-orphan) sumiu; a in-scope e a de outro agente continuam.
select 'after_total', count(*) from finding where tenant_id = '72720000-0000-0000-0000-0000000000aa';
select 'in_scope', count(*) from finding where fingerprint = 'fp-in-scope';
select 'orphan', count(*) from finding where fingerprint = 'fp-orphan';
select 'other_agent', count(*) from finding where fingerprint = 'fp-other-agent';
rollback;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(find(out, 'before'), ['before', '3'], `esperado 3 findings de fixture; saida=${out}`)
  // A in-scope sobrevive (sem falsa remocao).
  assert.deepEqual(find(out, 'in_scope'), ['in_scope', '1'], `finding in-scope deveria sobreviver; saida=${out}`)
  // A orfa do vehicle-aging e' removida.
  assert.deepEqual(find(out, 'orphan'), ['orphan', '0'], `finding orfa deveria ser purgada; saida=${out}`)
  // A orfa de OUTRO agente NAO e' tocada (purga escopada).
  assert.deepEqual(find(out, 'other_agent'), ['other_agent', '1'], `finding de outro agente nao deveria ser tocada; saida=${out}`)
  // Sobram exatamente 2 (in-scope + other-agent).
  assert.deepEqual(find(out, 'after_total'), ['after_total', '2'], `deveriam sobrar 2 findings; saida=${out}`)
})

// ---------------------------------------------------------------------------
// AC#3 (idempotencia): "Rodar a seed repetidamente e' seguro e estavel: um segundo
// reseed produz o mesmo resultado limpo e nunca erra em dados ja-limpos."
// A segunda execucao do DELETE de purga remove 0 linhas e nao falha.
// ---------------------------------------------------------------------------
test('AC idempotente: segunda execucao da purga remove 0 linhas e nao erra', () => {
  const { ok, out, err } = psql(`
begin;
${FIXTURE}

${PURGE_DELETE}
select 'after_first', count(*) from finding where tenant_id = '72720000-0000-0000-0000-0000000000aa';

-- Segunda passada sobre dados ja-limpos: sem erro, sem nova remocao.
${PURGE_DELETE}
select 'after_second', count(*) from finding where tenant_id = '72720000-0000-0000-0000-0000000000aa';
select 'orphan_after_second', count(*) from finding where fingerprint = 'fp-orphan';
rollback;
`)
  assert.ok(ok, `psql falhou (purga nao deveria erar em dados limpos): ${err}`)
  // A primeira passada ja deixou 2; a segunda mantem 2 (delta = 0 linhas removidas).
  assert.deepEqual(find(out, 'after_first'), ['after_first', '2'], `1a passada deveria deixar 2; saida=${out}`)
  assert.deepEqual(find(out, 'after_second'), ['after_second', '2'], `2a passada nao deveria remover nada; saida=${out}`)
  assert.deepEqual(
    find(out, 'orphan_after_second'),
    ['orphan_after_second', '0'],
    `a orfa permanece ausente apos a 2a passada; saida=${out}`,
  )
})
