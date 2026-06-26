// Verificacao dependency-free do wiring de labels amigaveis para findings ops
// (issue #73 — nomes amigaveis no lugar de codigos crus em MorningBrief e
// FindingsQueue). Asserta sobre o TEXTO-FONTE; nao precisa de node_modules.
//
// Roda com: node --test scripts/verify-finding-labels.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/73-feat-ops-executar-de-fato.md) que verifica. Cobre o AC7:
// "A UI mostra nomes amigaveis e localizados — sem codigos crus."

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

const FINDING_LABELS = 'src/portal/lib/findingLabels.ts'
const MORNING_BRIEF = 'src/portal/renderers/screens/MorningBrief.tsx'
const FINDINGS_QUEUE = 'src/portal/renderers/screens/FindingsQueue.tsx'
const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'

const ACTIONS = ['markdown', 'transfer', 'prioritize_sale', 'wholesale_auction', 'monitor']
const FINDING_TYPES = ['floor_plan_band_escalation', 'margin_erosion', 'carryover_model_year']

// ---------------------------------------------------------------------------
// AC7: pt-BR e en-US trazem o namespace `labels` com nomes amigaveis para o
//      agente, o tipo de finding e cada acao recomendada (todos nao-vazios).
// ---------------------------------------------------------------------------
test('AC7 i18n: labels.agents/findingTypes/actions existem e sao nao-vazios em pt-BR e en-US', () => {
  for (const [locale, relPath] of [
    ['pt-BR', PT_BR],
    ['en-US', EN_US],
  ]) {
    const labels = readJson(relPath).labels
    assert.ok(labels, `${locale} deve definir o namespace "labels"`)

    // Agente vehicle-aging-analyst.
    assert.equal(
      typeof labels.agents?.['vehicle-aging-analyst'],
      'string',
      `${locale} deve definir labels.agents["vehicle-aging-analyst"]`,
    )
    assert.notEqual(labels.agents['vehicle-aging-analyst'].trim(), '', `${locale} agent label nao pode ser vazio`)

    // Tipos de finding antecipatorios (floor plan / margem / carryover).
    for (const ft of FINDING_TYPES) {
      assert.equal(
        typeof labels.findingTypes?.[ft],
        'string',
        `${locale} deve definir labels.findingTypes.${ft}`,
      )
      assert.notEqual(labels.findingTypes[ft].trim(), '', `${locale} finding type label ${ft} nao pode ser vazio`)
    }

    // Cada acao recomendada.
    for (const action of ACTIONS) {
      assert.equal(
        typeof labels.actions?.[action],
        'string',
        `${locale} deve definir labels.actions.${action}`,
      )
      assert.notEqual(labels.actions[action].trim(), '', `${locale} action label ${action} nao pode ser vazio`)
    }
  }
})

// ---------------------------------------------------------------------------
// AC7: os labels pt-BR e en-US sao DIFERENTES dos codigos crus (provam que sao
//      nomes humanos, nao apenas eco do codigo) e diferem entre si por locale.
// ---------------------------------------------------------------------------
test('AC7 i18n: labels sao nomes humanos (diferentes do codigo cru) e localizados', () => {
  const pt = readJson(PT_BR).labels
  const en = readJson(EN_US).labels

  // Nao podem ser apenas o eco do codigo cru.
  assert.notEqual(pt.agents['vehicle-aging-analyst'], 'vehicle-aging-analyst')
  assert.notEqual(en.agents['vehicle-aging-analyst'], 'vehicle-aging-analyst')
  for (const ft of FINDING_TYPES) {
    assert.notEqual(pt.findingTypes[ft], ft, `pt-BR finding type ${ft} nao pode ser o codigo cru`)
    assert.notEqual(en.findingTypes[ft], ft, `en-US finding type ${ft} nao pode ser o codigo cru`)
  }
  for (const action of ACTIONS) {
    assert.notEqual(pt.actions[action], action, `pt-BR action ${action} nao pode ser o codigo cru`)
    assert.notEqual(en.actions[action], action, `en-US action ${action} nao pode ser o codigo cru`)
  }

  // pt-BR != en-US para pelo menos o agente e um tipo (prova de localizacao real).
  assert.notEqual(pt.agents['vehicle-aging-analyst'], en.agents['vehicle-aging-analyst'])
  assert.notEqual(pt.findingTypes.carryover_model_year, en.findingTypes.carryover_model_year)
})

// ---------------------------------------------------------------------------
// AC7: findingLabels.ts expoe useFindingLabels com fallback-para-o-codigo
//      (usa .has(key) e retorna o proprio key quando a traducao falta).
// ---------------------------------------------------------------------------
test('AC7 hook: findingLabels.ts implementa fallback-para-o-codigo cru', () => {
  const src = read(FINDING_LABELS)
  assert.match(src, /export\s+function\s+useFindingLabels\s*\(/, 'deve exportar useFindingLabels()')

  // Le os tres namespaces de labels.
  assert.match(src, /useTranslations\(\s*['"]labels\.agents['"]\s*\)/, 'deve ler labels.agents')
  assert.match(src, /useTranslations\(\s*['"]labels\.findingTypes['"]\s*\)/, 'deve ler labels.findingTypes')
  assert.match(src, /useTranslations\(\s*['"]labels\.actions['"]\s*\)/, 'deve ler labels.actions')

  // Expoe os tres lookups.
  for (const fn of ['agentLabel', 'findingTypeLabel', 'actionLabel']) {
    assert.match(src, new RegExp(`${fn}`), `deve expor ${fn}`)
  }

  // Fallback: usa .has(key) e retorna o proprio key (codigo cru) como ultimo recurso.
  assert.match(src, /\.has\(\s*key\s*\)\s*\?/, 'deve checar .has(key) antes de traduzir')
  assert.match(src, /:\s*key\s*\)/, 'deve cair de volta para o proprio key (codigo cru)')
})

// ---------------------------------------------------------------------------
// AC7: MorningBrief usa os labels amigaveis e NAO renderiza mais os codigos
//      crus `{f.agent_key} · {f.finding_type}`.
// ---------------------------------------------------------------------------
test('AC7 MorningBrief: usa agentLabel/findingTypeLabel e nao renderiza codigo cru', () => {
  const src = read(MORNING_BRIEF)
  assert.match(
    src,
    /import\s+\{[^}]*useFindingLabels[^}]*\}\s+from\s+['"]@\/portal\/lib\/findingLabels['"]/,
    'deve importar useFindingLabels',
  )
  assert.match(src, /useFindingLabels\(\)/, 'deve invocar useFindingLabels()')
  assert.match(src, /agentLabel\(\s*f\.agent_key\s*\)/, 'deve renderizar agentLabel(f.agent_key)')
  assert.match(src, /findingTypeLabel\(\s*f\.finding_type\s*\)/, 'deve renderizar findingTypeLabel(f.finding_type)')

  // Regressao: nao pode renderizar mais os codigos crus diretamente.
  assert.doesNotMatch(
    src,
    /\{\s*f\.agent_key\s*\}\s*·\s*\{\s*f\.finding_type\s*\}/,
    'nao deve renderizar mais {f.agent_key} · {f.finding_type} cru',
  )
})

// ---------------------------------------------------------------------------
// AC7: FindingsQueue mapeia agente/tipo via labels amigaveis e nao atribui mais
//      os codigos crus f.agent_key / f.finding_type as colunas.
// ---------------------------------------------------------------------------
test('AC7 FindingsQueue: mapeia agente/tipo via labels e nao usa codigo cru nas colunas', () => {
  const src = read(FINDINGS_QUEUE)
  assert.match(
    src,
    /import\s+\{[^}]*useFindingLabels[^}]*\}\s+from\s+['"]@\/portal\/lib\/findingLabels['"]/,
    'deve importar useFindingLabels',
  )
  assert.match(src, /useFindingLabels\(\)/, 'deve invocar useFindingLabels()')
  assert.match(src, /agente:\s*agentLabel\(\s*f\.agent_key\s*\)/, 'coluna agente deve usar agentLabel(f.agent_key)')
  assert.match(src, /tipo:\s*findingTypeLabel\(\s*f\.finding_type\s*\)/, 'coluna tipo deve usar findingTypeLabel(f.finding_type)')

  // Regressao: as colunas nao podem voltar a receber o codigo cru.
  assert.doesNotMatch(src, /agente:\s*f\.agent_key\b/, 'coluna agente nao deve receber f.agent_key cru')
  assert.doesNotMatch(src, /tipo:\s*f\.finding_type\b/, 'coluna tipo nao deve receber f.finding_type cru')
})
