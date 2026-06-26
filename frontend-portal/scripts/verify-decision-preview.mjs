// Verificacao dependency-free da Previa de Consequencias do Finding Detail
// (issue #126). Asserta sobre o TEXTO-FONTE de FindingDetail.tsx / agentsApi.ts
// e dos JSONs de i18n; nao precisa de node_modules nem de runtime do React.
//
// Roda com: node --test scripts/verify-decision-preview.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/126-feat-ops-previa-de-consequencias.md) que cobre.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(ROOT, '..')

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

function readJson(relPath) {
  return JSON.parse(read(relPath))
}

const FINDING_DETAIL = 'src/portal/renderers/screens/FindingDetail.tsx'
const AGENTS_API = 'src/portal/lib/agentsApi.ts'
const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'

const LOCALES = [['pt-BR', PT_BR], ['en-US', EN_US]]

// Tabela compartilhada que fixa as DUAS linguagens (Python + TS) a um unico
// conjunto de saidas esperadas. O teste de runtime abaixo executa de fato o
// describeActionEffect do agentsApi.ts e o compara a esta tabela; o pytest
// (temporal/tests/test_decision_preview.py) compara o describe_action_effect
// Python a ela. Mudar a regra em uma linguagem quebra a outra.
const PARITY_FIXTURE = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'tests/fixtures/decision_preview_parity.json'), 'utf8'),
)

// Extrai o codigo-fonte VERBATIM de describeActionEffect (+ suas constantes) do
// agentsApi.ts e o importa isolado. O modulo completo nao pode ser importado
// sem node_modules (depende de @supabase/supabase-js e import.meta.env do Vite),
// mas a funcao e pura — entao executamos o codigo REAL, nao um grep.
let _describeActionEffect
async function loadDescribeActionEffect() {
  if (_describeActionEffect) return _describeActionEffect
  const src = read(AGENTS_API)
  const start = src.indexOf('const VEHICLE_AGING_FINDING_TYPE')
  assert.ok(start > -1, 'nao encontrei as constantes de describeActionEffect em agentsApi.ts')
  const marker = 'return { on_approve: onApprove, on_reject: onReject }'
  const mIdx = src.indexOf(marker, start)
  assert.ok(mIdx > -1, 'nao encontrei o return de describeActionEffect em agentsApi.ts')
  const end = src.indexOf('}', mIdx + marker.length) + 1
  const snippet = src.slice(start, end)
  assert.match(snippet, /export function describeActionEffect\(/, 'o trecho extraido deve conter describeActionEffect')
  const tmp = resolve(tmpdir(), `describeActionEffect_${process.pid}_${Date.now()}.ts`)
  writeFileSync(tmp, snippet)
  const mod = await import(pathToFileURL(tmp).href)
  _describeActionEffect = mod.describeActionEffect
  return _describeActionEffect
}


// Cada effect_key descrito por describeActionEffect mapeia para a chave i18n do
// texto exibido (preview.*). Mantem o teste fiel ao espelho do backend.
const EFFECT_KEY_TO_I18N = {
  'vehicle_aging.markdown': 'effectMarkdown',
  'vehicle_aging.disposition': 'effectDisposition',
  'generic.monitor_noop': 'effectMonitorNoop',
  'assist_only.register': 'effectAssistOnly',
  'generic.reject_noop': 'effectRejectNoop',
}

// Selos + rotulos de impacto de valor que aparecem nos blocos de previa.
const SEAL_AND_IMPACT_KEYS = [
  'sealAssistOnly',
  'sealAudited',
  'sealNoop',
  'impactRecoverable',
  'impactExposure',
]

// ---------------------------------------------------------------------------
// AC1 — Dois blocos ("Ao aprovar"/"Ao recusar") renderizados ANTES dos botoes
//       Approve/Reject.
// ---------------------------------------------------------------------------
test('AC1 UI: a previa renderiza os dois ramos (branchApprove + branchReject) num bloco condicionado a pending_approval', () => {
  const src = read(FINDING_DETAIL)
  // Existe a secao de previa, condicionada ao status pending_approval E ao
  // decision_preview presente.
  assert.match(
    src,
    /data\.status\s*===\s*'pending_approval'\s*&&\s*data\.decision_preview/,
    'a secao de previa deve aparecer quando pending_approval e ha decision_preview',
  )
  // Os dois ramos sao renderizados a partir do decision_preview.
  assert.match(
    src,
    /renderBranch\(\s*data\.decision_preview\.on_approve\s*,\s*t\('preview\.branchApprove'\)\s*\)/,
    'deve renderizar o ramo on_approve com o rotulo preview.branchApprove',
  )
  assert.match(
    src,
    /renderBranch\(\s*data\.decision_preview\.on_reject\s*,\s*t\('preview\.branchReject'\)\s*\)/,
    'deve renderizar o ramo on_reject com o rotulo preview.branchReject',
  )
})

test('AC1 ordem: os dois blocos de previa aparecem ANTES dos botoes Approve/Reject', () => {
  const src = read(FINDING_DETAIL)
  const approveBranchIdx = src.search(/renderBranch\(\s*data\.decision_preview\.on_approve/)
  const rejectBranchIdx = src.search(/renderBranch\(\s*data\.decision_preview\.on_reject/)
  // Ancora robusta (sem depender de markup/classe): o handler do botao Approve
  // (openDialog('approve')) e o do Reject (openDialog('reject')).
  const approveBtnIdx = src.search(/openDialog\(\s*'approve'\s*\)/)
  const rejectBtnIdx = src.search(/openDialog\(\s*'reject'\s*\)/)
  assert.ok(approveBranchIdx > -1, 'ramo on_approve deve ser renderizado')
  assert.ok(rejectBranchIdx > -1, 'ramo on_reject deve ser renderizado')
  assert.ok(approveBtnIdx > -1, 'o botao Approve (openDialog("approve")) deve existir')
  assert.ok(rejectBtnIdx > -1, 'o botao Reject (openDialog("reject")) deve existir')
  // Ambos os blocos de previa precedem ambos os handlers de decisao.
  const firstButtonIdx = Math.min(approveBtnIdx, rejectBtnIdx)
  assert.ok(approveBranchIdx < firstButtonIdx, 'o ramo Ao aprovar deve preceder os botoes de decisao')
  assert.ok(rejectBranchIdx < firstButtonIdx, 'o ramo Ao recusar deve preceder os botoes de decisao')
})

// ---------------------------------------------------------------------------
// AC1/AC5 — Os selos e textos sao SEMPRE via hook i18n (t('preview.*')); nunca
//           strings hard-coded no JSX dos blocos de previa.
// ---------------------------------------------------------------------------
test('AC5 i18n: selos (no-op/assist-only/audited) e impacto sao renderizados via t("preview.*"), nao hard-coded', () => {
  const src = read(FINDING_DETAIL)
  // Selos: cada Badge da previa usa o hook de traducao.
  assert.match(src, /branch\.assist_only\s*&&\s*<Badge[^>]*>\{t\('preview\.sealAssistOnly'\)\}/, 'selo assist-only via t()')
  assert.match(src, /branch\.is_noop\s*&&\s*<Badge[^>]*>\{t\('preview\.sealNoop'\)\}/, 'selo no-op via t()')
  assert.match(src, /branch\.audited\s*&&\s*<Badge[^>]*>\{t\('preview\.sealAudited'\)\}/, 'selo audited via t()')
  // Impacto de valor: escolhe a chave por kind (recoverable/exposure) e passa o amount.
  assert.match(
    src,
    /impact\.kind\s*===\s*'recoverable'\s*\?\s*'preview\.impactRecoverable'\s*:\s*'preview\.impactExposure'/,
    'o impacto de valor deve escolher a chave i18n conforme o kind',
  )
  assert.match(src, /amount:\s*impactAmount/, 'o impacto deve interpolar o valor monetario (amount)')
  // O titulo e os cabecalhos dos ramos vem do i18n.
  assert.match(src, /t\('preview\.title'\)/, 'o titulo da previa vem de t("preview.title")')
})

test('AC4/AC5 effectText: todos os 5 effect_key mapeiam para um texto i18n preview.* (sem strings cruas)', () => {
  const src = read(FINDING_DETAIL)
  // Cada effect_key produzido pelo espelho tem um case que retorna t('preview.<chave>').
  for (const [effectKey, i18nKey] of Object.entries(EFFECT_KEY_TO_I18N)) {
    assert.match(
      src,
      new RegExp(`case '${effectKey.replace('.', '\\.')}':`),
      `effectText deve tratar o effect_key '${effectKey}'`,
    )
    assert.match(
      src,
      new RegExp(`t\\('preview\\.${i18nKey}'`),
      `effectText deve usar t('preview.${i18nKey}') para '${effectKey}'`,
    )
  }
})

// ---------------------------------------------------------------------------
// AC4 — O espelho TS describeActionEffect cobre todos os effect_key (paridade
//       com o backend describe_action_effect). Garante que a UI nao invente
//       efeitos fora do conjunto fiel.
// ---------------------------------------------------------------------------
test('AC4 espelho: agentsApi.describeActionEffect produz exatamente os 5 effect_key fieis ao backend', () => {
  const src = read(AGENTS_API)
  assert.match(src, /export function describeActionEffect\(/, 'agentsApi deve exportar describeActionEffect')
  for (const effectKey of Object.keys(EFFECT_KEY_TO_I18N)) {
    assert.match(
      src,
      new RegExp(`effect_key:\\s*'${effectKey.replace('.', '\\.')}'`),
      `describeActionEffect deve emitir o effect_key '${effectKey}'`,
    )
  }
  // Fiel ao backend: so stock_aging_90d tem efeito executavel; demais sao assist-only.
  assert.match(src, /VEHICLE_AGING_FINDING_TYPE\s*=\s*'stock_aging_90d'/, 'tipo do agente de estoque envelhecido')
  assert.match(src, /DEFAULT_MARKDOWN_PCT\s*=\s*0\.1/, 'markdown fixo de 10% (espelho do backend)')
  assert.match(
    src,
    /PENDING_EXECUTION_ACTIONS\s*=\s*\[\s*'transfer',\s*'prioritize_sale',\s*'wholesale_auction'\s*\]/,
    'acoes de disposicao fieis ao backend',
  )
})

// ---------------------------------------------------------------------------
// AC4 — PARIDADE CROSS-LANGUAGE (runtime): EXECUTA o describeActionEffect real
//       do agentsApi.ts e compara sua saida, para TODA acao dos 4 agentes, com
//       a MESMA tabela compartilhada que fixa o describe_action_effect Python.
//       Fecha a lacuna de divergencia silenciosa entre Python e TS.
// ---------------------------------------------------------------------------
test('AC4 paridade runtime: TS describeActionEffect bate com a tabela compartilhada para todas as acoes/agentes', async () => {
  const describeActionEffect = await loadDescribeActionEffect()
  assert.equal(typeof describeActionEffect, 'function', 'describeActionEffect deve ser importavel e executavel')

  for (const c of PARITY_FIXTURE.cases) {
    const preview = describeActionEffect({
      finding_type: c.finding_type,
      proposed_action: c.proposed_action,
    })
    for (const branchName of ['on_approve', 'on_reject']) {
      const expected = c[branchName]
      const actual = preview[branchName]
      const where = `${c.name} / ${branchName}`
      assert.equal(actual.effect_key, expected.effect_key, `effect_key (${where})`)
      assert.equal(actual.is_noop, expected.is_noop, `is_noop (${where})`)
      assert.equal(actual.assist_only, expected.assist_only, `assist_only (${where})`)
      assert.equal(actual.audited, expected.audited, `audited (${where})`)
      const kind = actual.value_impact === null ? null : actual.value_impact.kind
      const amount = actual.value_impact === null ? null : actual.value_impact.amount
      assert.equal(kind, expected.value_impact_kind, `value_impact.kind (${where})`)
      // Contrato fiel: o amount permanece null (a regra e pura; o valor exibido
      // e o delta do achado). NUNCA inventar um amount aqui.
      assert.equal(amount, expected.value_impact_amount, `value_impact.amount (${where})`)
      assert.deepEqual(actual.params, expected.params, `params (${where})`)
    }
  }
})

test('AC4 paridade: a tabela compartilhada cobre todas as acoes dos 4 agentes', () => {
  const pairs = new Set(PARITY_FIXTURE.cases.map((c) => `${c.finding_type}::${c.proposed_action}`))
  for (const action of ['markdown', 'transfer', 'prioritize_sale', 'wholesale_auction', 'monitor', 'frobnicate', '']) {
    assert.ok(pairs.has(`stock_aging_90d::${action}`), `falta caso stock_aging_90d / '${action}'`)
  }
  const assistTypes = new Set(
    PARITY_FIXTURE.cases.filter((c) => c.finding_type !== 'stock_aging_90d').map((c) => c.finding_type),
  )
  for (const ft of ['estimate_rescue', 'collections_priority', 'replenish_now', 'dead_stock']) {
    assert.ok(assistTypes.has(ft), `falta agente assist-only '${ft}' na tabela`)
  }
})

// ---------------------------------------------------------------------------
// AC5 — Localizacao: TODA chave de previa (titulo, ramos, textos por effect_key,
//       selos e impactos) existe e nao e vazia em pt-BR E en-US.
// ---------------------------------------------------------------------------
test('AC5 i18n: todas as chaves screens.findingDetail.preview existem e nao sao vazias em ambas as locales', () => {
  const required = [
    'title',
    'branchApprove',
    'branchReject',
    ...Object.values(EFFECT_KEY_TO_I18N),
    ...SEAL_AND_IMPACT_KEYS,
  ]
  for (const [locale, relPath] of LOCALES) {
    const fd = readJson(relPath).screens.findingDetail
    assert.ok(fd && typeof fd.preview === 'object', `${locale} deve ter screens.findingDetail.preview`)
    for (const k of required) {
      assert.equal(typeof fd.preview[k], 'string', `${locale} deve definir preview.${k}`)
      assert.notEqual(fd.preview[k].trim(), '', `${locale} preview.${k} nao pode ser vazio`)
    }
  }
})

test('AC5 i18n: textos com placeholder preservam {pct}/{disposition}/{amount} em ambas as locales', () => {
  for (const [locale, relPath] of LOCALES) {
    const p = readJson(relPath).screens.findingDetail.preview
    assert.match(p.effectMarkdown, /\{pct\}/, `${locale} effectMarkdown deve interpolar {pct}`)
    assert.match(p.effectDisposition, /\{disposition\}/, `${locale} effectDisposition deve interpolar {disposition}`)
    assert.match(p.impactRecoverable, /\{amount\}/, `${locale} impactRecoverable deve interpolar {amount}`)
    assert.match(p.impactExposure, /\{amount\}/, `${locale} impactExposure deve interpolar {amount}`)
  }
})

// ---------------------------------------------------------------------------
// AC4 — Paridade de chaves entre as duas locales: nenhuma chave de previa existe
//       so em uma das locales (evita regressao de traducao parcial).
// ---------------------------------------------------------------------------
test('AC5 i18n: o conjunto de chaves de preview e identico entre pt-BR e en-US', () => {
  const ptKeys = Object.keys(readJson(PT_BR).screens.findingDetail.preview).sort()
  const enKeys = Object.keys(readJson(EN_US).screens.findingDetail.preview).sort()
  assert.deepEqual(ptKeys, enKeys, 'as chaves de preview devem ser identicas entre as locales')
})
