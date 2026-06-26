// Verificacao dependency-free da REORGANIZACAO do menu (sem duplicidade, com
// niveis/subniveis coerentes do dominio concessionaria/DMS).
//
// Ambiente OFFLINE sem runner de teste instalavel: usamos so modulos nativos do
// Node (node:test, node:assert, node:fs) e assertamos lendo os arquivos-fonte.
// Roda com: node --test scripts/verify-menu.mjs
//
// Garante as invariantes que o usuario pediu: (1) a duplicidade de "Fast BI" sumiu;
// (2) ids e componentKeys sao unicos; (3) todo componentKey do menu existe no registry;
// (4) a hierarquia tem os grupos de topo e os subniveis esperados; (5) Administracao
// segue restrita a admin; (6) toda folha leva icon no spec (aba/janela herda o icone).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

function matchAll(re, s) {
  return [...s.matchAll(re)].map((m) => m[1])
}

// Recorta SO o literal MOCK_MENU (de `const MOCK_MENU` ate o `const delay` seguinte),
// para nao confundir ids/textos do menu com outros objetos do portalApi.ts.
function menuBlock() {
  const src = read('src/portal/lib/portalApi.ts')
  const start = src.indexOf('const MOCK_MENU')
  assert.ok(start !== -1, 'portalApi.ts deve declarar const MOCK_MENU')
  const end = src.indexOf('const delay', start)
  assert.ok(end !== -1 && end > start, 'nao encontrei o fim do bloco MOCK_MENU (const delay)')
  return src.slice(start, end)
}

// Recorta SO o grupo de topo 'ai-ops' (Operacoes de IA), do seu `id: 'ai-ops'`
// ate o inicio do proximo grupo de topo ('fast-bi'). Permite afirmar as folhas
// e a ordem da reorganizacao da issue #93 sem casar ids de outros grupos.
function aiOpsBlock() {
  const block = menuBlock()
  const start = block.indexOf("id: 'ai-ops'")
  assert.ok(start !== -1, "MOCK_MENU deve conter o grupo de topo id: 'ai-ops'")
  const end = block.indexOf("id: 'fast-bi'", start)
  assert.ok(end !== -1 && end > start, "nao encontrei o fim do grupo ai-ops (proximo grupo 'fast-bi')")
  return block.slice(start, end)
}

// Le e parseia um JSON de mensagens i18n, retornando o sub-objeto `menu`.
function menuMessages(locale) {
  const relPath = `src/i18n/messages/${locale}.json`
  let parsed
  assert.doesNotThrow(() => {
    parsed = JSON.parse(read(relPath))
  }, `${relPath} deve ser JSON valido`)
  assert.ok(parsed && parsed.menu && typeof parsed.menu === 'object', `${relPath} deve conter o objeto "menu"`)
  return parsed.menu
}

test('Dedup: existe EXATAMENTE uma secao "Fast BI" (antes havia duas)', () => {
  const block = menuBlock()
  const fastBiCount = matchAll(/text:\s*'([^']*)'/g, block).filter((t) => t === 'Fast BI').length
  assert.equal(fastBiCount, 1, `esperava 1 grupo com text: 'Fast BI', encontrei ${fastBiCount}`)
  assert.ok(
    !block.includes("id: 'insights'"),
    "o grupo duplicado id: 'insights' deve ter sido mesclado/removido",
  )
})

test('Sem rotulo de grupo de topo repetido (a duplicidade "Fast BI" sumiu)', () => {
  // Grupos de topo: id/text com indentacao de 4 espacos (um nivel dentro do array).
  const block = menuBlock()
  const topIds = matchAll(/^ {4}id: '([^']+)',$/gm, block)
  const topTexts = matchAll(/^ {4}text: '([^']+)',$/gm, block)
  assert.ok(topIds.length >= 4, `esperava >=4 grupos de topo, encontrei ${topIds.length}`)
  const dupIds = topIds.filter((id, i) => topIds.indexOf(id) !== i)
  const dupTexts = topTexts.filter((t, i) => topTexts.indexOf(t) !== i)
  assert.deepEqual([...new Set(dupIds)], [], `ids de grupo de topo duplicados: ${[...new Set(dupIds)].join(', ')}`)
  assert.deepEqual([...new Set(dupTexts)], [], `rotulos de grupo de topo duplicados: ${[...new Set(dupTexts)].join(', ')}`)
})

test('IDs do menu sao unicos (nenhum id repetido em toda a arvore)', () => {
  const ids = matchAll(/id:\s*'([^']+)'/g, menuBlock())
  const dups = ids.filter((id, i) => ids.indexOf(id) !== i)
  assert.deepEqual([...new Set(dups)], [], `ids duplicados no menu: ${[...new Set(dups)].join(', ')}`)
})

test('Cada tela (componentKey) aparece UMA vez e esta registrada no registry', () => {
  const keys = matchAll(/componentKey:\s*'([^']+)'/g, menuBlock())
  assert.ok(keys.length > 0, 'o menu deve referenciar componentKeys de telas nativas')
  const dups = keys.filter((k, i) => keys.indexOf(k) !== i)
  assert.deepEqual([...new Set(dups)], [], `componentKeys duplicados no menu: ${[...new Set(dups)].join(', ')}`)

  const reg = read('src/portal/renderers/registry.ts')
  const regKeys = new Set(matchAll(/'([^']+)'\s*:\s*lazy\(/g, reg))
  for (const k of keys) {
    assert.ok(regKeys.has(k), `componentKey '${k}' do menu nao esta registrado em registry.ts`)
  }
})

test('Hierarquia coerente: grupos de topo e subniveis esperados existem', () => {
  const block = menuBlock()
  // Dados mestres (Empresas/Marcas) foram movidos para 'admin' na issue #37.
  for (const id of ['ai-ops', 'fast-bi', 'dealership', 'admin']) {
    assert.ok(block.includes(`id: '${id}'`), `grupo de topo ausente: ${id}`)
  }
  // Subniveis (3o nivel) que provam a organizacao por dominio.
  for (const id of [
    'fast-bi-visao-geral',
    'fast-bi-operacional',
    'dealership-veiculos',
    'dealership-oficina',
    'dealership-pecas',
  ]) {
    assert.ok(block.includes(`id: '${id}'`), `subnivel esperado ausente: ${id}`)
  }
})

test('Administracao continua restrita a admin (requiredRole no grupo e no item)', () => {
  const block = menuBlock()
  assert.ok(block.includes("id: 'admin'"), "deve existir o grupo id: 'admin'")
  assert.ok(block.includes("id: 'admin-users'"), "deve existir o item id: 'admin-users'")
  const roleCount = matchAll(/requiredRole:\s*'admin'/g, block).length
  assert.ok(roleCount >= 2, `requiredRole: 'admin' deve marcar grupo E item (>=2), encontrei ${roleCount}`)
})

test('Coerencia de icone: toda folha (spec com componentKey) define icon no spec', () => {
  // Specs sao objetos de uma linha: `spec: { ... }` sem chaves aninhadas.
  const specs = menuBlock().match(/spec:\s*\{[^}]*\}/g) ?? []
  const leaves = specs.filter((s) => s.includes('componentKey:'))
  assert.ok(leaves.length > 0, 'esperava specs de tela com componentKey')
  for (const s of leaves) {
    assert.ok(s.includes('icon:'), `spec de tela sem icon (aba/janela ficaria sem icone): ${s}`)
  }
})

// ---------------------------------------------------------------------------
// Issue #93 — Reorganizacao do grupo "Operacoes de IA" (ai-ops) e aposentadoria
// de "Trilha de Auditoria" como item de topo. Cada teste rastreia um criterio de
// aceite (AC) da spec docs/specs/93-reorganizar-o-menu-operacoes-de.md.
// ---------------------------------------------------------------------------

test('AC1: "Trilha de Auditoria" saiu do menu (sem leaf ai-audit-trail nem componentKey audit-trail)', () => {
  const block = menuBlock()
  const aiOps = aiOpsBlock()
  // Nao deve existir o item de topo nem dentro do grupo ai-ops.
  assert.ok(!block.includes("id: 'ai-audit-trail'"), "o leaf id: 'ai-audit-trail' deve ter sido removido do menu")
  assert.ok(!aiOps.includes("id: 'ai-audit-trail'"), "ai-audit-trail nao pode estar no grupo ai-ops")
  // Nenhuma folha do menu pode apontar para a tela audit-trail (so abre por contexto).
  const compKeys = matchAll(/componentKey:\s*'([^']+)'/g, block)
  assert.ok(!compKeys.includes('audit-trail'), "nenhum item do menu pode usar componentKey 'audit-trail'")
  // E o rotulo "Trilha de Auditoria" nao deve aparecer mais no bloco do menu.
  assert.ok(!block.includes('Trilha de Auditoria'), "o texto 'Trilha de Auditoria' nao deve sobrar no menu")
})

test('AC2 (atualizado por #97): a tela audit-trail foi removida do registry junto com seu unico entry point', () => {
  // O #93 mantinha audit-trail no registry para ser aberta a partir de um finding.
  // O #97 (AC4) remove esse entry point contextual e a propria tela AuditTrail,
  // ja que ela ficou sem usuarios — substituida pelo historico de decisao.
  const reg = read('src/portal/renderers/registry.ts')
  const regKeys = new Set(matchAll(/'([^']+)'\s*:\s*lazy\(/g, reg))
  assert.ok(
    !regKeys.has('audit-trail'),
    "audit-trail deve ter sido REMOVIDA do componentRegistry (sem usuarios apos #97)",
  )
  assert.ok(
    !reg.includes('AuditTrail'),
    "registry.ts nao deve mais importar a tela AuditTrail",
  )
})

test('AC3: grupo ai-ops com as telas remanescentes na ordem coerente (Morning Brief primeiro)', () => {
  const aiOps = aiOpsBlock()
  // Ids das folhas (3o nivel) na ordem em que aparecem no grupo ai-ops.
  const leafIds = matchAll(/id:\s*'([^']+)'/g, aiOps).filter((id) => id !== 'ai-ops')
  assert.deepEqual(
    leafIds,
    ['morning-brief-owner', 'cockpit-brief-owner', 'ai-agents-dashboard', 'ai-morning-queue'],
    'ai-ops deve listar Morning Brief, depois Cockpit Matinal (#142), Painel de Agentes e Fila Matinal',
  )
  // E os componentKeys das telas, na mesma ordem, batem com as telas-ancora da IA.
  const compKeys = matchAll(/componentKey:\s*'([^']+)'/g, aiOps)
  assert.deepEqual(
    compKeys,
    ['morning-brief', 'dia-cockpit-brief', 'agents-dashboard', 'findings-queue'],
    'ai-ops deve mapear morning-brief, dia-cockpit-brief (#142), agents-dashboard e findings-queue nessa ordem',
  )
})

test('AC4: sem chave i18n orfa/faltante — todo id do menu tem menu.* nas duas locales e ai-audit-trail sumiu', () => {
  const ids = [...new Set(matchAll(/id:\s*'([^']+)'/g, menuBlock()))]
  const pt = menuMessages('pt-BR')
  const en = menuMessages('en-US')

  for (const id of ids) {
    assert.ok(Object.prototype.hasOwnProperty.call(pt, id), `pt-BR.json: falta menu.${id}`)
    assert.ok(Object.prototype.hasOwnProperty.call(en, id), `en-US.json: falta menu.${id}`)
    assert.ok(String(pt[id]).trim().length > 0, `pt-BR.json: menu.${id} esta vazio`)
    assert.ok(String(en[id]).trim().length > 0, `en-US.json: menu.${id} esta vazio`)
  }

  // A chave removida nao pode sobrar em NENHUMA das locales (sem orfa).
  assert.ok(!Object.prototype.hasOwnProperty.call(pt, 'ai-audit-trail'), 'pt-BR.json: menu.ai-audit-trail deve ter sido removido')
  assert.ok(!Object.prototype.hasOwnProperty.call(en, 'ai-audit-trail'), 'en-US.json: menu.ai-audit-trail deve ter sido removido')

  // Rotulos das telas remanescentes do ai-ops devem existir e bater com o esperado.
  assert.equal(pt['morning-brief-owner'], 'Resumo Matinal')
  assert.equal(en['morning-brief-owner'], 'Morning Brief')
  assert.equal(pt['ai-agents-dashboard'], 'Painel de Agentes')
  assert.equal(pt['ai-morning-queue'], 'Fila Matinal')
})

test('AC5: todo componentKey do MOCK_MENU resolve em registry.ts', () => {
  const keys = [...new Set(matchAll(/componentKey:\s*'([^']+)'/g, menuBlock()))]
  assert.ok(keys.length > 0, 'o menu deve referenciar componentKeys de telas')
  const reg = read('src/portal/renderers/registry.ts')
  const regKeys = new Set(matchAll(/'([^']+)'\s*:\s*lazy\(/g, reg))
  const unresolved = keys.filter((k) => !regKeys.has(k))
  assert.deepEqual(unresolved, [], `componentKeys do menu sem registro em registry.ts: ${unresolved.join(', ')}`)
})

test('AC6: Cockpit Matinal e a tela matinal oficial; Morning Brief fica invisivel (hidden)', () => {
  const block = menuBlock()

  // Morning Brief continua no menu-fonte, porem marcado como hidden (some da UI).
  const mbStart = block.indexOf("id: 'morning-brief-owner'")
  assert.ok(mbStart !== -1, 'MOCK_MENU deve conter morning-brief-owner')
  const mbEnd = block.indexOf("id: 'cockpit-brief-owner'", mbStart)
  assert.ok(mbEnd !== -1 && mbEnd > mbStart, 'cockpit-brief-owner deve vir depois de morning-brief-owner')
  const mbNode = block.slice(mbStart, mbEnd)
  assert.match(mbNode, /hidden:\s*true/, 'morning-brief-owner deve estar oculto (hidden: true)')

  // Cockpit Matinal segue oficial e VISIVEL (sem hidden) e aponta para dia-cockpit-brief.
  const ckStart = block.indexOf("id: 'cockpit-brief-owner'")
  const ckEnd = block.indexOf("id: 'ai-agents-dashboard'", ckStart)
  const ckNode = block.slice(ckStart, ckEnd)
  assert.ok(!/hidden:\s*true/.test(ckNode), 'cockpit-brief-owner NAO pode estar oculto (e a tela matinal oficial)')
  assert.match(ckNode, /componentKey:\s*'dia-cockpit-brief'/, 'cockpit-brief-owner deve abrir dia-cockpit-brief')

  // O filtro de visibilidade do menu descarta itens hidden.
  const filterSrc = read('src/portal/lib/menuFilter.ts')
  assert.match(filterSrc, /!node\.hidden/, 'filterMenuByRole deve descartar itens hidden')
})
