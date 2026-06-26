// Verificacao do "Historico de execucoes por agente" (issue #128 — spec
// docs/specs/128-feat-ops-historico-de-execucoes.md, unidade U5).
//
// Cobre o wiring read-only do painel de historico: helper de API, tela nativa
// registrada, botao no AgentsDashboard, polling 10s, uso de nome amigavel do
// agente e paridade i18n pt-BR/en-US do novo namespace.
//
// Roda com: node --test --experimental-strip-types scripts/verify-agent-run-history.mjs
// (o script "test" do package.json injeta a flag para este arquivo).
//
// Rastreabilidade dos criterios de aceite:
//  - AC1 — lista as ultimas N execucoes (limite default 10) com inicio/fim/duracao/status/achados.
//  - AC2 — ordenacao por started_at desc (delegada ao endpoint/view).
//  - AC5 — somente leitura (helper apenas faz GET; nenhuma mutacao).
//  - AC6 — estados loading/erro/vazio + polling 10s + i18n pt-BR/en-US.

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

const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'
const AGENTS_API = 'src/portal/lib/agentsApi.ts'
const REGISTRY = 'src/portal/renderers/registry.ts'
const DASHBOARD = 'src/portal/renderers/screens/AgentsDashboard.tsx'
const HISTORY_SCREEN = 'src/portal/renderers/screens/AgentRunHistory.tsx'

// AC1/AC5 — helper de API faz GET no endpoint read-only com limite default 10.
test('agentsApi: getAgentRunHistory faz GET /agents/{key}/runs com limite default 10', () => {
  const src = read(AGENTS_API)
  assert.match(src, /export\s+async\s+function\s+getAgentRunHistory/, 'deve exportar getAgentRunHistory')
  assert.match(src, /agentKey:\s*string,\s*\n?\s*limit\s*=\s*10/, 'limite default deve ser 10')
  assert.match(src, /\/agents\/\$\{encodeURIComponent\(agentKey\)\}\/runs\?limit=/, 'deve chamar /agents/{key}/runs?limit=')
  assert.match(src, /export\s+interface\s+AgentRunHistoryRow/, 'deve exportar o tipo AgentRunHistoryRow')
  // Somente leitura: nenhuma chamada de mutacao no helper.
  const fn = src.slice(src.indexOf('export async function getAgentRunHistory'))
  assert.doesNotMatch(fn.slice(0, 600), /method:\s*['"]POST['"]/, 'helper de historico nao deve mutar (sem POST)')
})

// Tela nativa registrada no registry (kind=component).
test('registry: agent-run-history aponta para AgentRunHistory', () => {
  const src = read(REGISTRY)
  assert.match(
    src,
    /'agent-run-history':\s*lazy\(\(\)\s*=>\s*import\('@\/portal\/renderers\/screens\/AgentRunHistory'\)\)/,
    'registry deve mapear agent-run-history -> AgentRunHistory',
  )
})

// AgentsDashboard abre o historico via openWindow(component, params.agentKey).
test('AgentsDashboard: botao Historico abre a janela agent-run-history', () => {
  const src = read(DASHBOARD)
  assert.match(src, /componentKey:\s*'agent-run-history'/, 'deve abrir a janela agent-run-history')
  assert.match(src, /t\(\s*['"]history['"]\s*\)/, "deve renderizar o rotulo t('history')")
})

// AC1/AC6 — a tela usa nome amigavel do agente, polling 10s e os tres estados.
test('AgentRunHistory: nome amigavel, polling 10s e estados de UI', () => {
  const src = read(HISTORY_SCREEN)
  assert.match(src, /useFindingLabels\(\)/, 'deve usar useFindingLabels (nome amigavel)')
  assert.match(src, /agentLabel\(/, 'deve renderizar via agentLabel, nunca agent_key cru')
  assert.match(src, /setInterval\(\s*load\s*,\s*10000\s*\)/, 'deve fazer polling de 10s')
  // Sem vazamento de polling: o efeito limpa o timer no cleanup.
  assert.match(src, /clearInterval\(/, 'deve limpar o timer (clearInterval) no cleanup do efeito')
  assert.match(src, /t\(\s*['"]loading['"]\s*\)/, "estado de carregando t('loading')")
  assert.match(src, /t\(\s*['"]error['"]\s*\)/, "estado de erro t('error')")
  assert.match(src, /t\(\s*['"]empty['"]\s*\)/, "estado vazio t('empty')")
  // AC1 — colunas inicio/fim/duracao/status/achados.
  for (const key of ['columnStart', 'columnEnd', 'columnDuration', 'columnStatus', 'columnFindings']) {
    assert.match(src, new RegExp(`t\\(\\s*['"]${key}['"]`), `deve renderizar a coluna ${key}`)
    assert.match(src, /findings_emitted/, 'deve exibir findings_emitted')
  }
})

// AC6 — paridade i18n: ambos os locales definem o namespace agentRunHistory
// (mesmas chaves, nao-vazias) e a chave history no agentsDashboard.
test('i18n: namespace agentRunHistory presente e com paridade pt-BR/en-US', () => {
  const pt = readJson(PT_BR).screens
  const en = readJson(EN_US).screens
  assert.ok(pt.agentRunHistory, 'pt-BR deve definir screens.agentRunHistory')
  assert.ok(en.agentRunHistory, 'en-US deve definir screens.agentRunHistory')
  const ptKeys = Object.keys(pt.agentRunHistory).sort()
  const enKeys = Object.keys(en.agentRunHistory).sort()
  assert.deepEqual(ptKeys, enKeys, 'chaves de agentRunHistory devem ser identicas entre locales')
  for (const k of ptKeys) {
    assert.notEqual(String(pt.agentRunHistory[k]).trim(), '', `pt-BR ${k} nao pode ser vazio`)
    assert.notEqual(String(en.agentRunHistory[k]).trim(), '', `en-US ${k} nao pode ser vazio`)
  }
  // Rotulo do botao no dashboard.
  assert.equal(typeof pt.agentsDashboard.history, 'string')
  assert.equal(typeof en.agentsDashboard.history, 'string')
})

// AC1/AC6 — subtitle usa arg ICU {agent} (nunca .replace).
test('i18n: subtitle de agentRunHistory usa o arg ICU {agent}', () => {
  const pt = readJson(PT_BR).screens.agentRunHistory
  const en = readJson(EN_US).screens.agentRunHistory
  assert.match(pt.subtitle, /\{agent\}/, 'pt-BR subtitle deve conter {agent}')
  assert.match(en.subtitle, /\{agent\}/, 'en-US subtitle deve conter {agent}')
})
