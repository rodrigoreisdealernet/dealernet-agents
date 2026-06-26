// Verificacao dependency-free da ficha de missao dos agentes DIA (issue #125 —
// catalogo estatico de missao + cards no painel de agentes). Asserta sobre o
// TEXTO-FONTE (i18n JSON + AgentsDashboard.tsx); nao precisa de node_modules.
//
// Roda com: node --test scripts/verify-agent-missions.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/125-feat-ops-ficha-de-missao.md) que verifica.

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
const FINDING_LABELS = 'src/portal/lib/findingLabels.ts'
const AGENTS_API = 'src/portal/lib/agentsApi.ts'

const LOCALES = [
  ['pt-BR', PT_BR],
  ['en-US', EN_US],
]

// Os 4 agentes DIA cobertos por esta unidade — exatamente estes, nem mais.
const DIA_AGENTS = [
  'vehicle-aging-analyst',
  'collections-prioritizer',
  'parts-inventory-advisor',
  'service-estimate-rescue',
]
const MISSION_FIELDS = ['objective', 'data', 'predicts']

// Vocabulario de acoes referenciado pelo catalogo (uniao das acoes dos 4
// agentes — mantido em sincronia com agent_catalog.py). Cada code precisa ter
// rotulo i18n em ambos os locales.
const CATALOG_ACTION_CODES = [
  // vehicle-aging-analyst
  'monitor',
  'markdown',
  'transfer',
  'prioritize_sale',
  'wholesale_auction',
  // collections-prioritizer
  'contact_customer',
  'payment_plan',
  'escalate',
  'send_to_collections',
  // parts-inventory-advisor
  'replenish',
  'expedite_order',
  'substitute_part',
  // service-estimate-rescue
  'offer_discount',
  'reprice',
]

// ---------------------------------------------------------------------------
// AC "Conteúdo 100% via i18n, em pt-BR e en-US": cada um dos 4 agentes DIA tem
// labels.agentMissions.<key>.{objective,data,predicts} traduzido e nao-vazio em
// AMBOS os locales — nenhuma chave i18n crua fica sem traducao.
// ---------------------------------------------------------------------------
test('AC i18n: agentMissions.<key>.{objective,data,predicts} existem e nao-vazios em pt-BR e en-US', () => {
  for (const [locale, relPath] of LOCALES) {
    const missions = readJson(relPath).labels?.agentMissions
    assert.ok(missions, `${locale} deve definir labels.agentMissions`)

    // Exatamente os 4 agentes DIA — nem mais, nem menos.
    assert.deepEqual(
      Object.keys(missions).sort(),
      [...DIA_AGENTS].sort(),
      `${locale} labels.agentMissions deve cobrir exatamente os 4 agentes DIA`,
    )

    for (const agent of DIA_AGENTS) {
      const card = missions[agent]
      assert.ok(card, `${locale} deve definir labels.agentMissions.${agent}`)
      for (const field of MISSION_FIELDS) {
        assert.equal(
          typeof card[field],
          'string',
          `${locale} deve definir labels.agentMissions.${agent}.${field}`,
        )
        assert.notEqual(
          card[field].trim(),
          '',
          `${locale} labels.agentMissions.${agent}.${field} nao pode ser vazio`,
        )
        // Nao pode ser o eco da propria chave crua (prova de texto humano).
        assert.notEqual(
          card[field],
          `labels.agentMissions.${agent}.${field}`,
          `${locale} labels.agentMissions.${agent}.${field} nao pode ser a chave crua`,
        )
      }
    }
  }
})

// ---------------------------------------------------------------------------
// AC "Conteúdo ... traduzido": o texto da ficha realmente difere entre locales
// (prova de que pt-BR e en-US sao traducoes reais, nao copia).
// ---------------------------------------------------------------------------
test('AC i18n: a ficha de missao difere entre pt-BR e en-US (traducao real)', () => {
  const pt = readJson(PT_BR).labels.agentMissions
  const en = readJson(EN_US).labels.agentMissions
  for (const agent of DIA_AGENTS) {
    for (const field of MISSION_FIELDS) {
      assert.notEqual(
        pt[agent][field],
        en[agent][field],
        `labels.agentMissions.${agent}.${field} deveria diferir entre pt-BR e en-US`,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// AC "Vocabulário de ações bate com o código real": cada code de acao do
// catalogo tem rotulo i18n nao-vazio (e != codigo cru) em AMBOS os locales.
// ---------------------------------------------------------------------------
test('AC acoes: todo code de acao do catalogo tem rotulo i18n nao-vazio em pt-BR e en-US', () => {
  for (const [locale, relPath] of LOCALES) {
    const actions = readJson(relPath).labels?.actions
    assert.ok(actions, `${locale} deve definir labels.actions`)
    for (const code of CATALOG_ACTION_CODES) {
      assert.equal(typeof actions[code], 'string', `${locale} deve definir labels.actions.${code}`)
      assert.notEqual(actions[code].trim(), '', `${locale} labels.actions.${code} nao pode ser vazio`)
      assert.notEqual(actions[code], code, `${locale} labels.actions.${code} nao pode ser o codigo cru`)
    }
  }
})

// ---------------------------------------------------------------------------
// AC "Card de missão ... selo assist-only": os rotulos do chrome do card
// (mission, assistOnly, objective, dataAnalyzed, predicts, possibleActions)
// existem e nao sao vazios em ambos os locales.
// ---------------------------------------------------------------------------
test('AC card: rotulos do card de missao (incl. assistOnly) existem em pt-BR e en-US', () => {
  const chromeKeys = ['mission', 'assistOnly', 'objective', 'dataAnalyzed', 'predicts', 'possibleActions']
  for (const [locale, relPath] of LOCALES) {
    const dash = readJson(relPath).screens?.agentsDashboard
    assert.ok(dash, `${locale} deve definir screens.agentsDashboard`)
    for (const key of chromeKeys) {
      assert.equal(typeof dash[key], 'string', `${locale} deve definir screens.agentsDashboard.${key}`)
      assert.notEqual(dash[key].trim(), '', `${locale} screens.agentsDashboard.${key} nao pode ser vazio`)
    }
  }
})

// ---------------------------------------------------------------------------
// AC: o accessor missionText resolve a chave i18n completa e NUNCA cai para a
// chave crua (cai para '' para esconder a linha quando falta traducao).
// ---------------------------------------------------------------------------
test('AC hook: findingLabels.ts expoe missionText com fallback para vazio (nunca chave crua)', () => {
  const src = read(FINDING_LABELS)
  assert.match(src, /missionText/, 'deve expor missionText')
  // Le o namespace raiz para resolver chaves completas labels.agentMissions.*
  assert.match(src, /useTranslations\(\)/, 'deve ler o namespace raiz via useTranslations()')
  // missionText e exportado pelo hook.
  assert.match(
    src,
    /return\s*\{[^}]*missionText[^}]*\}/,
    'useFindingLabels deve retornar missionText',
  )
  // Fallback para '' (string vazia), nunca para a propria key.
  assert.match(src, /root\.has\(\s*key\s*\)\s*\?\s*root\(\s*key\s*\)\s*:\s*['"]['"]/, 'missionText deve cair para string vazia')
})

// ---------------------------------------------------------------------------
// AC "Card de missão" + "Conteúdo 100% via i18n": AgentsDashboard renderiza o
// card de missao via i18n (missionText / actionLabel / t('...')), com selo
// assist-only, e NUNCA renderiza as chaves cruas do catalogo.
// ---------------------------------------------------------------------------
test('AC painel: AgentsDashboard renderiza o card de missao via i18n, sem chave crua', () => {
  const src = read(AGENTS_DASHBOARD)

  // Importa o catalogo e o hook de labels.
  assert.match(src, /getAgentCatalog/, 'deve importar/usar getAgentCatalog')
  assert.match(
    src,
    /import\s+\{[^}]*useFindingLabels[^}]*\}\s+from\s+['"]@\/portal\/lib\/findingLabels['"]/,
    'deve importar useFindingLabels',
  )
  assert.match(src, /missionText/, 'deve usar missionText do hook')
  assert.match(src, /actionLabel/, 'deve usar actionLabel para as acoes')

  // Resolve objetivo/dados/prevê via missionText sobre as chaves do catalogo.
  assert.match(src, /missionText\(\s*mission\.objective_key\s*\)/, 'deve renderizar missionText(mission.objective_key)')
  assert.match(src, /missionText\(\s*mission\.data_key\s*\)/, 'deve renderizar missionText(mission.data_key)')
  assert.match(src, /missionText\(\s*mission\.predicts_key\s*\)/, 'deve renderizar missionText(mission.predicts_key)')

  // Acoes renderizadas via actionLabel(code) — vocabulario traduzido, nao cru.
  assert.match(src, /actionLabel\(\s*code\s*\)/, 'deve renderizar actionLabel(code) para cada acao')

  // Selo assist-only via i18n e gated por mission.assist_only.
  assert.match(src, /mission\.assist_only\s*&&/, 'o selo deve ser condicionado a mission.assist_only')
  assert.match(src, /t\(\s*['"]assistOnly['"]\s*\)/, 'deve renderizar o selo via t("assistOnly")')

  // Chrome do card via i18n.
  for (const key of ['mission', 'objective', 'dataAnalyzed', 'predicts', 'possibleActions']) {
    assert.match(src, new RegExp(`t\\(\\s*['"]${key}['"]\\s*\\)`), `deve renderizar t("${key}")`)
  }

  // Regressao: nunca renderiza a chave crua do catalogo diretamente.
  assert.doesNotMatch(src, />\{\s*mission\.objective_key\s*\}</, 'nao deve renderizar a chave crua objective_key')
  assert.doesNotMatch(src, />\{\s*mission\.predicts_key\s*\}</, 'nao deve renderizar a chave crua predicts_key')
})

// ---------------------------------------------------------------------------
// AC "Prompt nunca exposto": o tipo AgentMission consumido pelo painel so traz
// chaves i18n + dados estruturais — nenhum campo de prompt vaza para a UI.
// ---------------------------------------------------------------------------
test('AC prompt: AgentMission (frontend) nao tem campo de prompt', () => {
  const src = read(AGENTS_API)
  assert.match(src, /export\s+interface\s+AgentMission\s*\{/, 'deve exportar interface AgentMission')
  assert.match(src, /getAgentCatalog/, 'deve exportar getAgentCatalog()')
  // O tipo nao pode declarar prompt algum.
  assert.doesNotMatch(src, /system_prompt/, 'AgentMission nao deve referenciar system_prompt')
  assert.doesNotMatch(src, /user_prompt_template/, 'AgentMission nao deve referenciar user_prompt_template')
})
