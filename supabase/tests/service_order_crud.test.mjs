// Teste de CONTRATO SQL — Service Order / Oficina CRUD (issue #7), rodando contra
// o Postgres VIVO. Espelha supabase/tests/vehicle_crud.test.mjs (issue #4): mesmo
// harness (psql via docker exec), mesmo padrao BEGIN; ... ROLLBACK; por cenario
// (idempotente — NAO polui o banco compartilhado) e mesmo estilo de assercao.
//
// COMO RODAR:
//   node --test supabase/tests/service_order_crud.test.mjs
// Pre-requisito: container Postgres do Supabase no ar:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//
// Notas de implementacao (do schema vivo + migration 20260625160000):
//   * dia_assert_service_order_writer() exige role de REQUISICAO 'authenticated'
//     (ou 'service_role') E get_my_role() in (admin, branch_manager). get_my_role()
//     le auth.jwt() -> 'app_metadata' ->> 'role'. O JWT simulado precisa de
//     {"role":"authenticated", ..., "app_metadata":{"role":"<app_role>"}}.
//   * create/update/delete_service_order sao SECURITY DEFINER (bypassam RLS por
//     design). O caminho DIRETO (INSERT em entities/entity_versions como
//     authenticated read_only) e' bloqueado por RLS (sem policy que permita) ->
//     SQLSTATE 42501.
//   * Campos obrigatorios na validacao: customer e description. status default
//     'aberta'; enum {aberta, em_andamento, concluida, cancelada}.
//   * delete = soft-delete: nova versao com status 'cancelada' + cancelled=true.
//     A view v_dia_service_order_current EXCLUI canceladas.
//   * turnaround_hours so e' nao-nulo para status 'concluida' com opened_at e
//     closed_at presentes.
//
// Cada teste traz no nome o criterio de aceite que verifica (AC1..AC7).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const CONTAINER = 'supabase_db_dealernet-agents'

// JWT claims canonicas. role de requisicao = 'authenticated'; app_metadata.role
// define o app_role lido por get_my_role().
const claims = (appRole) =>
  JSON.stringify({
    role: 'authenticated',
    sub: '00000000-0000-0000-0000-0000000000aa',
    app_metadata: { role: appRole },
  })

// Executa um script SQL no Postgres vivo via psql. Retorna { ok, out, err }.
// -t -A -F'|' para parse simples. ON_ERROR_STOP=1 por padrao (erro inesperado
// quebra o teste); expectError=true desliga p/ capturar SQLSTATE manualmente.
function psql(sql, { expectError = false } = {}) {
  const args = [
    'exec',
    '-i',
    CONTAINER,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-q',
    '-t',
    '-A',
    '-F',
    '|',
  ]
  if (!expectError) args.push('-v', 'ON_ERROR_STOP=1')
  try {
    const out = execFileSync('docker', args, {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
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

// Prefacio comum: abre transacao, vira authenticated e injeta o JWT do app_role.
const asWriter = (appRole) => `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims(appRole)}', true) \\g /dev/null
`

// Captura o SQLSTATE de uma chamada que DEVE falhar, gravando numa temp table
// para que a saida venha em STDOUT. Retorna 'SQLSTATE=<code>' ou 'NO_ERROR'.
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

// Payload base valido (customer + description obrigatorios).
const VALID =
  `{"customer":"Maria Souza","vehicle":"BRA2E19","description":"Revisao de 10.000 km"}`

// ---------------------------------------------------------------------------
// AC1: role guard — write requer admin/branch_manager; read_only e' negado (42501).
// ---------------------------------------------------------------------------
test('AC1 role-guard: create_service_order como admin SUCEDE (retorna entity_id)', () => {
  const sql = `${asWriter('admin')}
select entity_id is not null as created
from create_service_order('${VALID}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `admin deveria criar ordem de servico; saida=${out}`)
})

test('AC1 role-guard: create_service_order como branch_manager SUCEDE', () => {
  const sql = `${asWriter('branch_manager')}
select entity_id is not null as created
from create_service_order('${VALID}'::jsonb);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 't', `branch_manager deveria criar ordem de servico; saida=${out}`)
})

test('AC1 role-guard: create_service_order como read_only FALHA com SQLSTATE 42501', () => {
  const sql = `${asWriter('read_only')}
${captureSqlstate(`perform create_service_order('${VALID}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para read_only; obtido: ${out}`)
})

test('AC1 role-guard: update_service_order como read_only FALHA com SQLSTATE 42501', () => {
  // Cria como admin numa temp table, depois tenta atualizar como read_only.
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order('${VALID}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claims', '${claims('read_only')}', true) \\g /dev/null
${captureSqlstate(`perform update_service_order((select entity_id from _so), '{"status":"em_andamento"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para read_only no update; obtido: ${out}`)
})

test('AC1 role-guard: delete_service_order como read_only FALHA com SQLSTATE 42501', () => {
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order('${VALID}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claims', '${claims('read_only')}', true) \\g /dev/null
${captureSqlstate(`perform delete_service_order((select entity_id from _so));`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `esperado 42501 para read_only no delete; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC2: INSERT/UPDATE direto nas tabelas (entities/entity_versions) como
// authenticated e' bloqueado por RLS (42501); o caminho via RPC funciona.
// Mesmo um app_role privilegiado nao deve depender de INSERT direto — testamos
// o cenario read_only (sem policy de write) para garantir o bloqueio de RLS.
// ---------------------------------------------------------------------------
test('AC2 RLS: INSERT direto em entities como read_only e bloqueado (42501)', () => {
  const sql = `${asWriter('read_only')}
${captureSqlstate(`
    insert into public.entities (entity_type, source_record_id)
    values ('service_order', 'rls-probe-' || gen_random_uuid()::text);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `INSERT direto deveria violar RLS (42501); obtido: ${out}`)
})

test('AC2 RLS: INSERT direto em entity_versions como read_only e bloqueado (42501)', () => {
  // Cria a entidade via RPC (admin) p/ ter um entity_id valido, depois tenta
  // anexar versao DIRETAMENTE como read_only — deve bater na RLS (42501).
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order('${VALID}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claims', '${claims('read_only')}', true) \\g /dev/null
${captureSqlstate(`
    insert into public.entity_versions (entity_id, version_number, data)
    values ((select entity_id from _so), 99, '{"status":"em_andamento"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=42501', `INSERT direto em entity_versions deveria violar RLS (42501); obtido: ${out}`)
})

test('AC2 RPC: caminho via create_service_order grava (entity + versao) mesmo sem write direto', () => {
  // O RPC e' SECURITY DEFINER: persiste a entidade e a versao 1 corrente, que a
  // view corrente passa a expor. Comprova que o write SO acontece via RPC.
  const sql = `${asWriter('branch_manager')}
create temp table _so on commit drop as
  select entity_id from create_service_order('${VALID}'::jsonb);
select 'entity', count(*) from entities e join _so on e.id = _so.entity_id
  where e.entity_type = 'service_order';
select 'versions', count(*) from entity_versions ev join _so using (entity_id);
select 'in_view', count(*) from v_dia_service_order_current v join _so using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const get = (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
  assert.deepEqual(get('entity'), ['entity', '1'], 'RPC deveria criar 1 entidade service_order')
  assert.deepEqual(get('versions'), ['versions', '1'], 'RPC deveria criar a versao 1')
  assert.deepEqual(get('in_view'), ['in_view', '1'], 'a ordem deveria aparecer na view corrente')
})

// ---------------------------------------------------------------------------
// AC3: validacao de status — invalido rejeitado (22023); valido aceito.
// Tambem cobre campos obrigatorios customer/description (22023).
// ---------------------------------------------------------------------------
test('AC3 validacao: create_service_order com status invalido FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_service_order('{"customer":"X","description":"Y","status":"zzz"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para status invalido; obtido: ${out}`)
})

test('AC3 validacao: create_service_order com cada status valido SUCEDE', () => {
  // Roda os quatro valores do enum num unico script; todos devem criar.
  const statuses = ['aberta', 'em_andamento', 'concluida', 'cancelada']
  const selects = statuses
    .map(
      (s, i) =>
        `select '${s}', entity_id is not null from create_service_order('{"customer":"C${i}","description":"D${i}","status":"${s}"}'::jsonb);`,
    )
    .join('\n')
  const sql = `${asWriter('admin')}
${selects}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const get = (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')
  for (const s of statuses) {
    assert.deepEqual(get(s), [s, 't'], `status valido '${s}' deveria ser aceito`)
  }
})

test('AC3 validacao: create_service_order sem customer FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_service_order('{"description":"Y"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para customer ausente; obtido: ${out}`)
})

test('AC3 validacao: create_service_order sem description FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
${captureSqlstate(`perform create_service_order('{"customer":"X"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para description ausente; obtido: ${out}`)
})

test('AC3 validacao: update_service_order para status invalido FALHA (22023)', () => {
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order('${VALID}'::jsonb);
${captureSqlstate(`perform update_service_order((select entity_id from _so), '{"status":"foo"}'::jsonb);`)}
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'SQLSTATE=22023', `esperado 22023 para status invalido no update; obtido: ${out}`)
})

// ---------------------------------------------------------------------------
// AC4: delete = soft-delete. A ordem some da view corrente (canceladas
// excluidas) mas o historico SCD2 e' preservado e a versao final fica
// status='cancelada' + cancelled=true; a versao 1 anterior permanece intacta.
// ---------------------------------------------------------------------------
test('AC4 soft-delete: delete_service_order remove da view, preserva historico e marca cancelada', () => {
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order(
    '{"customer":"Joao Lima","vehicle":"RIO3F45","description":"Troca de pastilhas","status":"em_andamento"}'::jsonb);
select 'before', count(*) from v_dia_service_order_current v join _so using (entity_id);
select delete_service_order((select entity_id from _so)) is not null as deleted;
select 'after_view', count(*) from v_dia_service_order_current v join _so using (entity_id);
select 'versions', count(*) from entity_versions ev join _so using (entity_id);
select 'current_state', (ev.data->>'status'), (ev.data->>'cancelled')
from entity_versions ev join _so using (entity_id) where ev.is_current;
select 'v1_intact', (ev.data->>'status'), coalesce(ev.data->>'cancelled','<absent>')
from entity_versions ev join _so using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const get = (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')

  assert.deepEqual(get('before'), ['before', '1'], 'ordem deveria estar na view antes do delete')
  assert.deepEqual(get('after_view'), ['after_view', '0'], 'ordem cancelada deve SAIR da view corrente')
  assert.deepEqual(
    get('versions'),
    ['versions', '2'],
    'historico SCD2 deveria ter 2 versoes (criacao + cancelamento), nada apagado',
  )
  assert.deepEqual(
    get('current_state'),
    ['current_state', 'cancelada', 'true'],
    'a versao corrente deve ficar status=cancelada e cancelled=true',
  )
  assert.deepEqual(
    get('v1_intact'),
    ['v1_intact', 'em_andamento', '<absent>'],
    'a versao 1 anterior deve permanecer intacta (em_andamento, sem flag cancelled)',
  )
})

// ---------------------------------------------------------------------------
// AC4 (extra): update_service_order incrementa version_number, preserva
// historico e a view reflete o novo valor (SCD2).
// ---------------------------------------------------------------------------
test('AC4 update SCD2: update_service_order incrementa versao, preserva historico, view reflete novo status', () => {
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order(
    '{"customer":"Pedro Alves","description":"Alinhamento","status":"aberta"}'::jsonb);
select 'v_before', v.version_number, v.status
from v_dia_service_order_current v join _so using (entity_id);
select update_service_order((select entity_id from _so),
  '{"status":"em_andamento","technician":"Carlos"}'::jsonb) is not null as updated;
select 'v_after', v.version_number, v.status, coalesce(v.technician,'<null>')
from v_dia_service_order_current v join _so using (entity_id);
select 'versions', count(*) from entity_versions ev join _so using (entity_id);
select 'v1_intact', (ev.data->>'status'), coalesce(ev.data->>'technician','<absent>')
from entity_versions ev join _so using (entity_id) where ev.version_number = 1;
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const get = (key) => lines.find((l) => l.startsWith(`${key}|`))?.split('|')

  assert.deepEqual(get('v_before'), ['v_before', '1', 'aberta'], 'estado inicial: versao 1, aberta')
  assert.deepEqual(
    get('v_after'),
    ['v_after', '2', 'em_andamento', 'Carlos'],
    'apos update: versao 2 com novos valores (em_andamento, technician Carlos)',
  )
  assert.deepEqual(get('versions'), ['versions', '2'], 'historico deveria ter 2 versoes')
  assert.deepEqual(
    get('v1_intact'),
    ['v1_intact', 'aberta', '<absent>'],
    'a versao 1 deve permanecer intacta (aberta, sem technician)',
  )
})

// ---------------------------------------------------------------------------
// AC5: v_dia_service_order_current deriva turnaround_hours — nao-nulo para
// 'concluida' com opened_at+closed_at; nulo nos demais casos.
// ---------------------------------------------------------------------------
test('AC5 turnaround: concluida com opened_at/closed_at => turnaround_hours = horas decorridas', () => {
  // opened 2026-06-01T08:00, closed 2026-06-01T14:30 => 6.5h.
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order(
    '{"customer":"Ana","description":"Revisao","status":"concluida","opened_at":"2026-06-01T08:00:00+00","closed_at":"2026-06-01T14:30:00+00"}'::jsonb);
select v.status, v.turnaround_hours
from v_dia_service_order_current v join _so using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  const [status, turn] = out.split('|')
  assert.equal(status, 'concluida', `status esperado concluida; obtido ${status}`)
  assert.equal(Number(turn), 6.5, `turnaround_hours esperado 6.5; obtido ${turn}`)
})

test('AC5 turnaround: status nao-concluida => turnaround_hours NULL mesmo com datas', () => {
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order(
    '{"customer":"Ana","description":"Revisao","status":"em_andamento","opened_at":"2026-06-01T08:00:00+00","closed_at":"2026-06-01T14:30:00+00"}'::jsonb);
select v.status, (v.turnaround_hours is null) as is_null
from v_dia_service_order_current v join _so using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'em_andamento|t', `em_andamento deveria ter turnaround_hours NULL; obtido ${out}`)
})

test('AC5 turnaround: concluida SEM closed_at => turnaround_hours NULL', () => {
  const sql = `${asWriter('admin')}
create temp table _so on commit drop as
  select entity_id from create_service_order(
    '{"customer":"Ana","description":"Revisao","status":"concluida","opened_at":"2026-06-01T08:00:00+00"}'::jsonb);
select v.status, (v.turnaround_hours is null) as is_null
from v_dia_service_order_current v join _so using (entity_id);
rollback;
`
  const { ok, out, err } = psql(sql)
  assert.ok(ok, `psql falhou: ${err}`)
  assert.equal(out, 'concluida|t', `concluida sem closed_at deveria ter turnaround_hours NULL; obtido ${out}`)
})

// ---------------------------------------------------------------------------
// AC7 (seed): ~10 ordens demo namespace 'demo-dia-service-%' existem, com pelo
// menos uma 'concluida' com turnaround_hours nao-nulo. SOMENTE LEITURA — sem
// reset/mutacao do banco compartilhado.
// ---------------------------------------------------------------------------
test('AC7 seed: ~10 ordens demo-dia-service-% existem na view corrente', () => {
  const { ok, out, err } = psql(`
select count(*)
from v_dia_service_order_current v
join entities e on e.id = v.entity_id
where e.source_record_id like 'demo-dia-service-%';
`)
  assert.ok(ok, `psql falhou: ${err}`)
  const n = Number(out)
  assert.ok(
    n >= 8 && n <= 12,
    `esperado ~10 ordens demo na view (8..12); obtido ${n}. (seed aplicado?)`,
  )
})

test('AC7 seed: ao menos uma demo concluida tem turnaround_hours nao-nulo (> 0)', () => {
  const { ok, out, err } = psql(`
select count(*)
from v_dia_service_order_current v
join entities e on e.id = v.entity_id
where e.source_record_id like 'demo-dia-service-%'
  and v.status = 'concluida'
  and v.turnaround_hours is not null
  and v.turnaround_hours > 0;
`)
  assert.ok(ok, `psql falhou: ${err}`)
  const n = Number(out)
  assert.ok(n >= 1, `esperado >=1 demo concluida com turnaround_hours>0; obtido ${n}`)
})
