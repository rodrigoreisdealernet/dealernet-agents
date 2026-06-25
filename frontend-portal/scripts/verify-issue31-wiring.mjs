// Verificacao dependency-free do wiring do frontend para a issue #31
// (CRUDs: acoes como botoes, telas maximizadas, fix marca/empresa).
//
// Ambiente OFFLINE sem runner instalavel (sem vitest): usamos apenas modulos
// nativos do Node (node:test, node:assert, node:fs), lendo os arquivos-fonte e
// assertando contra eles que a implementacao do commit 06944a6 esta no lugar e
// nao regride. Espelha scripts/verify-vehicle-wiring.mjs.
//
// Roda com: node --test scripts/verify-issue31-wiring.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/31-portal-cruds-acoes-como-botoes.md) que verifica.

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

// As 6 telas de CRUD da spec + Venda de Pecas (tambem migrada no commit).
const CRUD_SCREENS = [
  'src/portal/renderers/screens/VehiclesInventory.tsx',
  'src/portal/renderers/screens/CompaniesCrud.tsx',
  'src/portal/renderers/screens/BrandsCrud.tsx',
  'src/portal/renderers/screens/PartsInventory.tsx',
  'src/portal/renderers/screens/ServiceOrders.tsx',
  'src/portal/renderers/screens/UsersAdmin.tsx',
  'src/portal/renderers/screens/PartSales.tsx',
]

// ===========================================================================
// AC "Acoes como botoes": coluna de acao usa o botao compartilhado RowActionButton
// (botao real, com ICONE + ROTULO, acessivel por teclado) e NAO o antigo padrao
// de link sublinhado (text-...-primary/destructive hover:underline).
// ===========================================================================

test('AC acoes-botoes: ui.tsx expoe RowActionButton como <button> acessivel (type=button + focus ring)', () => {
  const ui = read('src/portal/renderers/screens/ui.tsx')
  assert.ok(ui.includes('export function RowActionButton'), 'ui.tsx deve exportar RowActionButton')
  assert.ok(ui.includes('export function RowActions'), 'ui.tsx deve exportar RowActions (agrupador)')
  // Botao real: elemento <button type="button"> (acessivel por teclado), nao <a>.
  assert.match(
    ui,
    /<button[\s\S]*?type="button"/,
    'RowActionButton deve renderizar um <button type="button"> (foco/ativacao por teclado)',
  )
  // Anel de foco visivel para acessibilidade por teclado.
  assert.match(
    ui,
    /focus-visible:ring/,
    'RowActionButton deve ter focus-visible:ring (foco visivel por teclado)',
  )
  // Recebe icone + rotulo (icon/label props renderizados).
  assert.ok(
    ui.includes('icon') && ui.includes('label'),
    'RowActionButton deve aceitar icon + label (icone + rotulo)',
  )
})

for (const screen of CRUD_SCREENS) {
  const name = screen.split('/').pop()

  test(`AC acoes-botoes: ${name} usa RowActionButton (botao compartilhado) nas acoes de linha`, () => {
    const src = read(screen)
    assert.ok(
      src.includes('RowActionButton'),
      `${name} deve usar o botao de acao compartilhado RowActionButton`,
    )
  })

  test(`AC acoes-botoes: ${name} NAO usa mais o padrao link-sublinhado nas acoes (hover:underline)`, () => {
    const src = read(screen)
    // Regressao: o antigo padrao era um link "text-...-primary/destructive hover:underline".
    assert.ok(
      !/text-(primary|destructive)[^"'`]*hover:underline/.test(src),
      `${name} nao deve mais ter acoes como links sublinhados (text-* hover:underline)`,
    )
  })
}

// ===========================================================================
// AC "Associar Marca em Empresa": CompaniesCrud carrega marcas via getBrands,
// renderiza um <select> (ComboField) ligado a brand_id e mostra brand_name na
// listagem.
// ===========================================================================

test('AC marca-empresa: CompaniesCrud.tsx importa getBrands e carrega marcas', () => {
  const src = read('src/portal/renderers/screens/CompaniesCrud.tsx')
  assert.ok(src.includes('getBrands'), 'CompaniesCrud deve importar/chamar getBrands')
  assert.match(
    src,
    /getCompanies\(\)\s*,\s*getBrands\(\)/,
    'CompaniesCrud deve carregar empresas E marcas (Promise.all([getCompanies(), getBrands()]))',
  )
})

test('AC marca-empresa: CompaniesCrud.tsx tem combo de Marca ligado a brand_id', () => {
  const src = read('src/portal/renderers/screens/CompaniesCrud.tsx')
  // Label "Marca" + um <select> cujo value/onChange manipula brand_id.
  assert.ok(src.includes('Marca'), 'o form deve ter o campo rotulado "Marca"')
  assert.match(
    src,
    /value=\{form\.brand_id[\s\S]*?<option/,
    'o combo de Marca deve estar ligado a form.brand_id e listar <option>s',
  )
  assert.match(
    src,
    /set\(\s*['"]brand_id['"]/,
    'a selecao do combo deve gravar brand_id no form',
  )
})

test('AC marca-empresa: CompaniesCrud.tsx exibe brand_name como coluna da listagem', () => {
  const src = read('src/portal/renderers/screens/CompaniesCrud.tsx')
  assert.ok(src.includes('Marca'), 'a tabela deve ter o cabecalho da coluna Marca')
  assert.match(
    src,
    /r\.brand_name/,
    'a celula da coluna Marca deve renderizar r.brand_name (marca resolvida da view)',
  )
})

// ===========================================================================
// AC "agentsApi expoe brand_id/brand_name": CompanyRow tem brand_id + brand_name,
// CompanyInput aceita brand_id, e a leitura/escrita carregam essas colunas.
// ===========================================================================

test('AC marca-empresa: agentsApi.ts CompanyRow expoe brand_id e brand_name', () => {
  const api = read('src/portal/lib/agentsApi.ts')
  // No bloco da interface CompanyRow, ambos os campos devem existir.
  const rowBlock = api.slice(api.indexOf('interface CompanyRow'), api.indexOf('interface CompanyInput'))
  assert.match(rowBlock, /brand_id\s*:/, 'CompanyRow deve declarar brand_id')
  assert.match(rowBlock, /brand_name\s*:/, 'CompanyRow deve declarar brand_name')
})

test('AC marca-empresa: agentsApi.ts CompanyInput aceita brand_id', () => {
  const api = read('src/portal/lib/agentsApi.ts')
  const inBlock = api.slice(api.indexOf('interface CompanyInput'), api.indexOf('COMPANY_COLS'))
  assert.match(inBlock, /brand_id\?\s*:/, 'CompanyInput deve declarar brand_id opcional')
})

test('AC marca-empresa: agentsApi.ts seleciona brand_id e brand_name da view de empresa', () => {
  const api = read('src/portal/lib/agentsApi.ts')
  assert.match(
    api,
    /COMPANY_COLS\s*=\s*['"][^'"]*brand_id[^'"]*brand_name[^'"]*['"]/,
    'COMPANY_COLS deve incluir brand_id e brand_name (lidos da v_dia_company_current)',
  )
})

// ===========================================================================
// AC "Telas abrem maximizadas": portalStore.openWindow abre telas kind:'component'
// sem tamanho explicito com maximized: true (dialogos com width/height seguem
// flutuantes).
// ===========================================================================

test('AC telas-maximizadas: portalStore.openWindow maximiza telas kind:component sem tamanho explicito', () => {
  const store = read('src/portal/store/portalStore.ts')
  // Decide maximizar quando kind === 'component' e nao ha tamanho explicito.
  assert.match(
    store,
    /spec\.kind\s*===\s*['"]component['"]\s*&&\s*!explicitSize/,
    "openWindow deve calcular openMaximized = (kind === 'component' && !explicitSize)",
  )
  // E aplicar esse valor ao campo maximized da janela (nao mais hardcoded false).
  assert.match(
    store,
    /maximized:\s*openMaximized/,
    'a janela deve usar maximized: openMaximized (telas de CRUD abrem maximizadas)',
  )
})
