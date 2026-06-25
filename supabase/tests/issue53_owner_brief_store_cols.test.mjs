// Teste de CONTRATO SQL — regressão SELECT-vs-SCHEMA do drill de lojas do
// Morning Brief (issue #53), rodando contra o Postgres VIVO do Supabase.
//
// CONTEXTO DO BUG (#53): getOwnerBriefByStore() em
// frontend-portal/src/portal/lib/agentsApi.ts fazia
// .select(OWNER_BRIEF_STORE_COLS), e a lista herdava `store_count` —
// coluna que NÃO existe na view v_dia_owner_brief_by_store. PostgREST
// respondia 400 Bad Request, o unwrap() engolia em [] e o drill ficava
// vazio. A fix separou OWNER_BRIEF_BASE_COLS (comum) de
// OWNER_BRIEF_BRAND_COLS (+store_count) e OWNER_BRIEF_STORE_COLS
// (+store_name, SEM store_count).
//
// ESTRATÉGIA: este teste fecha o gap que a issue #53 pede explicitamente —
// um cross-check SELECT-vs-SCHEMA que falha em CI sem browser. Lemos as
// listas de colunas que o FRONTEND pede (parse direto do agentsApi.ts) e as
// confrontamos com as colunas REAIS das views (information_schema, banco
// vivo). Cada coluna pedida tem de EXISTIR na view; e `store_count` NÃO pode
// estar nem no select por loja nem na view por loja (o bug exato não pode
// reaparecer). Por fim, executamos um SELECT com EXATAMENTE as colunas do
// frontend contra a view por loja — tem de rodar sem erro (prova viva do 200 OK).
//
// Ambiente OFFLINE: SEM Supabase CLI e SEM runner instalável. Apenas modulos
// nativos do Node (node:test + node:assert) e psql do container Docker via
// child_process. Tudo em BEGIN; ... ROLLBACK; — nunca reseta o banco
// compartilhado. Mesmo padrão de issue43_owner_brief.test.mjs.
//
// COMO RODAR:
//   node --test --test-concurrency=1 supabase/tests/issue53_owner_brief_store_cols.test.mjs
// Pré-requisito: container Postgres do Supabase no ar e a migration aplicada:
//   docker exec -i supabase_db_dealernet-agents psql -U postgres -d postgres -c "select 1"
//   migration: supabase/migrations/20260626140000_dia_owner_brief_by_brand.sql

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const CONTAINER = 'supabase_db_dealernet-agents'

const __dirname = dirname(fileURLToPath(import.meta.url))
// supabase/tests/ -> raiz do repo -> frontend-portal/src/portal/lib/agentsApi.ts
const AGENTS_API_PATH = resolve(
  __dirname,
  '../../frontend-portal/src/portal/lib/agentsApi.ts',
)

// ── Parser/resolvedor das listas de colunas que o FRONTEND pede ─────────────
// Lemos o .ts como texto e resolvemos cada const `OWNER_BRIEF_*_COLS` — seja
// um literal entre aspas simples, seja uma template string que referencia
// outra const via ${...}. A resolução é recursiva e AGNÓSTICA DE LAYOUT: vale
// para a estrutura atual (BASE → BRAND/STORE) e também para a estrutura PRÉ-FIX
// (STORE = `${BRAND}, store_name`, com store_count herdado). Assim o que falha
// no código pré-fix é o cross-check contra o SCHEMA real (a regressão exata),
// e não um guarda de parser. Falha alto se a const sumir de vez.
function extractFrontendSelectCols() {
  const src = readFileSync(AGENTS_API_PATH, 'utf8')

  // Coleta todas as atribuições `const OWNER_BRIEF_*_COLS = <literal|template>`.
  const decls = new Map()
  const re = /OWNER_BRIEF_[A-Z_]*COLS\s*=\s*(?:'([^']*)'|`([^`]*)`)/g
  let m
  while ((m = re.exec(src)) !== null) {
    const name = m[0].slice(0, m[0].indexOf('=')).trim()
    decls.set(name, m[1] !== undefined ? m[1] : m[2])
  }

  // Resolve ${OWNER_BRIEF_*} referências recursivamente (com guarda de ciclo).
  const resolve = (name, seen = new Set()) => {
    assert.ok(decls.has(name), `não encontrei a const ${name} em agentsApi.ts (mudou o formato?)`)
    assert.ok(!seen.has(name), `referência cíclica resolvendo ${name}`)
    seen.add(name)
    return decls.get(name).replace(/\$\{(OWNER_BRIEF_[A-Z_]*COLS)\}/g, (_, ref) => resolve(ref, seen))
  }

  const toSet = (raw) => raw.split(',').map((c) => c.trim()).filter(Boolean)

  assert.ok(decls.has('OWNER_BRIEF_STORE_COLS'), 'OWNER_BRIEF_STORE_COLS não existe em agentsApi.ts')
  assert.ok(decls.has('OWNER_BRIEF_BRAND_COLS'), 'OWNER_BRIEF_BRAND_COLS não existe em agentsApi.ts')

  return {
    brand: toSet(resolve('OWNER_BRIEF_BRAND_COLS')),
    store: toSet(resolve('OWNER_BRIEF_STORE_COLS')),
  }
}

// ── psql helpers (mesmo padrão de issue43_owner_brief.test.mjs) ─────────────
function psql(sql, { expectError = false } = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A', '-F', '|']
  if (!expectError) args.push('-v', 'ON_ERROR_STOP=1')
  try {
    const out = execFileSync('docker', args, {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { ok: true, out: out.trim(), err: '' }
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString().trim(), err: (e.stderr || '').toString().trim() }
  }
}

function scalar(query) {
  const { ok, out, err } = psql(`begin;\n${query}\nrollback;`)
  assert.ok(ok, `psql falhou: ${err}`)
  return out
}

// Conjunto de colunas REAIS de uma view (information_schema, banco vivo).
function viewColumns(viewName) {
  const csv = scalar(
    `select string_agg(column_name, ',' order by column_name)
       from information_schema.columns
      where table_schema = 'public' and table_name = '${viewName}';`,
  )
  assert.ok(csv, `view ${viewName} não existe / sem colunas (migration aplicada?)`)
  return new Set(csv.split(','))
}

const FRONTEND = extractFrontendSelectCols()

// ---------------------------------------------------------------------------
// REGRESSÃO #53 (núcleo): toda coluna que o frontend pede no SELECT por LOJA
// existe em v_dia_owner_brief_by_store. No código pré-fix o select incluía
// store_count (herdado de OWNER_BRIEF_BRAND_COLS) -> diferença não-vazia ->
// este assert FALHA. Pós-fix a diferença é vazia -> PASSA.
// ---------------------------------------------------------------------------
test('regressão #53: SELECT por loja ⊆ colunas de v_dia_owner_brief_by_store', () => {
  const viewCols = viewColumns('v_dia_owner_brief_by_store')
  const missing = FRONTEND.store.filter((c) => !viewCols.has(c))
  assert.deepEqual(
    missing,
    [],
    `o frontend pede colunas que NÃO existem na view por loja (causa do 400 -> drill vazio): ${missing.join(', ')}`,
  )
})

// ---------------------------------------------------------------------------
// Simétrico: o SELECT por MARCA ⊆ colunas de v_dia_owner_brief_by_brand
// (store_count É legítimo aqui — a view por marca o expõe).
// ---------------------------------------------------------------------------
test('contrato #53: SELECT por marca ⊆ colunas de v_dia_owner_brief_by_brand', () => {
  const viewCols = viewColumns('v_dia_owner_brief_by_brand')
  const missing = FRONTEND.brand.filter((c) => !viewCols.has(c))
  assert.deepEqual(
    missing,
    [],
    `o frontend pede colunas que NÃO existem na view por marca: ${missing.join(', ')}`,
  )
  // E store_count tem de estar de fato no select por marca (não regredir para o lado errado).
  assert.ok(
    FRONTEND.brand.includes('store_count'),
    'store_count deveria continuar no SELECT por marca (a view por marca o expõe)',
  )
})

// ---------------------------------------------------------------------------
// Guarda NEGATIVA do bug exato: store_count NÃO pode estar no select por loja
// NEM na view por loja. Fixa que a regressão específica não reapareça.
// ---------------------------------------------------------------------------
test('guarda negativa #53: store_count ∉ SELECT por loja e ∉ view por loja', () => {
  assert.ok(
    !FRONTEND.store.includes('store_count'),
    'store_count voltou ao SELECT por loja (era exatamente a causa do bug #53)',
  )
  const viewCols = viewColumns('v_dia_owner_brief_by_store')
  assert.ok(
    !viewCols.has('store_count'),
    'v_dia_owner_brief_by_store passou a ter store_count — premissa do teste mudou; reavalie a fix',
  )
  // store_name é o discriminador legítimo do drill por loja.
  assert.ok(
    FRONTEND.store.includes('store_name') && viewCols.has('store_name'),
    'o SELECT por loja deveria pedir store_name, que existe na view',
  )
})

// ---------------------------------------------------------------------------
// Prova VIVA do 200 OK: rodar EXATAMENTE as colunas do frontend contra a view
// por loja tem de executar sem erro. No pré-fix, store_count quebraria com
// "column ... does not exist" (espelho do 400 do PostgREST).
// ---------------------------------------------------------------------------
test('regressão #53: SELECT <colunas exatas do frontend> FROM v_dia_owner_brief_by_store roda sem erro', () => {
  const colList = FRONTEND.store.join(', ')
  const { ok, err } = psql(
    `begin;\nselect ${colList} from v_dia_owner_brief_by_store limit 1;\nrollback;`,
  )
  assert.ok(
    ok,
    `selecionar as colunas exatas do frontend deveria rodar sem erro (espelha o 200 OK do PostgREST); erro: ${err}`,
  )
})

// ---------------------------------------------------------------------------
// Shape do drill: a view por loja é por (marca, loja) — discriminada por
// store_name, NÃO agregada por store_count. Confirma que a estrutura
// realmente expõe as linhas por loja que o drill renderiza.
// ---------------------------------------------------------------------------
test('contrato #53: v_dia_owner_brief_by_store é por loja (store_name presente, store_count ausente)', () => {
  const viewCols = viewColumns('v_dia_owner_brief_by_store')
  assert.ok(viewCols.has('store_name'), 'view por loja deveria ter store_name (uma linha por loja)')
  assert.ok(!viewCols.has('store_count'), 'view por loja NÃO deveria ter store_count (não é agregado de marca)')
  for (const c of ['brand_name', 'novos_units', 'novos_value', 'fp_units_at_risk', 'resultado']) {
    assert.ok(viewCols.has(c), `view por loja deveria expor a célula de setor/FP ${c}`)
  }
})
