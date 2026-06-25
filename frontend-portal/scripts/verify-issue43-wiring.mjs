// Verificacao dependency-free do wiring do frontend para a issue #43
// (Morning Brief do Dono: visao por marca -> lojas -> acoes do agente).
//
// Ambiente OFFLINE sem runner instalavel (sem vitest): usamos apenas modulos
// nativos do Node (node:test, node:assert, node:fs), lendo os arquivos-fonte e
// assertando contra eles que a implementacao do commit 520a82b esta no lugar e
// nao regride. Espelha scripts/verify-issue37-wiring.mjs (assercao sobre o
// CONTEUDO da fonte — nenhum node_modules / runtime).
//
// Roda com: node --test scripts/verify-issue43-wiring.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/43-portal-morning-brief-do-dono.md) que verifica.

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

const AGENTS_API = 'src/portal/lib/agentsApi.ts'
const REGISTRY = 'src/portal/renderers/registry.ts'
const PORTAL_API = 'src/portal/lib/portalApi.ts'
const MORNING_BRIEF = 'src/portal/renderers/screens/MorningBrief.tsx'
const PORTAL_SHELL = 'src/portal/PortalShell.tsx'

// Extrai o corpo de uma funcao exportada async (do nome ate o proximo
// 'export ' de topo) para isolar assercoes ao escopo certo.
function exportedFnBody(src, signature) {
  const start = src.indexOf(signature)
  assert.ok(start !== -1, `assinatura nao encontrada: ${signature}`)
  const next = src.indexOf('\nexport ', start + signature.length)
  return src.slice(start, next === -1 ? undefined : next)
}

// ===========================================================================
// AC backend-wiring: agentsApi expoe getOwnerBriefByBrand/getOwnerBriefByStore,
// lendo as views v_dia_owner_brief_by_brand / _by_store.
// ===========================================================================

test('AC api: getOwnerBriefByBrand le v_dia_owner_brief_by_brand', () => {
  const src = read(AGENTS_API)
  assert.match(
    src,
    /export\s+async\s+function\s+getOwnerBriefByBrand\s*\(/,
    'agentsApi deve exportar getOwnerBriefByBrand',
  )
  const body = exportedFnBody(src, 'function getOwnerBriefByBrand')
  assert.match(
    body,
    /\.from\(\s*['"]v_dia_owner_brief_by_brand['"]\s*\)/,
    'getOwnerBriefByBrand deve ler a view v_dia_owner_brief_by_brand',
  )
})

test('AC api: getOwnerBriefByStore le v_dia_owner_brief_by_store', () => {
  const src = read(AGENTS_API)
  assert.match(
    src,
    /export\s+async\s+function\s+getOwnerBriefByStore\s*\(/,
    'agentsApi deve exportar getOwnerBriefByStore',
  )
  const body = exportedFnBody(src, 'function getOwnerBriefByStore')
  assert.match(
    body,
    /\.from\(\s*['"]v_dia_owner_brief_by_store['"]\s*\)/,
    'getOwnerBriefByStore deve ler a view v_dia_owner_brief_by_store',
  )
})

test('AC api: tipos OwnerBriefBrandRow/StoreRow expoem os 5 setores + FP at-risk + resultado', () => {
  const src = read(AGENTS_API)
  assert.match(src, /export\s+interface\s+OwnerBriefBrandRow\b/, 'deve exportar OwnerBriefBrandRow')
  assert.match(src, /export\s+interface\s+OwnerBriefStoreRow\b/, 'deve exportar OwnerBriefStoreRow')
  // Campos dos 5 setores + FP em risco + resultado (contrato consumido pela tela).
  for (const field of [
    'novos_units',
    'usados_units',
    'pecas_value',
    'at_value',
    'fp_units_at_risk',
    'fp_value_at_risk',
    'resultado',
  ]) {
    assert.match(src, new RegExp(`\\b${field}\\b`), `OwnerBrief*Row deve declarar o campo ${field}`)
  }
  // O drill por loja adiciona store_name.
  const storeIface = src.slice(src.indexOf('interface OwnerBriefStoreRow'))
  assert.match(storeIface, /store_name/, 'OwnerBriefStoreRow deve adicionar store_name')
})

// ===========================================================================
// AC "ponto de entrada / registry + menu": registry registra 'morning-brief';
// MOCK_MENU tem o item morning-brief-owner com componentKey 'morning-brief'.
// ===========================================================================

test("AC registry: registra a tela 'morning-brief' -> MorningBrief", () => {
  const src = read(REGISTRY)
  assert.match(
    src,
    /['"]morning-brief['"]\s*:\s*lazy\(\(\)\s*=>\s*import\([^)]*MorningBrief[^)]*\)\)/,
    "registry deve registrar 'morning-brief' apontando para o componente MorningBrief",
  )
})

test("AC menu: MOCK_MENU tem o item morning-brief-owner com componentKey 'morning-brief'", () => {
  const src = read(PORTAL_API)
  const at = src.indexOf("id: 'morning-brief-owner'")
  assert.ok(at !== -1, "MOCK_MENU deve ter o item id: 'morning-brief-owner'")
  // Bloco do item ate o fechamento do spec.
  const block = src.slice(at, src.indexOf('}', src.indexOf('spec:', at)) + 1)
  assert.match(block, /kind:\s*'component'/, 'o item deve ser kind component')
  assert.match(
    block,
    /componentKey:\s*'morning-brief'/,
    "o item morning-brief-owner deve abrir componentKey 'morning-brief'",
  )
})

// ===========================================================================
// AC tela: MorningBrief renderiza os 5 setores, drill marca->lojas, acoes
// (Confirmar=approve / Dispensar), "—" para setor vazio e mobile+desktop.
// ===========================================================================

test('AC tela: sectorCells renderiza exatamente as 5 celulas (Novos, Usados, Pecas, AT, FP)', () => {
  const src = read(MORNING_BRIEF)
  for (const label of ['Novos', 'Usados', 'Peças', 'AT', 'FP']) {
    assert.match(src, new RegExp(`label:\\s*'${label}'`), `sectorCells deve incluir a celula '${label}'`)
  }
  // O grid das celulas e' 5-wide (grid-cols-5) — fixa a contagem de setores.
  assert.match(src, /grid-cols-5/, 'as celulas de setor devem usar um grid de 5 colunas')
})

test('AC tela: drill de marca -> lojas (StoresDrill + indexacao por marca)', () => {
  const src = read(MORNING_BRIEF)
  // Carrega lojas via getOwnerBriefByStore e indexa por marca para o drill.
  assert.match(src, /getOwnerBriefByStore\(\)/, 'a tela deve carregar lojas via getOwnerBriefByStore()')
  assert.match(src, /function\s+StoresDrill\b/, 'deve existir o componente StoresDrill (drill mobile)')
  assert.match(src, /function\s+indexStores\b/, 'deve indexar lojas por marca (indexStores)')
  // O card de marca abre o drill (onOpen -> setOpenBrand).
  assert.match(src, /setOpenBrand\(/, 'tocar numa marca deve abrir o drill (setOpenBrand)')
})

test('AC tela: card Grupo Total soma as marcas (reduce sobre as brands)', () => {
  const src = read(MORNING_BRIEF)
  assert.match(src, /function\s+groupTotal\b/, 'deve existir a soma das marcas (groupTotal)')
  assert.match(src, /brand_name:\s*'Grupo Total'/, "groupTotal deve produzir a linha 'Grupo Total'")
  // O corpo da funcao deve realmente AGREGAR sobre o array de marcas (reduce/
  // some acumulando o campo escolhido) — nao apenas estampar o rotulo. Isola o
  // corpo de groupTotal e prova que ele itera as brands somando os valores.
  const body = exportedFnBody(src, 'function groupTotal')
  assert.match(
    body,
    /brands\.reduce\(\s*\([^)]*\)\s*=>\s*acc\s*\+\s*\(pick\([^)]*\)\s*\?\?\s*0\)/,
    'groupTotal deve reduzir (somar) os valores escolhidos sobre o array brands',
  )
  // E o resultado por setor/FP deve sair do agregador (sum/sumOrNull) — i.e. os
  // totais por marca sendo somados, e nao constantes/labels.
  for (const field of ['novos_value', 'fp_units_at_risk', 'fp_value_at_risk', 'resultado']) {
    assert.match(
      body,
      new RegExp(`${field}:\\s*sum(OrNull)?\\(`),
      `groupTotal.${field} deve vir do agregador (sum/sumOrNull sobre as marcas)`,
    )
  }
})

test('AC tela: destaque Floor Plan <7d em risco (vermelho quando ha unidades)', () => {
  const src = read(MORNING_BRIEF)
  // O estado at-risk deriva de fp_units_at_risk > 0 e pinta de destructive.
  assert.match(
    src,
    /fp_units_at_risk\s*\?\?\s*0\)\s*>\s*0/,
    'o destaque FP deve derivar de (fp_units_at_risk ?? 0) > 0',
  )
  assert.match(src, /text-destructive/, 'FP em risco deve usar a cor destructive (vermelho)')
  assert.match(src, /em risco <7d/, 'a tela deve rotular o FP em risco como "<7d"')
})

test('AC acoes: Confirmar chama decideFinding approve; Dispensar oculta a acao', () => {
  const src = read(MORNING_BRIEF)
  assert.match(src, /getFindings\(/, 'a secao de acoes deve carregar getFindings()')
  // Confirmar -> decideFinding({ ..., decision: 'approve' }).
  const onConfirm = src.slice(src.indexOf('const onConfirm'), src.indexOf('const onDismiss'))
  assert.match(
    onConfirm,
    /decideFinding\(\s*\{[^}]*decision:\s*'approve'[^}]*\}\s*\)/,
    "Confirmar deve chamar decideFinding({ ..., decision: 'approve' })",
  )
  // Dispensar -> marca o finding como 'dismissed' no estado da UI.
  const onDismiss = src.slice(src.indexOf('const onDismiss'))
  assert.match(
    onDismiss,
    /\[f\.id\]:\s*'dismissed'/,
    "Dispensar deve marcar o finding como 'dismissed' (reflete no estado da UI)",
  )
  // E o ActionsSection filtra os 'dismissed' para somem da lista.
  assert.match(
    src,
    /states\[f\.id\]\s*!==\s*'dismissed'/,
    'ActionsSection deve esconder os findings dispensados (states !== dismissed)',
  )
  // O titulo da secao confirma o vinculo a spec.
  assert.match(src, /DIA preparou estas ações/, 'a secao deve titular "DIA preparou estas ações"')
})

test('AC acoes (titulos dos botoes): Confirmar e Dispensar presentes', () => {
  const src = read(MORNING_BRIEF)
  assert.match(src, /✓ Confirmar/, 'deve existir o botao "Confirmar"')
  assert.match(src, />\s*Dispensar\s*</, 'deve existir o botao "Dispensar"')
})

test('AC setor vazio: valores nulos renderizam "—" (fmtUnits/fmtMoney)', () => {
  const src = read(MORNING_BRIEF)
  // Os formatadores caem para o em-dash quando o valor nao e' numero finito.
  assert.match(src, /function\s+fmtUnits\b[\s\S]*?:\s*'—'/, 'fmtUnits deve cair para "—" quando sem valor')
  assert.match(src, /function\s+fmtMoney\b[\s\S]*?:\s*'—'/, 'fmtMoney deve cair para "—" quando sem valor')
})

test('AC responsivo: ramo mobile (compact) e ramo desktop (cockpit) coexistem', () => {
  const src = read(MORNING_BRIEF)
  // Alterna pelo breakpoint.
  assert.match(src, /useBreakpoint\(\)/, 'a tela deve usar useBreakpoint() para alternar layout')
  assert.match(src, /if\s*\(\s*compact\s*\)/, 'deve haver um ramo mobile guardado por if (compact)')
  // E a variante desktop (tabela cockpit) existe como branch separado.
  assert.match(src, /function\s+CockpitTable\b/, 'deve existir a tabela cockpit do desktop (CockpitTable)')
})

// ===========================================================================
// AC deep-link: PortalShell le ?screen=, allowlistado a 'morning-brief', abre a
// janela e remove o param via history.replaceState.
// ===========================================================================

test("AC deep-link: PortalShell le ?screen= e e allowlistado a 'morning-brief'", () => {
  const src = read(PORTAL_SHELL)
  // Allowlist de telas abriveis por deep-link, contendo morning-brief.
  assert.match(
    src,
    /DEEP_LINK_SCREENS[\s\S]*?'morning-brief'\s*:\s*\{[^}]*componentKey:\s*'morning-brief'/,
    "PortalShell deve ter uma allowlist DEEP_LINK_SCREENS com 'morning-brief'",
  )
  // Le o param screen da URL.
  assert.match(
    src,
    /new\s+URLSearchParams\(window\.location\.search\)/,
    'PortalShell deve ler os params da URL (URLSearchParams)',
  )
  assert.match(src, /params\.get\(\s*['"]screen['"]\s*\)/, "deve ler o param 'screen'")
})

test('AC deep-link: abre a janela alvo e remove o param via history.replaceState', () => {
  const src = read(PORTAL_SHELL)
  // Abre a janela do componente alvo.
  assert.match(
    src,
    /openWindow\(\s*\{\s*kind:\s*'component',\s*componentKey:\s*target\.componentKey/,
    'deep-link deve abrir openWindow({ kind: component, componentKey: target.componentKey, ... })',
  )
  // Remove o param para nao reabrir em refresh.
  assert.match(src, /params\.delete\(\s*['"]screen['"]\s*\)/, "deve remover o param 'screen'")
  assert.match(
    src,
    /window\.history\.replaceState\(/,
    'deve limpar a URL via window.history.replaceState (sem reabrir no refresh)',
  )
})
