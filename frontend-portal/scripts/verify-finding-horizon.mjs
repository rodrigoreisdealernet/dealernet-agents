// Verificacao dependency-free do horizonte preditivo em FindingDetail
// (issue #127). Asserta sobre o TEXTO-FONTE; nao precisa de node_modules.
//
// Roda com: node --test scripts/verify-finding-horizon.mjs

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
const HORIZON_KEYS = ['horizon', 'horizonDays', 'horizonPastDays', 'horizonDate']

// ---------------------------------------------------------------------------
// AC5: FindingDetail mostra o horizonte quando days_to_breach ou
//      predicted_breach_at existem, usando labels localizados.
// ---------------------------------------------------------------------------
test('AC5 FindingDetail: renderiza horizonte a partir dos dados do finding', () => {
  const src = read(FINDING_DETAIL)

  assert.match(src, /const\s+horizonLabel\s*=/, 'deve calcular horizonLabel')
  assert.match(src, /data\.days_to_breach\s*!==\s*null/, 'deve ler days_to_breach do finding')
  assert.match(src, /data\.predicted_breach_at\b/, 'deve ler predicted_breach_at do finding')
  assert.match(src, /t\(\s*['"]horizonDays['"]/, 'deve formatar horizonte em dias')
  assert.match(src, /t\(\s*['"]horizonPastDays['"]/, 'deve formatar horizonte vencido')
  assert.match(src, /t\(\s*['"]horizonDate['"]/, 'deve formatar horizonte por data quando dias nao existe')
  assert.match(src, /\{\s*horizonLabel\s*&&\s*\(/, 'deve renderizar o bloco apenas quando ha label')
  assert.match(src, /t\(\s*['"]horizon['"]\s*\)/, 'deve renderizar o rotulo localizado do horizonte')
})

// ---------------------------------------------------------------------------
// AC5: ausencia de horizonte nao deve renderizar null ou artefato vazio.
// ---------------------------------------------------------------------------
test('AC5 FindingDetail: oculta horizonte quando o valor e nulo', () => {
  const src = read(FINDING_DETAIL)

  assert.match(src, /:\s*null\s*(?:\n\s*)?const\s+approver\b/, 'horizonLabel deve cair para null')
  assert.match(src, /\{\s*horizonLabel\s*&&\s*\(/, 'null deve impedir renderizacao do bloco')
  assert.doesNotMatch(src, />\s*\{\s*data\.days_to_breach\s*\}\s*</, 'nao deve despejar numero/null cru no DOM')
  assert.doesNotMatch(src, />\s*\{\s*data\.predicted_breach_at\s*\}\s*</, 'nao deve despejar data/null crua no DOM')
})

// ---------------------------------------------------------------------------
// AC1/AC5: getFinding extrai o horizonte do jsonb expected antes da tela usar.
// ---------------------------------------------------------------------------
test('AC1/AC5 agentsApi: extrai days_to_breach/predicted_breach_at do expected jsonb', () => {
  const src = read(AGENTS_API)

  assert.match(src, /export\s+interface\s+FindingHorizon/, 'deve expor o shape FindingHorizon')
  assert.match(src, /expected\?\.predicted_breach_at/, 'deve ler predicted_breach_at de expected')
  assert.match(src, /finiteNumberOrNull\(\s*expected\?\.days_to_breach\s*\)/, 'deve normalizar days_to_breach')
  assert.match(src, /return\s+\{\s*\.\.\.finding,\s*\.\.\.extractFindingHorizon\(finding\.expected\)\s*\}/, 'getFinding deve combinar o horizonte extraido')
})

// ---------------------------------------------------------------------------
// AC5: pt-BR e en-US trazem todas as chaves de label do horizonte.
// ---------------------------------------------------------------------------
test('AC5 i18n: labels de horizonte existem em pt-BR e en-US', () => {
  for (const [locale, relPath] of [
    ['pt-BR', PT_BR],
    ['en-US', EN_US],
  ]) {
    const messages = readJson(relPath).screens?.findingDetail
    assert.ok(messages, `${locale} deve definir screens.findingDetail`)
    for (const key of HORIZON_KEYS) {
      assert.equal(typeof messages[key], 'string', `${locale} deve definir ${key}`)
      assert.notEqual(messages[key].trim(), '', `${locale} ${key} nao pode ser vazio`)
    }
  }

  const pt = readJson(PT_BR).screens.findingDetail
  const en = readJson(EN_US).screens.findingDetail
  assert.notEqual(pt.horizon, en.horizon, 'rotulo principal deve ser localizado')
  assert.match(pt.horizonDays, /Estoura/, 'pt-BR deve usar texto humano em portugues')
  assert.match(en.horizonDays, /Breaks/, 'en-US deve usar texto humano em ingles')
})
