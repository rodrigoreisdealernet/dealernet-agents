// Verificacao dependency-free do wiring do frontend para a issue #66
// (Disparo imediato "Executar agora" para agentes ops).
//
// Roda com: node --test scripts/verify-issue66-wiring.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/66-disparo-imediato-executar-agora-para.md) que verifica.

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

function exportedFnBody(src, signature) {
  const start = src.indexOf(signature)
  assert.ok(start !== -1, `assinatura nao encontrada: ${signature}`)
  const next = src.indexOf('\nexport ', start + signature.length)
  return src.slice(start, next === -1 ? undefined : next)
}

const AGENTS_API = 'src/portal/lib/agentsApi.ts'
const AGENTS_DASHBOARD = 'src/portal/renderers/screens/AgentsDashboard.tsx'
const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'

test('AC1/AC2 api: runAgentNow posta no endpoint generico autenticado', () => {
  const src = read(AGENTS_API)
  assert.match(
    src,
    /export\s+async\s+function\s+runAgentNow\s*\(\s*agentKey:\s*string\s*\)/,
    'agentsApi deve exportar runAgentNow(agentKey)',
  )

  const body = exportedFnBody(src, 'function runAgentNow')
  assert.match(body, /const\s+token\s*=\s*await\s+getAccessToken\(\)/, 'deve obter token via getAccessToken()')
  assert.match(
    body,
    /fetch\(\s*`\$\{OPS_API_URL\}\/agents\/\$\{encodeURIComponent\(agentKey\)\}\/run`/,
    'deve postar em ${OPS_API_URL}/agents/${encodeURIComponent(agentKey)}/run',
  )
  assert.match(body, /method:\s*['"]POST['"]/, 'deve usar metodo POST')
  assert.match(
    body,
    /Authorization:\s*`Bearer\s+\$\{token\}`/,
    'deve enviar Authorization: Bearer <token>',
  )
})

test('AC6 button wiring: AgentsDashboard renderiza Executar agora e chama runAgentNow sem abrir card', () => {
  const src = read(AGENTS_DASHBOARD)
  assert.match(src, /import\s+\{[^}]*runAgentNow[^}]*\}\s+from\s+['"]@\/portal\/lib\/agentsApi['"]/, 'deve importar runAgentNow')
  assert.match(src, /t\(\s*['"]runNow['"]\s*\)/, "deve rotular o controle com t('runNow')")

  const handler = src.slice(src.indexOf('const handleRunNow'), src.indexOf('useEffect', src.indexOf('const handleRunNow')))
  assert.match(handler, /await\s+runAgentNow\(\s*agentKey\s*\)/, 'handleRunNow deve chamar runAgentNow(agentKey)')
  assert.match(
    src,
    /onClick=\{\(event\)\s*=>\s*\{[\s\S]*?event\.stopPropagation\(\)[\s\S]*?handleRunNow\(a\.agent_key\)[\s\S]*?\}\}/,
    'botao Executar agora deve parar propagacao e chamar handleRunNow(a.agent_key)',
  )
})

test('AC disabled when inactive: botao Executar agora fica desabilitado para agente inativo', () => {
  const src = read(AGENTS_DASHBOARD)
  assert.match(
    src,
    /disabled=\{\s*!a\.enabled\s*\|\|[^}]*isRunning[^}]*\}/,
    'botao deve usar disabled={!a.enabled || isRunning}',
  )
})

test('AC6 feedback states: tela renderiza running, sucesso e erro do disparo', () => {
  const src = read(AGENTS_DASHBOARD)
  for (const state of ['running', 'success', 'error']) {
    assert.match(src, new RegExp(`status:\\s*'${state}'`), `deve registrar estado ${state}`)
  }
  assert.match(src, /t\(\s*['"]running['"]\s*\)/, "deve renderizar t('running')")
  assert.match(src, /t\(\s*['"]runSuccess['"]\s*\)/, "deve renderizar t('runSuccess')")
  assert.match(src, /runNowState\.message\s*\|\|\s*t\(\s*['"]runError['"]\s*\)/, "deve renderizar mensagem de erro ou t('runError')")
})

test('AC6 no nested button regression: card externo e div, nao botao', () => {
  const src = read(AGENTS_DASHBOARD)
  assert.match(
    src,
    /<div\s*\n\s*key=\{a\.agent_key\}/,
    'card externo deve ser <div key={a.agent_key}>',
  )
  assert.doesNotMatch(
    src,
    /<button\s*\n\s*key=\{a\.agent_key\}/,
    'card externo nao deve voltar a ser <button key={a.agent_key}>',
  )
})

test('AC6 i18n: run-now keys existem em pt-BR e en-US', () => {
  for (const [locale, relPath] of [
    ['pt-BR', PT_BR],
    ['en-US', EN_US],
  ]) {
    const block = readJson(relPath).screens.agentsDashboard
    for (const key of ['runNow', 'running', 'runSuccess', 'runError']) {
      assert.equal(typeof block[key], 'string', `${locale} deve definir screens.agentsDashboard.${key}`)
      assert.notEqual(block[key].trim(), '', `${locale} ${key} nao pode ser vazio`)
    }
  }
})
