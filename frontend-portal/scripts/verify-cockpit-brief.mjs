// Verificacao dependency-free da tela "Cockpit Matinal" (issue #142 — segunda
// experiencia visual do Resumo Matinal, Proposta B, com acoes REAIS sobre
// findings). Asserta sobre o TEXTO-FONTE dos arquivos commitados; nao precisa de
// node_modules.
//
// Roda com: node --test --experimental-strip-types scripts/verify-cockpit-brief.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/142-feat-ops-nova-tela-cockpit.md) que verifica. Cobre AC1..AC6.

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

const COCKPIT_BRIEF = 'src/portal/renderers/screens/CockpitBrief.tsx'
const REGISTRY = 'src/portal/renderers/registry.ts'
const PORTAL_API = 'src/portal/lib/portalApi.ts'
const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'

const COMPONENT_KEY = 'dia-cockpit-brief'

// ---------------------------------------------------------------------------
// AC1 — Tela acessivel e registrada: registry aponta `dia-cockpit-brief` para o
//       novo arquivo CockpitBrief, e ha item de menu que abre a tela "Cockpit
//       Matinal" com esse componentKey.
// ---------------------------------------------------------------------------
test('AC1 registry: componentKey dia-cockpit-brief importa screens/CockpitBrief', () => {
  const src = read(REGISTRY)
  assert.match(
    src,
    /['"]dia-cockpit-brief['"]\s*:\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]@\/portal\/renderers\/screens\/CockpitBrief['"]\s*\)\s*\)/,
    'registry deve mapear dia-cockpit-brief -> lazy import de screens/CockpitBrief',
  )
  // O arquivo da tela deve existir de fato.
  assert.ok(existsSync(resolve(ROOT, COCKPIT_BRIEF)), 'CockpitBrief.tsx deve existir')
})

test('AC1 menu: MOCK_MENU tem item com componentKey dia-cockpit-brief e titulo Cockpit Matinal', () => {
  const src = read(PORTAL_API)
  assert.match(src, /componentKey:\s*['"]dia-cockpit-brief['"]/, 'menu deve ter um spec com componentKey dia-cockpit-brief')
  assert.match(src, /id:\s*['"]cockpit-brief-owner['"]/, 'menu deve ter o item id cockpit-brief-owner')
  assert.match(src, /['"]Cockpit Matinal['"]/, 'o item de menu deve rotular a tela "Cockpit Matinal"')
})

// ---------------------------------------------------------------------------
// AC5 — Resumo Matinal intocado: as entradas existentes do morning-brief DEVEM
//       continuar presentes (uma remocao futura derruba este teste).
// ---------------------------------------------------------------------------
test('AC5 regressao: morning-brief permanece registrado e no menu (nao foi regredido)', () => {
  const registry = read(REGISTRY)
  assert.match(
    registry,
    /['"]morning-brief['"]\s*:\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]@\/portal\/renderers\/screens\/MorningBrief['"]\s*\)\s*\)/,
    'registry deve MANTER morning-brief -> MorningBrief (intocado)',
  )

  const api = read(PORTAL_API)
  assert.match(api, /id:\s*['"]morning-brief-owner['"]/, 'menu deve MANTER o item morning-brief-owner')
  assert.match(api, /componentKey:\s*['"]morning-brief['"]/, 'menu deve MANTER o spec componentKey morning-brief')

  // O arquivo da tela existente nao pode ter sido removido.
  assert.ok(
    existsSync(resolve(ROOT, 'src/portal/renderers/screens/MorningBrief.tsx')),
    'MorningBrief.tsx deve continuar existindo (diff de 0 linhas)',
  )
})

// ---------------------------------------------------------------------------
// AC3 — Acoes reais (nao mock): a tela importa e CHAMA decideFinding /
//       getFindings / getOwnerBriefByBrand / getOwnerBriefByStore; os handlers
//       approve/dismiss/aprovar-tudo disparam decideFinding com a decisao certa;
//       nenhum placeholder console.log/TODO substitui a acao.
// ---------------------------------------------------------------------------
test('AC3 imports: CockpitBrief importa decideFinding/getFindings/getOwnerBriefByBrand/getOwnerBriefByStore', () => {
  const src = read(COCKPIT_BRIEF)
  for (const fn of ['decideFinding', 'getFindings', 'getOwnerBriefByBrand', 'getOwnerBriefByStore']) {
    assert.match(
      src,
      new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*['"]@/portal/lib/agentsApi['"]`, 's'),
      `deve importar ${fn} de @/portal/lib/agentsApi`,
    )
  }
})

test('AC3 acoes reais: approve e dismiss chamam decideFinding com a decisao correspondente', () => {
  const src = read(COCKPIT_BRIEF)
  // Carga inicial real (sem dados hard-coded de demo): getFindings de pendentes.
  assert.match(src, /getFindings\(\s*\{\s*status:\s*['"]pending_approval['"]/, 'deve carregar findings pendentes reais')

  // Aprovar -> decision: 'approve'.
  assert.match(
    src,
    /decideFinding\(\s*\{\s*findingId:\s*f\.id\s*,\s*decision:\s*['"]approve['"]\s*\}\s*\)/,
    'o handler de Aprovar deve chamar decideFinding(..., decision: "approve")',
  )
  // Dispensar -> decision: 'dismiss'.
  assert.match(
    src,
    /decideFinding\(\s*\{\s*findingId:\s*f\.id\s*,\s*decision:\s*['"]dismiss['"]\s*\}\s*\)/,
    'o handler de Dispensar deve chamar decideFinding(..., decision: "dismiss")',
  )
})

test('AC3 aprovar-tudo: lote chama decideFinding(approve) e nao e simulado na UI', () => {
  const src = read(COCKPIT_BRIEF)
  // Aprovar tudo: lote Promise.allSettled de decideFinding(approve).
  assert.match(src, /Promise\.allSettled\(\s*[\s\S]*decideFinding\(/, 'Aprovar tudo deve disparar decideFinding em lote')
  const onConfirmAll = src.slice(src.indexOf('onConfirmAll'))
  assert.match(onConfirmAll, /decision:\s*['"]approve['"]/, 'Aprovar tudo deve usar decision "approve"')

  // Regressao anti-mock: nenhum placeholder console.log no lugar da acao real.
  assert.doesNotMatch(src, /console\.log\s*\(/, 'a tela nao pode ter placeholder console.log no lugar da acao real')
})

test('AC3 Ver fila: onSeeQueue abre a janela findings-queue (navegacao real)', () => {
  const src = read(COCKPIT_BRIEF)
  assert.match(
    src,
    /openWindow\(\s*\{[^}]*componentKey:\s*['"]findings-queue['"]/,
    'o botao "Ver fila" deve abrir a janela com componentKey findings-queue',
  )
})

// ---------------------------------------------------------------------------
// AC2 — Fidelidade visual: faixa de KPIs do grupo, tabela "Cockpit por marca"
//       com lojas expansiveis (incl. marcacao de Floor Plan em risco) e o painel
//       lateral "DIA preparou estas acoes". Assertado via uso das chaves i18n e
//       marcadores estruturais estaveis, nao por strings cruas.
// ---------------------------------------------------------------------------
test('AC2 visual: KPI strip, tabela cockpit por marca, lojas expansiveis e rail lateral existem', () => {
  const src = read(COCKPIT_BRIEF)
  // Faixa de KPIs do grupo.
  assert.match(src, /function\s+KpiStrip\b/, 'deve existir o componente KpiStrip (faixa de KPIs)')
  assert.match(src, /t\(\s*['"]kpiGroupResult['"]\s*\)/, 'a faixa deve exibir o KPI lider Grupo Total · resultado')

  // Tabela "Cockpit por marca" + linhas de loja expansiveis.
  assert.match(src, /function\s+CockpitTable\b/, 'deve existir o componente CockpitTable')
  assert.match(src, /t\(\s*['"]tableTitle['"]\s*\)/, 'a tabela deve usar a chave tableTitle ("Cockpit por marca")')
  assert.match(src, /setExpanded\(/, 'as linhas de marca devem ser expansiveis em lojas (estado expanded)')

  // Marcacao de Floor Plan em risco.
  assert.match(src, /fp_units_at_risk/, 'deve avaliar fp_units_at_risk para marcar Floor Plan em risco')
  assert.match(src, /t\(\s*['"]fpRisk['"]/, 'deve renderizar a marcacao de FP em risco via chave fpRisk')

  // Painel lateral "DIA preparou estas acoes".
  assert.match(src, /function\s+ActionRail\b/, 'deve existir o painel lateral ActionRail')
  assert.match(src, /t\(\s*['"]railTitle['"]\s*\)/, 'o rail deve usar a chave railTitle ("DIA preparou estas acoes")')
})

// ---------------------------------------------------------------------------
// AC4 — Feedback de estado: apos decisao bem-sucedida o card reflete o resultado
//       (confirmado/removido) e o contador/badge de pendentes e atualizado.
// ---------------------------------------------------------------------------
test('AC4 feedback: estado otimista por finding, remocao apos sucesso e contador/badge de pendentes', () => {
  const src = read(COCKPIT_BRIEF)
  // Estado por finding (confirmado/dispensado/pendente).
  assert.match(src, /findingStates/, 'deve manter estado de UI por finding (findingStates)')
  assert.match(src, /setFindingStates\(/, 'deve atualizar findingStates apos a decisao')
  assert.match(src, /['"]confirmed['"]/, 'deve marcar o card como "confirmed" no sucesso otimista')

  // Rollback em caso de falha (volta para pending).
  assert.match(
    src,
    /catch\s*\([^)]*\)\s*\{[\s\S]*setFindingStates\([\s\S]*['"]pending['"]/,
    'em caso de erro deve reverter o estado para pending (rollback)',
  )

  // Remocao da fila apos confirmar/dispensar.
  assert.match(src, /removeFinding\(/, 'deve remover o finding tratado da fila apos sucesso')

  // Contador/badge de pendentes derivado e atualizado.
  assert.match(src, /pendingCount/, 'deve derivar o contador de pendentes (pendingCount)')
  assert.match(
    src,
    /findings\.filter\(\s*\([^)]*\)\s*=>\s*\([^)]*findingStates\[[^\]]+\][^)]*\)\s*===\s*['"]pending['"]/,
    'pendingCount deve contar apenas os findings ainda pendentes',
  )
})

// ---------------------------------------------------------------------------
// AC6 — i18n: screens.cockpitBrief existe em pt-BR e en-US com paridade de
//       chaves; agentes renderizam via useFindingLabels/agentLabel.
// ---------------------------------------------------------------------------
test('AC6 i18n: screens.cockpitBrief existe em pt-BR e en-US com o MESMO conjunto de chaves', () => {
  const pt = readJson(PT_BR).screens?.cockpitBrief
  const en = readJson(EN_US).screens?.cockpitBrief
  assert.ok(pt, 'pt-BR deve definir screens.cockpitBrief')
  assert.ok(en, 'en-US deve definir screens.cockpitBrief')

  const ptKeys = Object.keys(pt).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(ptKeys, enKeys, 'pt-BR e en-US devem ter as MESMAS chaves em screens.cockpitBrief (paridade)')

  // Nenhum valor pode ser vazio (smell de string nao traduzida).
  for (const [locale, obj] of [['pt-BR', pt], ['en-US', en]]) {
    for (const [k, v] of Object.entries(obj)) {
      assert.equal(typeof v, 'string', `${locale} screens.cockpitBrief.${k} deve ser string`)
      assert.notEqual(v.trim(), '', `${locale} screens.cockpitBrief.${k} nao pode ser vazio`)
    }
  }
})

test('AC6 i18n: a tela consome screens.cockpitBrief e os labels de agente via useFindingLabels/agentLabel', () => {
  const src = read(COCKPIT_BRIEF)
  assert.match(
    src,
    /useTranslations\(\s*['"]screens\.cockpitBrief['"]\s*\)/,
    'a tela deve ler o namespace i18n screens.cockpitBrief',
  )
  assert.match(
    src,
    /import\s*\{[^}]*useFindingLabels[^}]*\}\s*from\s*['"]@\/portal\/lib\/findingLabels['"]/,
    'deve importar useFindingLabels (nomes amigaveis de agente)',
  )
  assert.match(src, /useFindingLabels\(\)/, 'deve invocar useFindingLabels()')
  assert.match(src, /agentLabel\(\s*f\.agent_key\s*\)/, 'os nomes de agente devem renderizar via agentLabel(f.agent_key)')
})

// ---------------------------------------------------------------------------
// AC6 — o proprio teste deve estar ligado ao script `test` do package.json
//       (lista explicita, nao glob): se faltar, ele nunca roda no CI.
// ---------------------------------------------------------------------------
test('AC6 wiring: verify-cockpit-brief.mjs esta listado no script test do package.json', () => {
  const pkg = readJson('package.json')
  assert.match(
    pkg.scripts?.test ?? '',
    /scripts\/verify-cockpit-brief\.mjs/,
    'package.json scripts.test deve incluir scripts/verify-cockpit-brief.mjs',
  )
})
