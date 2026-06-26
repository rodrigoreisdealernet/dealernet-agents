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
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

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
  // O bloco de botoes de decisao (ternario pending_approval com <button>).
  const buttonsIdx = src.search(/data\.status\s*===\s*'pending_approval'\s*\?\s*\(\s*\n?\s*<div className="flex gap-2">/)
  assert.ok(approveBranchIdx > -1, 'ramo on_approve deve ser renderizado')
  assert.ok(rejectBranchIdx > -1, 'ramo on_reject deve ser renderizado')
  assert.ok(buttonsIdx > -1, 'o bloco de botoes Approve/Reject deve existir')
  assert.ok(approveBranchIdx < buttonsIdx, 'o ramo Ao aprovar deve preceder os botoes')
  assert.ok(rejectBranchIdx < buttonsIdx, 'o ramo Ao recusar deve preceder os botoes')
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
