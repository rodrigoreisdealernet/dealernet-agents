// Verificacao dependency-free do wiring de "Vendas de Veiculos" (Issue #130).
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest): usamos apenas os
// modulos nativos do Node (node:test, node:assert, node:fs) para assertar, lendo
// os arquivos-fonte, que o novo item de menu, a tela read-only de vendas e os
// filtros por status estao conectados corretamente. Espelha o padrao de Pecas
// (Estoque de Pecas / Venda de Pecas) no grupo Veiculos.
//
// Roda com: node --test scripts/verify-vehicle-sales-wiring.mjs
//
// Mapeamento spec docs/specs/130-feat-portal-vendas-de-veiculos.md:
//  - AC1: novo item de menu "Vendas de Veiculos", irmao de "Estoque de Veiculos".
//  - AC2: Estoque mostra somente status = 'em_estoque'.
//  - AC3: Vendas mostra somente status = 'vendido'.
//  - AC4: tela segue o molde (ScreenShell/KpiCard) com KPIs de vendas + R$.
//  - AC5: textos i18n em pt-BR e en-US, com paridade de chaves no bloco novo.

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

function readJson(relPath) {
  let parsed
  assert.doesNotThrow(() => {
    parsed = JSON.parse(read(relPath))
  }, `${relPath} deve ser JSON valido`)
  return parsed
}

// --- AC1: item de menu "Vendas de Veiculos" irmao de "Estoque de Veiculos" ---

test('AC1: MOCK_MENU tem item dealership-vehicle-sales com texto e componentKey corretos', () => {
  const portalApi = read('src/portal/lib/portalApi.ts')
  assert.ok(
    portalApi.includes("id: 'dealership-vehicle-sales'"),
    "portalApi.ts deve ter um item de menu com id 'dealership-vehicle-sales'",
  )
  assert.match(
    portalApi,
    /id:\s*['"]dealership-vehicle-sales['"][\s\S]*?text:\s*['"]Vendas de Veículos['"]/,
    "o item deve ter text: 'Vendas de Veículos'",
  )
  assert.match(
    portalApi,
    /id:\s*['"]dealership-vehicle-sales['"][\s\S]*?componentKey:\s*['"]dia-vehicle-sales['"]/,
    "o item deve apontar componentKey: 'dia-vehicle-sales' (liga menu -> registry -> tela)",
  )
})

test('AC1: dealership-vehicle-sales e irmao de dealership-vehicles no grupo dealership-veiculos', () => {
  const portalApi = read('src/portal/lib/portalApi.ts')
  // Recorta o grupo Veiculos (dealership-veiculos) ate o proximo grupo (oficina)
  // para garantir que AMBOS os itens vivem como filhos do mesmo grupo.
  const groupStart = portalApi.indexOf("id: 'dealership-veiculos'")
  const groupEnd = portalApi.indexOf("id: 'dealership-oficina'")
  assert.ok(groupStart !== -1, "grupo 'dealership-veiculos' deve existir")
  assert.ok(groupEnd !== -1 && groupEnd > groupStart, "grupo 'dealership-oficina' deve vir depois")
  const veiculosGroup = portalApi.slice(groupStart, groupEnd)

  assert.ok(
    veiculosGroup.includes("id: 'dealership-vehicles'"),
    'o item de Estoque (dealership-vehicles) deve estar no grupo Veiculos',
  )
  assert.ok(
    veiculosGroup.includes("id: 'dealership-vehicle-sales'"),
    'o item de Vendas (dealership-vehicle-sales) deve estar no MESMO grupo Veiculos (irmao do Estoque)',
  )
  // Espelha o padrao de Pecas: o item de vendas vem depois do item de estoque.
  assert.ok(
    veiculosGroup.indexOf("id: 'dealership-vehicles'") <
      veiculosGroup.indexOf("id: 'dealership-vehicle-sales'"),
    "Vendas deve vir apos Estoque, como 'Venda de Peças' apos 'Estoque de Peças'",
  )
})

// --- AC1/AC3: registro da tela no registry ---

test('AC1: registry mapeia dia-vehicle-sales -> import lazy de VehicleSales', () => {
  const registry = read('src/portal/renderers/registry.ts')
  assert.match(
    registry,
    /['"]dia-vehicle-sales['"]\s*:\s*lazy\([\s\S]*?VehicleSales/,
    "registry.ts deve mapear 'dia-vehicle-sales' -> import lazy de VehicleSales",
  )
})

// --- AC2: Estoque filtra somente em_estoque ---

test('AC2: VehiclesInventory filtra getVehicles por status === em_estoque', () => {
  const screen = read('src/portal/renderers/screens/VehiclesInventory.tsx')
  assert.match(
    screen,
    /\.filter\(\s*\(\s*\w+\s*\)\s*=>\s*\w+\.status\s*===\s*['"]em_estoque['"]\s*\)/,
    "VehiclesInventory deve filtrar as linhas por status === 'em_estoque'",
  )
  // O filtro de exibicao deve ser aplicado ao resultado de getVehicles em setRows
  // — e exatamente por 'em_estoque' (nao por 'vendido'), garantindo que vendidos
  // nao apareçam no Estoque. (O valor 'vendido' ainda existe no form de edicao,
  // pois marcar como vendido continua sendo feito na edicao do Estoque.)
  const setRowsCall = screen.match(/setRows\([^\n]*\)/)
  assert.ok(setRowsCall, 'VehiclesInventory deve popular as linhas via setRows(...)')
  assert.ok(
    setRowsCall[0].includes("'em_estoque'") && !setRowsCall[0].includes("'vendido'"),
    "setRows do Estoque deve filtrar por 'em_estoque' e nunca por 'vendido'",
  )
})

// --- AC3: nova tela Vendas filtra somente vendido ---

test('AC3: VehicleSales.tsx existe e filtra por status === vendido', () => {
  assert.ok(
    existsSync(resolve(ROOT, 'src/portal/renderers/screens/VehicleSales.tsx')),
    'a tela VehicleSales.tsx deve existir',
  )
  const screen = read('src/portal/renderers/screens/VehicleSales.tsx')
  assert.match(
    screen,
    /\.filter\(\s*\(\s*\w+\s*\)\s*=>\s*\w+\.status\s*===\s*['"]vendido['"]\s*\)/,
    "VehicleSales deve filtrar as linhas por status === 'vendido'",
  )
  // Read-only: sem caminho de escrita; vendido continua sendo setado no Estoque.
  assert.ok(
    !/\.rpc\(/.test(screen),
    'VehicleSales deve ser read-only (sem chamadas .rpc de escrita)',
  )
  assert.ok(
    !screen.includes("=== 'em_estoque'") && !screen.includes('=== "em_estoque"'),
    'Vendas nao deve exibir veiculos em estoque',
  )
})

// --- AC4: layout/KPIs de vendas no molde existente ---

test('AC4: VehicleSales usa ScreenShell/KpiCard com KPIs de unidades e receita', () => {
  const screen = read('src/portal/renderers/screens/VehicleSales.tsx')
  for (const piece of ['ScreenShell', 'KpiCard']) {
    assert.ok(screen.includes(piece), `VehicleSales deve usar ${piece} (mesmo molde das telas existentes)`)
  }
  assert.ok(
    screen.includes('getVehicles'),
    'VehicleSales deve ler os veiculos via getVehicles() (leitura da view)',
  )
  // KPI de receita somando o preco de venda das linhas vendidas.
  assert.match(
    screen,
    /reduce\([\s\S]*?sale_price/,
    'VehicleSales deve calcular a receita somando sale_price',
  )
  // KPIs renderizam unidades vendidas (contagem) e receita.
  assert.match(screen, /t\(\s*['"]unitsSold['"]\s*\)/, "KPI 'unidades vendidas' deve usar t('unitsSold')")
  assert.match(screen, /t\(\s*['"]revenue['"]\s*\)/, "KPI 'receita' deve usar t('revenue')")
  // Valores em R$ no padrao pt-BR (helper compartilhado).
  assert.ok(
    screen.includes('formatBRLKpi'),
    'VehicleSales deve formatar valores em R$ via formatBRLKpi (padrao pt-BR)',
  )
})

// --- AC5: i18n em pt-BR e en-US com paridade do bloco novo + rotulo de menu ---

const LOCALES = ['pt-BR', 'en-US']

test('AC5: ambas as locales tem o rotulo de menu dealership-vehicle-sales nao-vazio', () => {
  for (const locale of LOCALES) {
    const msgs = readJson(`src/i18n/messages/${locale}.json`)
    const label = msgs?.menu?.['dealership-vehicle-sales']
    assert.equal(typeof label, 'string', `${locale}: menu.dealership-vehicle-sales deve existir`)
    assert.ok(label.trim().length > 0, `${locale}: rotulo de menu nao pode ser vazio`)
  }
})

test('AC5: ambas as locales tem screens.vehicleSales com title nao-vazio', () => {
  for (const locale of LOCALES) {
    const msgs = readJson(`src/i18n/messages/${locale}.json`)
    const block = msgs?.screens?.vehicleSales
    assert.ok(block && typeof block === 'object', `${locale}: screens.vehicleSales deve existir`)
    assert.equal(typeof block.title, 'string', `${locale}: screens.vehicleSales.title deve existir`)
    assert.ok(block.title.trim().length > 0, `${locale}: title nao pode ser vazio`)
  }
})

test('AC5: paridade de chaves do bloco screens.vehicleSales entre pt-BR e en-US', () => {
  const pt = readJson('src/i18n/messages/pt-BR.json').screens.vehicleSales
  const en = readJson('src/i18n/messages/en-US.json').screens.vehicleSales
  const ptKeys = Object.keys(pt).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(ptKeys, enKeys, 'pt-BR e en-US devem ter exatamente as mesmas chaves em screens.vehicleSales')
  // Nenhum valor vazio em nenhuma das locales (sem chave crua vazando na UI).
  for (const [locale, block] of [['pt-BR', pt], ['en-US', en]]) {
    for (const [k, v] of Object.entries(block)) {
      assert.equal(typeof v, 'string', `${locale}: screens.vehicleSales.${k} deve ser string`)
      assert.ok(v.trim().length > 0, `${locale}: screens.vehicleSales.${k} nao pode ser vazio`)
    }
  }
})

test('AC5: todas as chaves t(...) usadas em VehicleSales existem nas duas locales', () => {
  const screen = read('src/portal/renderers/screens/VehicleSales.tsx')
  // Coleta as chaves do namespace screens.vehicleSales referenciadas via t('...').
  const used = new Set()
  for (const m of screen.matchAll(/\bt\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    used.add(m[1])
  }
  assert.ok(used.size > 0, 'VehicleSales deve referenciar pelo menos uma chave t(...)')
  for (const locale of LOCALES) {
    const block = readJson(`src/i18n/messages/${locale}.json`).screens.vehicleSales
    for (const key of used) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(block, key),
        `${locale}: screens.vehicleSales.${key} esta sendo usada na tela mas falta no i18n`,
      )
    }
  }
})
