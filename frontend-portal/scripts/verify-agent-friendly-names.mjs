// Verificacao dependency-free: TODOS os agentes ops tem nome amigavel, tanto no
// Painel de Agentes quanto nas tarefas (findings) que eles geram. Asserta sobre
// o TEXTO-FONTE; nao precisa de node_modules.
//
// Roda com: node --test scripts/verify-agent-friendly-names.mjs
//
// Cobre: o painel (AgentsDashboard / ExecutivePack) e as tarefas geradas
// (FindingDetail / FindingsQueue) mostram nomes amigaveis e localizados — sem
// codigos crus de agent_key — para cada agente ops ativo.

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
const AGENTS_DASHBOARD = 'src/portal/renderers/screens/AgentsDashboard.tsx'
const EXECUTIVE_PACK = 'src/portal/renderers/screens/ExecutivePack.tsx'
const FINDING_DETAIL = 'src/portal/renderers/screens/FindingDetail.tsx'

// Agentes ops ativos (ops_agent_config_current / ops_agent_status_view).
const AGENTS = [
  'vehicle-aging-analyst',
  'collections-prioritizer',
  'parts-inventory-advisor',
  'service-estimate-rescue',
]

// ---------------------------------------------------------------------------
// Todo agente ops ativo tem nome amigavel nao-vazio em pt-BR e en-US, diferente
// do codigo cru (prova de que e um nome humano, nao apenas o eco do agent_key).
// ---------------------------------------------------------------------------
test('i18n: todo agente ops ativo tem nome amigavel nao-vazio e != codigo cru (pt-BR e en-US)', () => {
  for (const [locale, relPath] of [
    ['pt-BR', PT_BR],
    ['en-US', EN_US],
  ]) {
    const agentsLabels = readJson(relPath).labels?.agents
    assert.ok(agentsLabels, `${locale} deve definir labels.agents`)
    for (const key of AGENTS) {
      assert.equal(typeof agentsLabels[key], 'string', `${locale} deve definir labels.agents["${key}"]`)
      assert.notEqual(agentsLabels[key].trim(), '', `${locale} labels.agents["${key}"] nao pode ser vazio`)
      assert.notEqual(agentsLabels[key], key, `${locale} labels.agents["${key}"] nao pode ser o codigo cru`)
    }
  }
})

// ---------------------------------------------------------------------------
// Painel: AgentsDashboard renderiza o nome amigavel no card e no titulo da fila,
// e nao exibe mais o codigo cru {a.agent_key} como rotulo do card.
// ---------------------------------------------------------------------------
test('painel: AgentsDashboard usa agentLabel no card e no titulo, sem codigo cru', () => {
  const src = read(AGENTS_DASHBOARD)
  assert.match(
    src,
    /import\s+\{[^}]*useFindingLabels[^}]*\}\s+from\s+['"]@\/portal\/lib\/findingLabels['"]/,
    'deve importar useFindingLabels',
  )
  assert.match(src, /useFindingLabels\(\)/, 'deve invocar useFindingLabels()')
  assert.match(src, /agentLabel\(\s*a\.agent_key\s*\)/, 'card deve renderizar agentLabel(a.agent_key)')
  assert.match(src, /agentLabel\(\s*agentKey\s*\)/, 'titulo da fila deve usar agentLabel(agentKey)')

  // Regressao: o rotulo do card nao pode voltar a ser o codigo cru.
  assert.doesNotMatch(src, />\{\s*a\.agent_key\s*\}</, 'nao deve renderizar {a.agent_key} cru como rotulo')
})

// ---------------------------------------------------------------------------
// Painel: ExecutivePack (breakdown por agente) usa o nome amigavel.
// ---------------------------------------------------------------------------
test('painel: ExecutivePack usa agentLabel no breakdown por agente, sem codigo cru', () => {
  const src = read(EXECUTIVE_PACK)
  assert.match(
    src,
    /import\s+\{[^}]*useFindingLabels[^}]*\}\s+from\s+['"]@\/portal\/lib\/findingLabels['"]/,
    'deve importar useFindingLabels',
  )
  assert.match(src, /agentLabel\(\s*a\.agent_key\s*\)/, 'deve renderizar agentLabel(a.agent_key)')
  assert.doesNotMatch(src, />\{\s*a\.agent_key\s*\}</, 'nao deve renderizar {a.agent_key} cru como rotulo')
})

// ---------------------------------------------------------------------------
// Tarefas geradas: FindingDetail mostra o agente da tarefa com nome amigavel.
// ---------------------------------------------------------------------------
test('tarefa: FindingDetail usa agentLabel(data.agent_key), sem codigo cru', () => {
  const src = read(FINDING_DETAIL)
  assert.match(
    src,
    /import\s+\{[^}]*useFindingLabels[^}]*\}\s+from\s+['"]@\/portal\/lib\/findingLabels['"]/,
    'deve importar useFindingLabels',
  )
  assert.match(src, /agentLabel\(\s*data\.agent_key\s*\)/, 'deve renderizar agentLabel(data.agent_key)')
  assert.doesNotMatch(src, /\{\s*data\.agent_key\s*\}/, 'nao deve renderizar {data.agent_key} cru')
})
