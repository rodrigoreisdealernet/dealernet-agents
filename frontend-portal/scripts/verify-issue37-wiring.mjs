// Verificacao dependency-free do wiring do frontend para a issue #37
// (seletor de empresas por MARCA, renomeacao de menus e reclassificacao de
// Empresas/Marcas para Administracao).
//
// Ambiente OFFLINE sem runner instalavel (sem vitest): usamos apenas modulos
// nativos do Node (node:test, node:assert, node:fs), lendo os arquivos-fonte e
// assertando contra eles que a implementacao do commit f37f88a esta no lugar e
// nao regride. Espelha scripts/verify-issue31-wiring.mjs.
//
// Roda com: node --test scripts/verify-issue37-wiring.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/37-portal-empresas-por-marca-no.md) que verifica.

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

const STORE = 'src/portal/store/portalStore.ts'
const SELECTOR = 'src/portal/components/EmpresaSelector.tsx'
const PORTAL_API = 'src/portal/lib/portalApi.ts'

// Isola o corpo do metodo async boot() do portalStore para nao casar com usos
// incidentais em outras partes do arquivo.
function bootBody(store) {
  const start = store.indexOf('async boot()')
  assert.ok(start !== -1, 'portalStore deve ter o metodo async boot()')
  // boot() vai ate o proximo metodo de nivel de acao (changeEmpresa) ou ate o fim.
  const next = store.indexOf('changeEmpresa', start)
  return store.slice(start, next === -1 ? undefined : next)
}

// ===========================================================================
// AC "Seletor le empresas vivas de v_dia_company_current, nao MOCK_EMPRESAS":
// boot() agora carrega getCompanies() (que le a view) e mapeia para o shape
// Empresa. portalApi.getEmpresas() deixou de ser a fonte das empresas.
// ===========================================================================

test('AC seletor: portalStore importa getCompanies + CompanyRow de agentsApi', () => {
  const store = read(STORE)
  assert.match(
    store,
    /import\s*\{[^}]*\bgetCompanies\b[^}]*\}\s*from\s*['"]@\/portal\/lib\/agentsApi['"]/,
    'portalStore deve importar getCompanies de @/portal/lib/agentsApi',
  )
  assert.match(
    store,
    /import\s*\{[^}]*\btype\s+CompanyRow\b[^}]*\}\s*from\s*['"]@\/portal\/lib\/agentsApi['"]/,
    'portalStore deve importar o type CompanyRow de @/portal/lib/agentsApi',
  )
})

test('AC seletor: boot() carrega getCompanies() como fonte das empresas', () => {
  const boot = bootBody(read(STORE))
  assert.match(
    boot,
    /getCompanies\(\)/,
    'boot() deve chamar getCompanies() (empresas vivas da view v_dia_company_current)',
  )
})

test('AC seletor (regressao): boot() NAO usa mais portalApi.getEmpresas() como fonte das empresas', () => {
  const boot = bootBody(read(STORE))
  assert.ok(
    !/getEmpresas\(\)/.test(boot),
    'boot() nao deve mais chamar getEmpresas() — a fonte virou getCompanies()',
  )
})

test('AC seletor: o load de getCompanies() esta envolto em safe(...) com fallback [] (modo mock)', () => {
  const boot = bootBody(read(STORE))
  assert.match(
    boot,
    /safe\(\s*getCompanies\(\)\s*,\s*\[\]\s*as\s*CompanyRow\[\]\s*\)/,
    'getCompanies() deve estar dentro de safe(..., [] as CompanyRow[]) para cair vazio sem Supabase',
  )
})

// ===========================================================================
// AC "agrupado por brand_name; sem marca -> 'Sem marca'": o map de CompanyRow
// para Empresa deve setar grupo = brand_name ?? 'Sem marca', id = entity_id e
// nome = trade_name ?? name ?? legal_name ?? entity_id.
// ===========================================================================

test('AC seletor: mapeia grupo a partir de brand_name com fallback "Sem marca"', () => {
  const boot = bootBody(read(STORE))
  assert.match(
    boot,
    /grupo:\s*c\.brand_name\s*\?\?\s*['"]Sem marca['"]/,
    "grupo deve ser c.brand_name ?? 'Sem marca' (agrupamento por marca; sem marca cai no bloco)",
  )
})

test('AC seletor: mapeia id a partir de entity_id', () => {
  const boot = bootBody(read(STORE))
  assert.match(
    boot,
    /id:\s*c\.entity_id/,
    'id da Empresa deve vir de c.entity_id',
  )
})

test('AC seletor: nome usa a cadeia trade_name ?? name ?? legal_name ?? entity_id', () => {
  const boot = bootBody(read(STORE))
  assert.match(
    boot,
    /nome:\s*c\.trade_name\s*\?\?\s*c\.name\s*\?\?\s*c\.legal_name\s*\?\?\s*c\.entity_id/,
    'nome deve ser c.trade_name ?? c.name ?? c.legal_name ?? c.entity_id',
  )
})

test('AC seletor: o map produz um Empresa[] sobre as companies carregadas', () => {
  const boot = bootBody(read(STORE))
  assert.match(
    boot,
    /const\s+empresas:\s*Empresa\[\]\s*=\s*companies\.map\(/,
    'boot() deve mapear companies -> Empresa[]',
  )
})

test('AC seletor: changeEmpresa/empresaAtualId continuam intactos (sem regressao no mecanismo de troca)', () => {
  const store = read(STORE)
  // O estado ativo ainda e derivado das empresas mapeadas.
  assert.match(
    store,
    /empresaAtualId:\s*empresas\.find\(/,
    'empresaAtualId deve continuar sendo derivado da lista de empresas no boot()',
  )
  // A acao changeEmpresa ainda existe no store.
  assert.match(store, /changeEmpresa/, 'a acao changeEmpresa deve continuar existindo no store')
})

// AC#3 (regressao) — boot() ainda estabelece a empresa ativa a partir das
// empresas carregadas. Asserta a expressao real de derivacao (ativa -> primeira
// -> null) dentro do corpo de boot(); falharia se essa logica fosse removida ao
// trocar a fonte de dados para getCompanies().
test('AC seletor (regressao boot): boot() deriva empresaAtualId de empresas.find(e.ativa) ?? empresas[0] ?? null', () => {
  const boot = bootBody(read(STORE))
  assert.match(
    boot,
    /empresaAtualId:\s*empresas\.find\(\(e\)\s*=>\s*e\.ativa\)\?\.id\s*\?\?\s*empresas\[0\]\?\.id\s*\?\?\s*null/,
    "boot() deve setar empresaAtualId = empresas.find((e) => e.ativa)?.id ?? empresas[0]?.id ?? null",
  )
})

// AC#3 (regressao) — o flag `ativa` de cada Empresa e derivado do status da
// company (c.status === 'ativo'), de modo que a empresa ativa no boot e a
// primeira ATIVA. Asserta a expressao real do map; falharia se a derivacao do
// status fosse removida ou trocada.
test("AC seletor (regressao boot): o map deriva ativa de c.status === 'ativo'", () => {
  const boot = bootBody(read(STORE))
  assert.match(
    boot,
    /ativa:\s*c\.status\s*===\s*'ativo'/,
    "o map de CompanyRow -> Empresa deve setar ativa: c.status === 'ativo'",
  )
})

// ===========================================================================
// AC seletor (componente): EmpresaSelector agrupa por e.grupo e o chip da marca
// renderiza atual.grupo. Negativo: nao referencia MOCK_EMPRESAS.
// ===========================================================================

test('AC seletor: EmpresaSelector agrupa por e.grupo (marca) no dropdown', () => {
  const src = read(SELECTOR)
  assert.match(
    src,
    /const\s+g\s*=\s*e\.grupo\s*\?\?/,
    'EmpresaSelector deve agrupar usando e.grupo (que agora carrega a marca)',
  )
})

test('AC seletor: o chip ao lado do nome renderiza atual.grupo (a marca da empresa ativa)', () => {
  const src = read(SELECTOR)
  assert.match(
    src,
    /\{\s*atual\.grupo\s*\}/,
    'o chip de marca deve renderizar {atual.grupo}',
  )
})

test('AC seletor (regressao): EmpresaSelector NAO referencia MOCK_EMPRESAS', () => {
  const src = read(SELECTOR)
  assert.ok(
    !/MOCK_EMPRESAS/.test(src),
    'EmpresaSelector nao deve referenciar a lista hardcoded MOCK_EMPRESAS',
  )
})

// AC#3 — selecao: o item do dropdown chama changeEmpresa(e.id) no onSelect.
// Falharia se a troca de empresa estivesse desconectada do clique.
test('AC seletor (selecao): o item do dropdown liga onSelect a changeEmpresa(e.id)', () => {
  const src = read(SELECTOR)
  assert.match(
    src,
    /onSelect=\{\s*\(\)\s*=>\s*changeEmpresa\(e\.id\)\s*\}/,
    'cada DropdownMenu.Item deve ter onSelect={() => changeEmpresa(e.id)} (clicar troca a empresa)',
  )
})

// AC#3 — indicador da selecao atual: o Check so renderiza para a empresa ativa.
// Falharia se o indicador de empresa atual fosse removido ou desvinculado.
test('AC seletor (selecao atual): renderiza o Check condicionado a e.id === empresaAtualId', () => {
  const src = read(SELECTOR)
  assert.match(
    src,
    /\{\s*e\.id\s*===\s*empresaAtualId\s*&&\s*<Check\b/,
    'o marcador Check deve aparecer so quando e.id === empresaAtualId (empresa ativa)',
  )
})

// AC#2 — agrupamento por marca renderizado: itera os grupos e renderiza o nome
// do grupo (marca) como rotulo de secao. Falharia se o dropdown deixasse de
// renderizar a divisao por marca (mesmo que o store ainda agrupasse os dados).
test('AC seletor (agrupamento): renderiza um DropdownMenu.Label por grupo (marca) iterando grupos.entries()', () => {
  const src = read(SELECTOR)
  assert.match(
    src,
    /\[\.\.\.grupos\.entries\(\)\]\.map\(\(\[grupo,\s*lista\]/,
    'EmpresaSelector deve iterar [...grupos.entries()].map(([grupo, lista], ...)) para renderizar as secoes',
  )
  // E o nome do grupo (marca) deve aparecer como rotulo de secao no dropdown.
  assert.match(
    src,
    /<DropdownMenu\.Label[^>]*>\s*\{grupo\}\s*<\/DropdownMenu\.Label>/,
    'cada secao deve renderizar <DropdownMenu.Label>{grupo}</DropdownMenu.Label> (rotulo da marca)',
  )
})

// ===========================================================================
// AC "Renomear menus": no MOCK_MENU, dia-vehicles vira "Veiculos" e dia-parts
// vira "Pecas" (text + spec.title), sem mais "Estoque de Veiculos"/"Estoque de
// Pecas" NESSES itens. Helper isola o bloco de cada item por id.
// ===========================================================================

// Extrai o bloco { ... } do item de menu cujo id === wantedId.
function menuItemBlock(src, wantedId) {
  const marker = `id: '${wantedId}'`
  const at = src.indexOf(marker)
  assert.ok(at !== -1, `item de menu com ${marker} deve existir em portalApi.ts`)
  // Sobe ate a chave de abertura do objeto e desce ate o spec.title da mesma entrada.
  const open = src.lastIndexOf('{', at)
  // O bloco do item vai ate a primeira linha 'spec: {...},' apos o marker.
  const specAt = src.indexOf('spec:', at)
  const specEnd = src.indexOf('\n', src.indexOf('}', specAt))
  return src.slice(open, specEnd === -1 ? undefined : specEnd)
}

test('AC menus: dia-vehicles tem text "Veiculos" e spec.title "Veiculos"', () => {
  const block = menuItemBlock(read(PORTAL_API), 'dealership-vehicles')
  assert.match(block, /text:\s*'Veículos'/, "dia-vehicles deve ter text: 'Veículos'")
  assert.match(block, /title:\s*'Veículos'/, "dia-vehicles deve ter spec.title: 'Veículos'")
})

test('AC menus (regressao): dia-vehicles NAO usa mais "Estoque de Veiculos"', () => {
  const block = menuItemBlock(read(PORTAL_API), 'dealership-vehicles')
  assert.ok(
    !/Estoque de Veículos/.test(block),
    "o item dealership-vehicles nao deve mais conter 'Estoque de Veículos'",
  )
})

test('AC menus: dia-parts tem text "Pecas" e spec.title "Pecas"', () => {
  const block = menuItemBlock(read(PORTAL_API), 'dealership-parts')
  assert.match(block, /text:\s*'Peças'/, "dia-parts deve ter text: 'Peças'")
  assert.match(block, /title:\s*'Peças'/, "dia-parts deve ter spec.title: 'Peças'")
})

test('AC menus (regressao): dia-parts NAO usa mais "Estoque de Pecas"', () => {
  const block = menuItemBlock(read(PORTAL_API), 'dealership-parts')
  assert.ok(
    !/Estoque de Peças/.test(block),
    "o item dealership-parts nao deve mais conter 'Estoque de Peças'",
  )
})

// ===========================================================================
// AC "Reclassificacao": Empresas (dealership-companies) e Marcas
// (dealership-brands) agora carregam requiredRole: 'admin', aparecem DENTRO do
// bloco do grupo admin (Administracao) e NAO dentro do grupo dealership
// (Concessionaria). componentKeys preservados (dia-companies/dia-brands).
// ===========================================================================

// Calcula os limites dos blocos de children de cada grupo de topo (dealership e
// admin) usando os marcadores id: 'dealership' e id: 'admin'.
function groupSpans(src) {
  const dealAt = src.indexOf("id: 'dealership'")
  const adminAt = src.indexOf("id: 'admin'")
  assert.ok(dealAt !== -1, "grupo id: 'dealership' deve existir")
  assert.ok(adminAt !== -1, "grupo id: 'admin' deve existir")
  // No arquivo o grupo dealership precede o grupo admin; o bloco dealership vai
  // ate o inicio do bloco admin, e o admin vai ate o fim.
  assert.ok(dealAt < adminAt, "o grupo dealership deve preceder o grupo admin no arquivo")
  return { dealAt, adminAt }
}

for (const id of ['dealership-companies', 'dealership-brands']) {
  test(`AC reclass: ${id} carrega requiredRole: 'admin'`, () => {
    const block = menuItemBlock(read(PORTAL_API), id)
    assert.match(
      block,
      /requiredRole:\s*'admin'/,
      `${id} deve carregar requiredRole: 'admin'`,
    )
  })

  test(`AC reclass: ${id} esta no grupo admin (Administracao), NAO no grupo dealership (Concessionaria)`, () => {
    const src = read(PORTAL_API)
    const { dealAt, adminAt } = groupSpans(src)
    const itemAt = src.indexOf(`id: '${id}'`)
    assert.ok(itemAt !== -1, `${id} deve existir`)
    assert.ok(
      itemAt > adminAt,
      `${id} deve aparecer DEPOIS do marcador id: 'admin' (dentro do grupo Administracao)`,
    )
    // E nao na faixa do grupo dealership (entre dealAt e adminAt).
    assert.ok(
      !(itemAt > dealAt && itemAt < adminAt),
      `${id} nao deve aparecer dentro do bloco do grupo dealership (Concessionaria)`,
    )
  })
}

test("AC reclass: componentKeys preservados — dia-companies e dia-brands ainda abrem os CRUDs", () => {
  const src = read(PORTAL_API)
  const companies = menuItemBlock(src, 'dealership-companies')
  const brands = menuItemBlock(src, 'dealership-brands')
  assert.match(
    companies,
    /componentKey:\s*'dia-companies'/,
    "Empresas deve manter componentKey: 'dia-companies' (CRUD intacto)",
  )
  assert.match(
    brands,
    /componentKey:\s*'dia-brands'/,
    "Marcas deve manter componentKey: 'dia-brands' (CRUD intacto)",
  )
})
