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
