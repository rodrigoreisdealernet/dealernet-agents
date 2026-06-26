// Verificacao dependency-free do rotulo do Morning Brief para a issue #102
// (rotulo do periodo deve dizer DIA ANTERIOR / "Ontem", nao "Mes Atual").
//
// Esta e' uma mudanca puramente de rotulo + i18n (sem runtime/DB): seguimos o
// padrao do repo (scripts/verify-issue43-wiring.mjs) — modulos nativos do Node
// (node:test, node:assert, node:fs), lendo os arquivos-fonte e assertando contra
// o CONTEUDO que a reversao do rotulo (dia-anterior) esta no lugar e nao regride
// para o conceito de mes-corrente (MTD). Os JSON de i18n sao parseados como
// objeto (nao so substring) para robustez.
//
// Roda com: node --test scripts/verify-issue102-labels.mjs
//
// Cada teste mapeia o criterio de aceite da spec
// docs/specs/102-morning-brief-frontend-rotulo-do.md que verifica.

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
  const raw = read(relPath)
  // AC build: JSON tem de continuar valido (guarda contra edicao quebrada).
  return JSON.parse(raw)
}

const MORNING_BRIEF = 'src/portal/renderers/screens/MorningBrief.tsx'
const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'

// Isola o corpo da funcao briefDateLabel (do nome ate a proxima 'function ' de
// topo) para assertar so no escopo certo.
function briefDateLabelBody(src) {
  const start = src.indexOf('function briefDateLabel')
  assert.ok(start !== -1, 'MorningBrief deve declarar function briefDateLabel')
  const next = src.indexOf('\nfunction ', start + 1)
  const end2 = src.indexOf('\nexport ', start + 1)
  const cut = [next, end2].filter((i) => i !== -1).sort((a, b) => a - b)[0]
  return src.slice(start, cut === undefined ? undefined : cut)
}

// ===========================================================================
// AC: briefDateLabel() retorna a DATA DO DIA ANTERIOR formatada localmente
// (qui, 25 jun / Thu, Jun 25), nao mes/ano.
// ===========================================================================

test('AC briefDateLabel: computa o DIA ANTERIOR (setDate(getDate() - 1))', () => {
  const body = briefDateLabelBody(read(MORNING_BRIEF))
  // Offset de ontem: d.setDate(d.getDate() - 1).
  assert.match(
    body,
    /setDate\(\s*[A-Za-z0-9_.]*\.getDate\(\)\s*-\s*1\s*\)/,
    'briefDateLabel deve recuar 1 dia: setDate(...getDate() - 1)',
  )
})

test('AC briefDateLabel: formata weekday/day/month (dia da semana + dia + mes curto)', () => {
  const body = briefDateLabelBody(read(MORNING_BRIEF))
  assert.match(body, /toLocaleDateString\(/, 'briefDateLabel deve formatar via toLocaleDateString')
  assert.match(body, /weekday:\s*['"]short['"]/, "deve usar weekday: 'short'")
  assert.match(body, /day:\s*['"]numeric['"]/, "deve usar day: 'numeric'")
  assert.match(body, /month:\s*['"]short['"]/, "deve usar month: 'short'")
})

test('AC briefDateLabel (negativo): NAO retorna mais o rotulo mes-corrente (month long + year)', () => {
  const body = briefDateLabelBody(read(MORNING_BRIEF))
  // Reversao MTD: briefDateLabel nao pode voltar a formatar mes-por-extenso/ano.
  assert.doesNotMatch(body, /month:\s*['"]long['"]/, 'briefDateLabel nao deve usar month long (mes-corrente)')
  assert.doesNotMatch(body, /year:\s*['"]numeric['"]/, 'briefDateLabel nao deve incluir year (mes/ano)')
})

// ===========================================================================
// AC: a tela usa t('previousDay') / t('noPreviousDayData') e NAO referencia
// mais t('currentMonth') / t('noMonthData').
// ===========================================================================

test("AC tela: usa t('previousDay') e t('noPreviousDayData')", () => {
  const src = read(MORNING_BRIEF)
  assert.match(src, /t\(\s*['"]previousDay['"]\s*\)/, "a tela deve usar t('previousDay') no periodo")
  assert.match(src, /t\(\s*['"]noPreviousDayData['"]\s*\)/, "o estado vazio deve usar t('noPreviousDayData')")
})

test("AC tela (negativo): nao referencia mais t('currentMonth') / t('noMonthData')", () => {
  const src = read(MORNING_BRIEF)
  assert.doesNotMatch(src, /t\(\s*['"]currentMonth['"]\s*\)/, "a tela nao deve referenciar t('currentMonth')")
  assert.doesNotMatch(src, /t\(\s*['"]noMonthData['"]\s*\)/, "a tela nao deve referenciar t('noMonthData')")
})

// ===========================================================================
// AC i18n PT-BR: previousDay = "Ontem", noPreviousDayData (vendas de ontem),
// sem chaves currentMonth/noMonthData. desktopTitle reflete "dia anterior".
// ===========================================================================

test('AC i18n pt-BR: previousDay = "Ontem" e noPreviousDayData (ontem)', () => {
  const mb = readJson(PT_BR).screens.morningBrief
  assert.equal(mb.previousDay, 'Ontem', 'pt-BR.previousDay deve ser "Ontem"')
  assert.ok(/ontem/i.test(mb.noPreviousDayData), 'pt-BR.noPreviousDayData deve falar de "ontem"')
})

test('AC i18n pt-BR (negativo): sem currentMonth/noMonthData no namespace', () => {
  const mb = readJson(PT_BR).screens.morningBrief
  assert.ok(!('currentMonth' in mb), 'pt-BR nao deve ter mais a chave currentMonth')
  assert.ok(!('noMonthData' in mb), 'pt-BR nao deve ter mais a chave noMonthData')
})

test('AC i18n pt-BR: desktopTitle reflete dia anterior, nao "mes"', () => {
  const mb = readJson(PT_BR).screens.morningBrief
  assert.match(mb.desktopTitle, /dia anterior/i, 'pt-BR.desktopTitle deve dizer "dia anterior"')
  assert.doesNotMatch(mb.desktopTitle, /m[eê]s/i, 'pt-BR.desktopTitle nao deve mencionar "mes"')
})

// ===========================================================================
// AC i18n EN-US: previousDay = "Yesterday", noPreviousDayData (yesterday),
// sem chaves currentMonth/noMonthData. desktopTitle reflete "previous day".
// ===========================================================================

test('AC i18n en-US: previousDay = "Yesterday" e noPreviousDayData (yesterday)', () => {
  const mb = readJson(EN_US).screens.morningBrief
  assert.equal(mb.previousDay, 'Yesterday', 'en-US.previousDay deve ser "Yesterday"')
  assert.ok(/yesterday/i.test(mb.noPreviousDayData), 'en-US.noPreviousDayData deve falar de "yesterday"')
})

test('AC i18n en-US (negativo): sem currentMonth/noMonthData no namespace', () => {
  const mb = readJson(EN_US).screens.morningBrief
  assert.ok(!('currentMonth' in mb), 'en-US nao deve ter mais a chave currentMonth')
  assert.ok(!('noMonthData' in mb), 'en-US nao deve ter mais a chave noMonthData')
})

test('AC i18n en-US: desktopTitle reflete previous day, nao "month"', () => {
  const mb = readJson(EN_US).screens.morningBrief
  assert.match(mb.desktopTitle, /previous day/i, 'en-US.desktopTitle deve dizer "previous day"')
  assert.doesNotMatch(mb.desktopTitle, /month/i, 'en-US.desktopTitle nao deve mencionar "month"')
})

// ===========================================================================
// AC build: ambos os JSON permanecem JSON valido (guarda edicao quebrada).
// (readJson ja faz JSON.parse; aqui afirmamos a forma esperada do namespace.)
// ===========================================================================

test('AC build: pt-BR.json e en-US.json sao JSON valido com screens.morningBrief', () => {
  for (const f of [PT_BR, EN_US]) {
    const json = readJson(f)
    assert.equal(typeof json.screens.morningBrief, 'object', `${f} deve ter screens.morningBrief como objeto`)
  }
})
