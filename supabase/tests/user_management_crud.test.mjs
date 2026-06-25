// Teste de CONTRATO SQL — User management CRUD (issue #6), contra o Postgres VIVO.
//
// Espelha EXATAMENTE as convencoes de supabase/tests/vehicle_crud.test.mjs:
// node:test + node:assert, psql via `docker exec` no container do Supabase,
// isolamento por BEGIN; ... ROLLBACK;, mock de claims JWT via
// set_config('request.jwt.claims', ...), helpers asWriter()/captureSqlstate(),
// saida separada por pipe com `-t -A -F'|'`.
//
// COMO RODAR:
//   node --test supabase/tests/user_management_crud.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// IMPORTANTE — DB COMPARTILHADO + migration ainda nao aplicada:
//   O stack local do Supabase e' COMPARTILHADO (5 issues em paralelo); NAO podemos
//   rodar `supabase db push/reset`. A migration 20260625140000_user_management_crud.sql
//   (coluna is_active + RPC admin_update_profile) pode ainda NAO estar aplicada no
//   banco vivo. Como toda a DDL da migration e' transacional e idempotente
//   (alter table ... add column if not exists / create or replace function),
//   cada teste APLICA a migration dentro da propria transacao BEGIN; ... ROLLBACK;
//   antes de exercitar o comportamento. Assim o teste:
//     (a) roda verde mesmo antes do push (nao depende de estado externo);
//     (b) exercita o SQL REAL da migration (nao uma copia);
//     (c) faz rollback total — NAO muta o estado compartilhado.
//
// Notas de schema (descobertas contra o banco vivo):
//   * get_my_role() le auth.jwt() -> 'app_metadata' ->> 'role'. O guard do RPC
//     admin_update_profile le o role de REQUISICAO de request.jwt.claim.role ou
//     request.jwt.claims ->> 'role'. Por isso o JWT simulado precisa de
//     {"role":"authenticated", ..., "app_metadata":{"role":"<app_role>"}}.
//   * public.profiles tem FK id -> auth.users(id). Para seedar um profile dentro
//     da txn inserimos primeiro a auth.users (so id/is_sso_user/is_anonymous sao
//     NOT NULL); o trigger on_auth_user_created cria o profile automaticamente.
//
// Cada teste traz no nome / comentario o criterio de aceite (spec
// docs/specs/6-feat-usuarios-gestao-crud-profiles.md) que verifica.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CONTAINER = 'supabase_db_dealernet-agents'

const __dirname = dirname(fileURLToPath(import.meta.url))
// SQL da migration desta feature — aplicado DENTRO de cada txn (ver cabecalho).
const MIGRATION_SQL = readFileSync(
  join(__dirname, '..', 'migrations', '20260625140000_user_management_crud.sql'),
  'utf8',
)

// JWT claims canonicas. role de requisicao = 'authenticated' (lido pelo guard do
// RPC); app_metadata.role define o app_role lido por get_my_role().
const claims = (appRole, sub = '00000000-0000-0000-0000-0000000000aa') =>
  JSON.stringify({
    role: 'authenticated',
    sub,
    app_metadata: { role: appRole },
  })

// Executa um script SQL no Postgres vivo via psql. Retorna { ok, out, err }.
// -t -A -F'|' (tuplas-only, unaligned, separador pipe) para parse simples.
function psql(sql, { expectError = false } = {}) {
  const args = [
    'exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-q', '-t', '-A', '-F', '|',
  ]
  if (!expectError) args.push('-v', 'ON_ERROR_STOP=1')
  try {
    const out = execFileSync('docker', args, {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true, out: out.trim(), err: '' }
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout || '').toString().trim(),
      err: (e.stderr || '').toString().trim(),
    }
  }
}

// Prefacio: abre txn, APLICA a migration da feature (idempotente, rollbackavel),
// vira a role de requisicao para authenticated e injeta o JWT do app_role.
const asWriter = (appRole, sub) => `
begin;
${MIGRATION_SQL}
set local role authenticated;
select set_config('request.jwt.claims', '${claims(appRole, sub)}', true) \\g /dev/null
`

// Como asWriter mas SEM trocar de role / claims — usado para checagens de catalogo
// (information_schema, grants) que rodam como superuser postgres.
const asAdminSetup = () => `
begin;
${MIGRATION_SQL}
`

// Captura o SQLSTATE de uma chamada que DEVE falhar; grava numa temp table e faz
// SELECT para que a saida venha em STDOUT. Retorna 'SQLSTATE=<code>' ou 'NO_ERROR'.
function captureSqlstate(stmt) {
  return `
create temp table _r (outcome text) on commit drop;
do $$ begin
  ${stmt}
  insert into _r values ('NO_ERROR');
exception when others then
  insert into _r values ('SQLSTATE=' || SQLSTATE);
end $$;
select outcome from _r;
`
}

// Seeda uma auth.users + profile dentro da txn corrente (a role precisa poder
// escrever em auth.users — chamado ANTES do `set local role authenticated`).
// Define display_name/role/tenant explicitos via raw_* para o trigger refletir.
const seedUser = (id, displayName, role, tenant = 'default') => `
insert into auth.users (id, is_sso_user, is_anonymous, email,
                        raw_user_meta_data, raw_app_meta_data)
values ('${id}', false, false, '${id}@test.local',
        '{"display_name":"${displayName}"}'::jsonb,
        '{"role":"${role}","tenant":"${tenant}"}'::jsonb);
`

// ---------------------------------------------------------------------------
// AC1 (Deactivation flag): a coluna public.profiles.is_active existe, e' NOT NULL
// e tem default true. Checado via information_schema (catalogo do Postgres).
// ---------------------------------------------------------------------------
test('AC1 is_active: coluna existe em profiles, NOT NULL, default true', () => {
  const sql = `${asAdminSetup()}
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_active';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const [name, type, nullable, def] = out.split('|')
  assert.equal(name, 'is_active', 'coluna is_active deve existir em public.profiles')
  assert.equal(type, 'boolean', 'is_active deve ser boolean')
  assert.equal(nullable, 'NO', 'is_active deve ser NOT NULL')
  assert.match(def ?? '', /true/, `default de is_active deve ser true; obtido: ${def}`)
})

// ---------------------------------------------------------------------------
// AC1 (Deactivation flag): linhas existentes/novas ganham is_active = true sem
// precisar informar o valor (default aplicado pela migration).
// ---------------------------------------------------------------------------
test('AC1 is_active: novo profile sem informar is_active vem como true', () => {
  const id = '11111111-1111-1111-1111-111111111111'
  const sql = `${asAdminSetup()}
${seedUser(id, 'Newbie', 'read_only')}
select is_active from public.profiles where id = '${id}';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `profile recem-criado deveria ter is_active=true; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC3/AC5 (Admin-only RPC guard): admin_update_profile como read_only e' negado
// com SQLSTATE 42501.
// ---------------------------------------------------------------------------
test('AC3/AC5 guard: admin_update_profile como read_only FALHA com SQLSTATE 42501', () => {
  const target = '22222222-2222-2222-2222-222222222222'
  const sql = `begin;
${MIGRATION_SQL}
${seedUser(target, 'Target', 'read_only')}
set local role authenticated;
select set_config('request.jwt.claims', '${claims('read_only')}', true) \\g /dev/null
${captureSqlstate(`perform public.admin_update_profile('${target}'::uuid, 'Hacked', 'admin'::public.app_role, true);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para read_only; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC5 (Non-admins cannot escalate/alter others): branch_manager e field_operator
// tambem sao negados no RPC (so admin escreve). Dois casos, mesmo errcode 42501.
// ---------------------------------------------------------------------------
for (const role of ['branch_manager', 'field_operator']) {
  test(`AC5 guard: admin_update_profile como ${role} FALHA com SQLSTATE 42501`, () => {
    const target = '33333333-3333-3333-3333-333333333333'
    const sql = `begin;
${MIGRATION_SQL}
${seedUser(target, 'Target', 'read_only')}
set local role authenticated;
select set_config('request.jwt.claims', '${claims(role)}', true) \\g /dev/null
${captureSqlstate(`perform public.admin_update_profile('${target}'::uuid, 'X', 'admin'::public.app_role, false);`)}
rollback;
`
    const { ok, out, err } = psql(sql)
    assert.ok(ok, `psql falhou: ${err}`)
    assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para ${role}; obtido: ${out}`)
  })
}

// ---------------------------------------------------------------------------
// AC3 (Admin-only RPC guard, caminho feliz): admin_update_profile como admin
// SUCEDE e altera display_name/role/is_active da linha alvo.
// ---------------------------------------------------------------------------
test('AC3 guard: admin_update_profile como admin SUCEDE e altera a linha', () => {
  const target = '44444444-4444-4444-4444-444444444444'
  const sql = `begin;
${MIGRATION_SQL}
${seedUser(target, 'Before', 'read_only')}
set local role authenticated;
select set_config('request.jwt.claims', '${claims('admin')}', true) \\g /dev/null
select display_name, role::text, is_active
from public.admin_update_profile('${target}'::uuid, 'After', 'branch_manager'::public.app_role, true);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    out.split('|'),
    ['After', 'branch_manager', 't'],
    `admin deveria atualizar nome/role/is_active; obtido: ${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC4 (Admin can edit name/role and deactivate): como admin, admin_update_profile
// muda display_name, role E desativa (is_active=false); a linha em profiles
// reflete os tres e updated_at avancou.
// ---------------------------------------------------------------------------
test('AC4 manage: admin edita nome+role e desativa (is_active=false); updated_at avanca', () => {
  const target = '55555555-5555-5555-5555-555555555555'
  const sql = `begin;
${MIGRATION_SQL}
${seedUser(target, 'OldName', 'read_only')}
-- congela updated_at original num passado conhecido p/ provar que o RPC avancou
update public.profiles set updated_at = now() - interval '1 day' where id = '${target}';
create temp table _before on commit drop as
  select updated_at as ts from public.profiles where id = '${target}';
set local role authenticated;
select set_config('request.jwt.claims', '${claims('admin')}', true) \\g /dev/null
select public.admin_update_profile('${target}'::uuid, 'NewName', 'field_operator'::public.app_role, false) is not null \\g /dev/null
reset role;
select p.display_name, p.role::text, p.is_active, (p.updated_at > b.ts) as advanced
from public.profiles p, _before b where p.id = '${target}';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    out.split('|'),
    ['NewName', 'field_operator', 'f', 't'],
    `esperado nome=NewName, role=field_operator, is_active=false, updated_at avancado; obtido: ${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC5 (No role escalation via direct UPDATE): a policy profiles_update_own
// permanece funcionando — um non-admin NAO consegue escalar o proprio role para
// admin via UPDATE direto na tabela (WITH CHECK barra). Esperado: erro de policy.
// ---------------------------------------------------------------------------
test('AC5 no-escalation: non-admin nao escala proprio role para admin (policy barra)', () => {
  const self = '66666666-6666-6666-6666-666666666666'
  const sql = `begin;
${MIGRATION_SQL}
${seedUser(self, 'Self', 'read_only')}
set local role authenticated;
select set_config('request.jwt.claims', '${claims('read_only', self)}', true) \\g /dev/null
${captureSqlstate(`update public.profiles set role = 'admin' where id = '${self}';`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  // A policy profiles_update_own tem WITH CHECK que barra escalada -> 42501.
  assert.equal(
    out,
    'SQLSTATE=42501',
    `escalada do proprio role deveria ser barrada pela policy (42501); obtido: ${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC5 (Cannot alter others): a policy profiles_update_own usa USING(id=auth.uid()),
// entao um non-admin nao enxerga/atualiza a linha de OUTRO usuario — UPDATE
// afeta 0 linhas (silenciosamente filtrado pela RLS), sem escrever nada.
// ---------------------------------------------------------------------------
test('AC5 alter-others: non-admin nao altera profile de outro usuario (0 linhas)', () => {
  const me = '77777777-7777-7777-7777-777777777777'
  const other = '88888888-8888-8888-8888-888888888888'
  const sql = `begin;
${MIGRATION_SQL}
${seedUser(me, 'Me', 'branch_manager')}
${seedUser(other, 'Other', 'read_only')}
set local role authenticated;
select set_config('request.jwt.claims', '${claims('branch_manager', me)}', true) \\g /dev/null
with upd as (
  update public.profiles set display_name = 'TAMPERED' where id = '${other}' returning 1
)
select count(*) from upd;
reset role;
select display_name from public.profiles where id = '${other}';
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  assert.equal(lines[0], '0', `UPDATE em linha de outro usuario deveria afetar 0 linhas; obtido: ${lines[0]}`)
  assert.equal(lines[1], 'Other', `nome do outro usuario deve permanecer intacto; obtido: ${lines[1]}`)
})

// ---------------------------------------------------------------------------
// AC3/AC5 (Grants): anon/public NAO podem executar admin_update_profile;
// authenticated e service_role podem (revoke from public,anon; grant ...).
// ---------------------------------------------------------------------------
test('AC3/AC5 grants: anon NAO pode executar admin_update_profile; authenticated/service_role podem', () => {
  const fn = "'public.admin_update_profile(uuid, text, public.app_role, boolean)'"
  const sql = `${asAdminSetup()}
select
  has_function_privilege('anon', ${fn}, 'EXECUTE'),
  has_function_privilege('authenticated', ${fn}, 'EXECUTE'),
  has_function_privilege('service_role', ${fn}, 'EXECUTE');
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.deepEqual(
    out.split('|'),
    ['f', 't', 't'],
    `esperado anon=f, authenticated=t, service_role=t; obtido: ${out}`,
  )
})

// ---------------------------------------------------------------------------
// AC4/AC5 (RPC alvo inexistente): admin_update_profile contra um id inexistente
// passa pelo guard mas falha com P0002 (not found) — prova que o guard nao mascara
// a ausencia da linha e que nada e' criado.
// ---------------------------------------------------------------------------
test('AC4 not-found: admin_update_profile em id inexistente FALHA com P0002', () => {
  const ghost = '99999999-9999-9999-9999-999999999999'
  const sql = `begin;
${MIGRATION_SQL}
set local role authenticated;
select set_config('request.jwt.claims', '${claims('admin')}', true) \\g /dev/null
${captureSqlstate(`perform public.admin_update_profile('${ghost}'::uuid, 'Nobody', 'read_only'::public.app_role, true);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=P0002', `esperado P0002 para id inexistente; obtido: ${out}`)
})
