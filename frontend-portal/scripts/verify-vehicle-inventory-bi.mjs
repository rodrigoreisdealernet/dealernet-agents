// Verificacao dependency-free do dashboard "Estoque de Veículos" (Fast BI).
//
// Origem: Issue #19 (criacao da tela). Atualizado para a Issue #101, que
// reescreveu a tela com filtros inline (Marca + Empresa), seletor de Métrica
// (Valor do estoque | Floor plan) que dirige os dois graficos, grafico por
// marca agrupado SO por brand, serie unica com colorByPoint, e KPIs
// recalculados a partir dos veiculos filtrados (sem getOwnerKpis).
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest): usamos apenas
// os modulos nativos do Node (node:test, node:assert, node:fs) para assertar —
// lendo os arquivos-fonte como texto — que a tela VehicleInventoryBI.tsx e sua
// fiacao satisfazem os criterios de aceite da spec
// docs/specs/101-estoque-floor-plan-bi-filtros.md.
//
// Roda com: node --test scripts/verify-vehicle-inventory-bi.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const VEHICLE_BI_PATH = 'src/portal/renderers/screens/VehicleInventoryBI.tsx'
const REGISTRY_PATH = 'src/portal/renderers/registry.ts'
const PORTAL_API_PATH = 'src/portal/lib/portalApi.ts'
const AGENTS_API_PATH = 'src/portal/lib/agentsApi.ts'
const PT_BR_PATH = 'src/i18n/messages/pt-BR.json'
const EN_US_PATH = 'src/i18n/messages/en-US.json'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// AC screen+registry: a tela existe e exporta o componente default.
test('AC screen+registry: VehicleInventoryBI.tsx existe e exporta VehicleInventoryBI', () => {
  assert.ok(
    existsSync(resolve(ROOT, VEHICLE_BI_PATH)),
    `${VEHICLE_BI_PATH} deve existir`,
  )
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /export\s+default\s+function\s+VehicleInventoryBI\s*\(/,
    'VehicleInventoryBI.tsx deve ter "export default function VehicleInventoryBI(...)"',
  )
})

// AC screen+registry: registry.ts mapeia 'dia-vehicle-inventory' via lazy import.
test("AC screen+registry: registry.ts registra 'dia-vehicle-inventory' com lazy import", () => {
  const src = read(REGISTRY_PATH)
  assert.match(
    src,
    /['"]dia-vehicle-inventory['"]\s*:\s*lazy\(\s*\(\)\s*=>\s*import\([^)]*VehicleInventoryBI[^)]*\)\s*\)/,
    "registry.ts deve mapear 'dia-vehicle-inventory' -> lazy(() => import('.../VehicleInventoryBI'))",
  )
})

// AC menu: o item "Estoque de Veículos" aparece sob a secao Fast BI correta.
test("AC menu: portalApi.ts tem 'Estoque de Veículos' -> dia-vehicle-inventory dentro de Fast BI", () => {
  const src = read(PORTAL_API_PATH)
  assert.match(
    src,
    /id:\s*['"]fast-bi['"][\s\S]*?text:\s*['"]Fast BI['"]/,
    "a secao 'fast-bi' do MOCK_MENU deve ter text 'Fast BI'",
  )
  assert.match(
    src,
    /text:\s*['"]Estoque de Veículos['"]/,
    "MOCK_MENU deve conter item com text 'Estoque de Veículos'",
  )
  assert.match(
    src,
    /text:\s*['"]Estoque de Veículos['"][\s\S]{0,400}?componentKey:\s*['"]dia-vehicle-inventory['"]/,
    "o item 'Estoque de Veículos' deve referenciar componentKey 'dia-vehicle-inventory'",
  )
  const fastBiStart = src.indexOf("id: 'fast-bi'")
  const dealershipStart = src.indexOf("id: 'dealership'")
  assert.ok(
    fastBiStart !== -1 && dealershipStart !== -1 && fastBiStart < dealershipStart,
    'as secoes fast-bi e dealership devem existir nessa ordem',
  )
  const fastBiBlock = src.slice(fastBiStart, dealershipStart)
  assert.match(
    fastBiBlock,
    /text:\s*['"]Estoque de Veículos['"][\s\S]*?componentKey:\s*['"]dia-vehicle-inventory['"]/,
    "o item 'dia-vehicle-inventory' deve estar dentro da secao Fast BI",
  )
})

// AC #101 filtros: dropdowns Marca + Empresa + Métrica inline, com estado local,
// opcoes "Todas" e options derivadas dos valores distintos do summary.
test('AC #101 filtros: selects Marca/Empresa/Métrica com estado, opcao "Todas" e options distintas do summary', () => {
  const src = read(VEHICLE_BI_PATH)

  // Estado local para os tres controles.
  assert.match(src, /useState<string>\(\s*ALL\s*\)/, 'deve haver estado de filtro inicializado em ALL (Marca/Empresa)')
  assert.match(
    src,
    /const\s+\[\s*brand\s*,\s*setBrand\s*\]\s*=\s*useState/,
    'deve declarar estado brand/setBrand',
  )
  assert.match(
    src,
    /const\s+\[\s*empresa\s*,\s*setEmpresa\s*\]\s*=\s*useState/,
    'deve declarar estado empresa/setEmpresa (Empresa)',
  )
  assert.match(
    src,
    /const\s+\[\s*metric\s*,\s*setMetric\s*\]\s*=\s*useState<Metric>\(\s*['"]inventory_value['"]\s*\)/,
    "deve declarar estado metric/setMetric com default 'inventory_value'",
  )

  // Tipo Metric restrito aos dois valores suportados.
  assert.match(
    src,
    /type\s+Metric\s*=\s*['"]inventory_value['"]\s*\|\s*['"]floor_plan_cost['"]/,
    "Metric deve ser 'inventory_value' | 'floor_plan_cost'",
  )

  // Opcoes distintas: Marca deriva de summary.brand; Empresa deriva de summary.store.
  assert.match(
    src,
    /brandOptions\s*=\s*useMemo\(\s*\(\)\s*=>\s*distinct\(\s*summary\.map\(\s*\(\s*\w+\s*\)\s*=>\s*\w+\.brand\s*\)\s*\)/,
    'brandOptions deve vir de distinct(summary.map(r => r.brand))',
  )
  assert.match(
    src,
    /empresaOptions\s*=\s*useMemo\(\s*\(\)\s*=>\s*distinct\(\s*summary\.map\(\s*\(\s*\w+\s*\)\s*=>\s*\w+\.store\s*\)\s*\)/,
    'empresaOptions (Empresa) deve vir de distinct(summary.map(r => r.store)) — empresa mapeia a store',
  )

  // Tres <select> ligados a brand/empresa/metric com onChange. Para cada um,
  // isolamos o BLOCO de abertura da tag `<select ...>` (do `<select` ate o `>`
  // imediatamente antes do primeiro filho `<option`) e exigimos que value E
  // onChange pertencam AO MESMO <select> — assim uma fiacao cruzada (value de um
  // select, onChange de outro) falha. O lazy [\s\S]*? nao vaza para o proximo
  // <select> porque ancoramos no `<option` filho que segue cada abertura.
  // (Nao usamos [^>]* porque o `>` do arrow `=>` em onChange encerraria cedo.)
  const selectOpenTags = [...src.matchAll(/<select\b[\s\S]*?>\s*<option\b/g)].map((m) => m[0])
  assert.equal(selectOpenTags.length, 3, `esperado exatamente 3 <select> (Marca/Empresa/Métrica); encontrados ${selectOpenTags.length}`)

  const brandSelect = selectOpenTags.find((tag) => /value=\{brand\}/.test(tag))
  assert.ok(brandSelect, 'deve haver um <select> com value={brand}')
  assert.match(
    brandSelect,
    /onChange=\{\(\s*e\s*\)\s*=>\s*setBrand\(\s*e\.target\.value\s*\)\}/,
    'o <select> da Marca (value={brand}) deve ter onChange que chama setBrand(e.target.value)',
  )

  const empresaSelect = selectOpenTags.find((tag) => /value=\{empresa\}/.test(tag))
  assert.ok(empresaSelect, 'deve haver um <select> com value={empresa}')
  assert.match(
    empresaSelect,
    /onChange=\{\(\s*e\s*\)\s*=>\s*setEmpresa\(\s*e\.target\.value\s*\)\}/,
    'o <select> da Empresa (value={empresa}) deve ter onChange que chama setEmpresa(e.target.value)',
  )

  const metricSelect = selectOpenTags.find((tag) => /value=\{metric\}/.test(tag))
  assert.ok(metricSelect, 'deve haver um <select> com value={metric}')
  assert.match(
    metricSelect,
    /onChange=\{\(\s*e\s*\)\s*=>\s*setMetric\(\s*e\.target\.value\s+as\s+Metric\s*\)\}/,
    'o <select> da Métrica (value={metric}) deve ter onChange que chama setMetric(e.target.value as Metric)',
  )

  // Opcao "Todas" em cada filtro (Marca e Empresa).
  assert.match(src, /<option\s+value=\{ALL\}>\{t\(\s*['"]all['"]\s*\)\}<\/option>/, "Marca deve ter <option value={ALL}> com t('all')")
  assert.match(
    src,
    /<option\s+value=\{ALL\}>\{t\(\s*['"]allCompanies['"]\s*\)\}<\/option>/,
    "Empresa deve ter <option value={ALL}> com t('allCompanies')",
  )

  // O seletor de metrica expoe exatamente as duas metricas.
  assert.match(src, /<option\s+value="inventory_value">\{t\(\s*['"]metricInventoryValue['"]\s*\)\}/, "Métrica deve ter option inventory_value")
  assert.match(src, /<option\s+value="floor_plan_cost">\{t\(\s*['"]metricFloorPlan['"]\s*\)\}/, "Métrica deve ter option floor_plan_cost")

  // Rotulos i18n dos controles.
  for (const key of ['brand', 'company', 'metric']) {
    assert.match(src, new RegExp(`t\\(\\s*['"]${key}['"]\\s*\\)`), `deve usar t('${key}') como rotulo de filtro`)
  }
})

// AC #101 filtro de veiculos: filteredVehicles exige status em_estoque E marca E
// empresa/store (tolerante a ordem das clausulas). Base de KPIs e tabela.
test('AC #101 filtro de veiculos: status em_estoque + marca + empresa/store', () => {
  const src = read(VEHICLE_BI_PATH)
  const block = src.match(/filteredVehicles\s*=\s*useMemo\([\s\S]*?\[[^\]]*\]\s*,?\s*\)/)?.[0] ?? ''
  assert.ok(block, 'nao foi possivel localizar o useMemo de filteredVehicles')

  // Deve ser um .filter() real cujo predicado conjuga (AND) as TRES condicoes
  // numa unica expressao. Capturamos o corpo do callback ate o `)` do filter e
  // exigimos a estrutura `A && B && C`, de modo que um OR (`||`) entre os grupos,
  // ou a negacao de qualquer condicao, faca este teste falhar.
  const filterCb = block.match(
    /\.filter\(\s*\(\s*(\w+)\s*\)\s*=>([\s\S]*?)\)\s*,?\s*\[/,
  )
  assert.ok(filterCb, 'filteredVehicles deve usar um .filter((v) => ...) real')
  const param = filterCb[1]
  const predicate = filterCb[2]
  // status === 'em_estoque' (positivo, nao negado)
  assert.match(
    predicate,
    new RegExp(`${param}\\.status\\s*===\\s*['"]em_estoque['"]`),
    "predicado deve exigir status === 'em_estoque'",
  )
  // marca: (brand === ALL || v.brand === brand) — comparacao positiva.
  assert.match(
    predicate,
    new RegExp(`\\(\\s*brand\\s*===\\s*ALL\\s*\\|\\|\\s*${param}\\.brand\\s*===\\s*brand\\s*\\)`),
    'predicado deve conter o grupo de marca (brand === ALL || v.brand === brand)',
  )
  // empresa: (empresa === ALL || v.store === empresa) — sobre o campo store.
  assert.match(
    predicate,
    new RegExp(`\\(\\s*empresa\\s*===\\s*ALL\\s*\\|\\|\\s*${param}\\.store\\s*===\\s*empresa\\s*\\)`),
    'predicado deve conter o grupo de empresa (empresa === ALL || v.store === empresa)',
  )
  // E os tres grupos devem ser conjugados por && (AND), nao por || (OR). Esta
  // assercao falha se o predicado for invertido para um OR entre os grupos.
  assert.match(
    predicate,
    new RegExp(
      `${param}\\.status\\s*===\\s*['"]em_estoque['"]\\s*&&\\s*\\(\\s*brand\\s*===\\s*ALL\\s*\\|\\|\\s*${param}\\.brand\\s*===\\s*brand\\s*\\)\\s*&&\\s*\\(\\s*empresa\\s*===\\s*ALL\\s*\\|\\|\\s*${param}\\.store\\s*===\\s*empresa\\s*\\)`,
    ),
    'predicado deve ser a CONJUNCAO (AND) das tres condicoes: status && (marca) && (empresa)',
  )
  // Garante que nenhum OR liga os grupos de nivel superior (so os ALL-guards usam ||).
  const orCount = (predicate.match(/\|\|/g) ?? []).length
  assert.equal(orCount, 2, 'o predicado deve ter exatamente 2 operadores || (apenas dentro dos guards ALL); um OR entre os grupos seria um terceiro')
  // dependencias do memo reagem aos filtros
  assert.match(
    block,
    /\[\s*vehicles\s*,\s*brand\s*,\s*empresa\s*\]/,
    'filteredVehicles deve depender de [vehicles, brand, empresa]',
  )
})

// AC #101 summary filtrado: filteredSummary filtra por brand e store (empresa).
test('AC #101 summary filtrado: filteredSummary respeita marca + empresa/store', () => {
  const src = read(VEHICLE_BI_PATH)
  const block = src.match(/filteredSummary\s*=\s*useMemo\([\s\S]*?\[[^\]]*\]\s*,?\s*\)/)?.[0] ?? ''
  assert.ok(block, 'nao foi possivel localizar o useMemo de filteredSummary')

  // .filter() real cujo predicado conjuga (AND) marca + empresa.
  const filterCb = block.match(/\.filter\(\s*\(\s*(\w+)\s*\)\s*=>([\s\S]*?)\)\s*,?\s*\[/)
  assert.ok(filterCb, 'filteredSummary deve usar um .filter((r) => ...) real')
  const param = filterCb[1]
  const predicate = filterCb[2]
  assert.match(
    predicate,
    new RegExp(`\\(\\s*brand\\s*===\\s*ALL\\s*\\|\\|\\s*${param}\\.brand\\s*===\\s*brand\\s*\\)`),
    'filteredSummary deve filtrar por marca (brand === ALL || r.brand === brand)',
  )
  assert.match(
    predicate,
    new RegExp(`\\(\\s*empresa\\s*===\\s*ALL\\s*\\|\\|\\s*${param}\\.store\\s*===\\s*empresa\\s*\\)`),
    'filteredSummary deve filtrar por empresa sobre store (empresa === ALL || r.store === empresa)',
  )
  // Os dois grupos devem ser conjugados por && (AND), nao por OR.
  assert.match(
    predicate,
    new RegExp(
      `\\(\\s*brand\\s*===\\s*ALL\\s*\\|\\|\\s*${param}\\.brand\\s*===\\s*brand\\s*\\)\\s*&&\\s*\\(\\s*empresa\\s*===\\s*ALL\\s*\\|\\|\\s*${param}\\.store\\s*===\\s*empresa\\s*\\)`,
    ),
    'filteredSummary deve ser a CONJUNCAO (AND) de marca && empresa',
  )
  const orCount = (predicate.match(/\|\|/g) ?? []).length
  assert.equal(orCount, 2, 'predicado de filteredSummary deve ter exatamente 2 || (so os guards ALL); um OR entre os grupos seria um terceiro')
})

// AC #101 KPIs: os 4 KPIs sao recalculados a partir dos veiculos filtrados —
// soma cost, soma floor_plan_cost, media days_in_stock, contagem days_in_stock>90.
// getOwnerKpis NAO deve mais ser usado por esta tela.
test('AC #101 KPIs: recalculados de filteredVehicles (sum cost, sum floor_plan, avg days, count >90); sem getOwnerKpis', () => {
  const src = read(VEHICLE_BI_PATH)

  const kpiBlock = src.match(/const\s+kpis\s*=\s*useMemo\([\s\S]*?\[\s*filteredVehicles\s*\]\s*,?\s*\)/)?.[0] ?? ''
  assert.ok(kpiBlock, 'nao foi possivel localizar o useMemo de kpis derivado de filteredVehicles')

  // Itera os veiculos filtrados.
  assert.match(
    kpiBlock,
    /for\s*\(\s*const\s+\w+\s+of\s+filteredVehicles\s*\)/,
    'kpis deve iterar filteredVehicles',
  )
  // valor do estoque = soma de cost (com fallback ?? 0).
  assert.match(
    kpiBlock,
    /inventoryValue\s*\+=\s*\w+\.cost\s*\?\?\s*0/,
    'KPI valor do estoque deve somar v.cost ?? 0',
  )
  // floor plan total = soma de floor_plan_cost.
  assert.match(
    kpiBlock,
    /floorPlanTotal\s*\+=\s*\w+\.floor_plan_cost\s*\?\?\s*0/,
    'KPI floor plan total deve somar v.floor_plan_cost ?? 0',
  )
  // dias medios = round(soma / contagem) de days_in_stock.
  assert.match(
    kpiBlock,
    /\w+\.days_in_stock/,
    'KPI dias medios deve usar days_in_stock',
  )
  assert.match(
    kpiBlock,
    /Math\.round\(\s*daysSum\s*\/\s*daysCount\s*\)/,
    'KPI dias medios deve ser Math.round(daysSum / daysCount)',
  )
  // parados +90 = contagem de days_in_stock > 90.
  assert.match(
    kpiBlock,
    /\w+\.days_in_stock\s*>\s*90/,
    'KPI parados +90 deve contar days_in_stock > 90',
  )

  // O objeto retornado pelo useMemo deve expor EXATAMENTE os quatro campos —
  // inventoryValue, floorPlanTotal, avgDays (round avg) e aged90 (count >90).
  // Ancoramos no `return { ... }` para que a remocao de qualquer campo falhe.
  const kpiReturn = kpiBlock.match(/return\s*\{[\s\S]*?\}/)?.[0] ?? ''
  assert.ok(kpiReturn, 'kpis deve retornar um objeto literal com os campos dos KPIs')
  assert.match(kpiReturn, /\binventoryValue\b\s*,/, 'objeto kpis deve incluir o campo inventoryValue (valor do estoque)')
  assert.match(kpiReturn, /\bfloorPlanTotal\b\s*,/, 'objeto kpis deve incluir o campo floorPlanTotal (floor plan)')
  assert.match(
    kpiReturn,
    /\bavgDays\s*:\s*daysCount\s*>\s*0\s*\?\s*Math\.round\(\s*daysSum\s*\/\s*daysCount\s*\)\s*:\s*0/,
    'objeto kpis deve expor avgDays = round(daysSum/daysCount) com guarda de divisao por zero',
  )
  assert.match(kpiReturn, /\baged90\b\s*,?/, 'objeto kpis deve incluir o campo aged90 (parados +90)')

  // Os 4 KpiCard consomem o objeto kpis derivado.
  const kpiCount = (src.match(/<KpiCard\b/g) ?? []).length
  assert.ok(kpiCount >= 4, `deve renderizar ao menos 4 KpiCard; encontrados ${kpiCount}`)
  assert.match(src, /<KpiCard[^>]*value=\{formatBRLKpi\(\s*kpis\.inventoryValue\s*\)\}/, 'KpiCard valor do estoque = formatBRLKpi(kpis.inventoryValue)')
  assert.match(src, /<KpiCard[^>]*value=\{formatBRLKpi\(\s*kpis\.floorPlanTotal\s*\)\}/, 'KpiCard floor plan = formatBRLKpi(kpis.floorPlanTotal)')
  assert.match(src, /<KpiCard[^>]*value=\{kpis\.avgDays\}/, 'KpiCard dias medios = kpis.avgDays')
  assert.match(src, /<KpiCard[^>]*value=\{kpis\.aged90\}/, 'KpiCard parados +90 = kpis.aged90')

  // getOwnerKpis nao deve mais ser importado nem chamado aqui.
  assert.ok(
    !/\bgetOwnerKpis\b/.test(src),
    'getOwnerKpis nao deve mais ser usado por VehicleInventoryBI (KPIs vem dos veiculos filtrados)',
  )
})

// AC #101 age-band chart: ChartCard bar xKey age_band, ordem fixa, serie unica da
// metrica selecionada e colorByPoint; alimentado por filteredSummary.
test('AC #101 age-band chart: serie unica da metrica, colorByPoint, alimentado por filteredSummary', () => {
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /const\s+AGE_BANDS\s*=\s*\[\s*['"]0-30['"]\s*,\s*['"]31-60['"]\s*,\s*['"]61-90['"]\s*,\s*['"]90\+['"]\s*\]/,
    "deve declarar AGE_BANDS na ordem ['0-30', '31-60', '61-90', '90+']",
  )
  // O grafico por faixa deriva de filteredSummary (reativo aos filtros).
  assert.match(
    src,
    /ageBandChart\s*=\s*useMemo[\s\S]*?\[\s*filteredSummary\s*\]\s*,?\s*\)/,
    'ageBandChart deve depender de filteredSummary',
  )
  // Ancora no ChartCard que recebe data={ageBandChart} (sem [\s\S]*? vazar para o
  // segundo card) — [^<]* impede travessia de outra tag de abertura.
  const ageChartBlock =
    src.match(/<ChartCard\b(?:[^<]|<(?!ChartCard\b)|<\/)*?data=\{ageBandChart\}(?:[^<]|<(?!ChartCard\b)|<\/)*?\/>/)?.[0] ?? ''
  assert.ok(ageChartBlock, "nao foi possivel localizar o ChartCard de data={ageBandChart}")
  assert.match(ageChartBlock, /xKey="age_band"/, "o ChartCard de idade deve usar xKey='age_band'")
  assert.match(ageChartBlock, /type="bar"/, 'grafico de idade deve ser type="bar"')
  // Serie UNICA dirigida pelo estado metric (nao duas series).
  assert.match(
    ageChartBlock,
    /series=\{\[\s*\{\s*key:\s*metric\s*,\s*label:\s*metricLabel\s*,\s*format:\s*['"]currency['"]\s*\}\s*\]\}/,
    'grafico de idade deve ter UMA serie { key: metric, label: metricLabel, format: currency }',
  )
  assert.ok(
    !/key:\s*['"]inventory_value['"]/.test(ageChartBlock) &&
      !/key:\s*['"]floor_plan_cost['"]/.test(ageChartBlock),
    'grafico de idade NAO deve mais usar duas series hard-coded (floor_plan_cost + inventory_value)',
  )
  assert.match(ageChartBlock, /\bcolorByPoint\b/, 'grafico de idade deve passar colorByPoint')
})

// AC #101 brand chart: agrupa SO por brand (xKey="brand", nao brand_store), serie
// unica da metrica, ordena DESC pela metrica selecionada e usa colorByPoint.
test('AC #101 brand chart: agrupa so por brand (xKey brand), serie unica, ordena pela metrica, colorByPoint', () => {
  const src = read(VEHICLE_BI_PATH)

  // Nao deve mais existir o agrupamento por marca+loja.
  assert.ok(
    !/xKey="brand_store"/.test(src) && !/brand_store/.test(src),
    "o grafico por marca NAO deve mais usar brand_store (agrupa so por brand)",
  )

  // O memo do grafico agrupa por brand e reage a metrica.
  assert.match(
    src,
    /brandChart\s*=\s*useMemo/,
    'deve haver brandChart (agrupamento so por marca)',
  )
  const brandMemo = src.match(/brandChart\s*=\s*useMemo[\s\S]*?\[\s*filteredSummary\s*,\s*metric\s*,\s*t\s*\]\s*,?\s*\)/)?.[0] ?? ''
  assert.ok(brandMemo, 'nao foi possivel localizar o useMemo de brandChart')
  assert.match(brandMemo, /\.brand\b/, 'brandChart deve agrupar por row.brand')
  assert.match(
    brandMemo,
    /\.sort\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*\(\s*b\[metric\][\s\S]*?\)\s*-\s*\(\s*a\[metric\]/,
    'brandChart deve ordenar DESC pela metrica selecionada (b[metric] - a[metric])',
  )
  assert.match(brandMemo, /\[\s*filteredSummary\s*,\s*metric\s*,\s*t\s*\]/, 'brandChart deve depender de [filteredSummary, metric, t]')

  // O ChartCard correspondente: xKey brand, serie unica da metrica, colorByPoint.
  // Ancora no card que recebe data={brandChart} para nao capturar o card de idade.
  const brandChartBlock =
    src.match(/<ChartCard\b(?:[^<]|<(?!ChartCard\b)|<\/)*?data=\{brandChart\}(?:[^<]|<(?!ChartCard\b)|<\/)*?\/>/)?.[0] ?? ''
  assert.ok(brandChartBlock, "nao foi possivel localizar o ChartCard de data={brandChart}")
  assert.match(brandChartBlock, /xKey="brand"/, "o ChartCard por marca deve usar xKey='brand'")
  assert.match(brandChartBlock, /type="bar"/, 'grafico por marca deve ser type="bar"')
  assert.match(
    brandChartBlock,
    /series=\{\[\s*\{\s*key:\s*metric\s*,\s*label:\s*metricLabel\s*,\s*format:\s*['"]currency['"]\s*\}\s*\]\}/,
    'grafico por marca deve ter UMA serie { key: metric, ... }',
  )
  assert.match(brandChartBlock, /\bcolorByPoint\b/, 'grafico por marca deve passar colorByPoint')
})

// AC #101 titulos dinamicos: ambos os ChartCards usam o titulo i18n parametrizado
// pela metrica selecionada (metricByAge / metricByBrand com { metric }).
test('AC #101 titulos dinamicos por metrica: metricByAge e metricByBrand com { metric }', () => {
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /title=\{t\(\s*['"]metricByAge['"]\s*,\s*\{\s*metric:\s*metricLabel\s*\}\s*\)\}/,
    "grafico de idade deve usar t('metricByAge', { metric: metricLabel })",
  )
  assert.match(
    src,
    /title=\{t\(\s*['"]metricByBrand['"]\s*,\s*\{\s*metric:\s*metricLabel\s*\}\s*\)\}/,
    "grafico por marca deve usar t('metricByBrand', { metric: metricLabel })",
  )
  // metricLabel deriva do estado metric.
  assert.match(
    src,
    /const\s+metricLabel\s*=\s*metric\s*===\s*['"]inventory_value['"]\s*\?\s*t\(\s*['"]metricInventoryValue['"]\s*\)\s*:\s*t\(\s*['"]metricFloorPlan['"]\s*\)/,
    'metricLabel deve mapear o estado metric para o rotulo i18n',
  )
})

// AC #101 tabela: critical-vehicles usa filteredVehicles, ordena por
// floor_plan_cost desc e renderiza os campos, com moeda via formatBRLKpi.
test('AC #101 tabela: filteredVehicles ordenado por floor_plan_cost desc, campos e formatBRLKpi', () => {
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /import\s*\{[\s\S]*\bgetVehicles\b/,
    'VehicleInventoryBI deve importar getVehicles de agentsApi',
  )
  assert.match(src, /getVehicles\s*\(/, 'VehicleInventoryBI deve invocar getVehicles()')

  // A tabela parte de filteredVehicles (nao mais de vehicles cru).
  const oldestBlock = src.match(/oldestVehicles\s*=\s*useMemo\([\s\S]*?\[\s*filteredVehicles\s*\]\s*,?\s*\)/)?.[0] ?? ''
  assert.ok(oldestBlock, 'nao foi possivel localizar o useMemo de oldestVehicles')
  assert.match(oldestBlock, /\bfilteredVehicles\b/, 'oldestVehicles deve derivar de filteredVehicles')
  assert.match(
    oldestBlock,
    /\.sort\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\(\s*\2\.floor_plan_cost\s*\?\?\s*0\s*\)\s*-\s*\(\s*\1\.floor_plan_cost\s*\?\?\s*0\s*\)\s*,?\s*\)/,
    'lista deve ordenar por floor_plan_cost DESC com fallback ?? 0',
  )

  assert.match(src, /vehicle\.days_in_stock/, 'linhas devem renderizar days_in_stock')
  assert.match(
    src,
    /formatBRLKpi\(\s*vehicle\.floor_plan_cost\s*\?\?\s*0\s*\)/,
    'linhas devem renderizar floor_plan_cost via formatBRLKpi',
  )
  assert.match(src, /vehicle\.store/, 'linhas devem renderizar store')
  for (const field of ['brand', 'model', 'model_year']) {
    assert.match(src, new RegExp(`vehicle\\.${field}`), `linhas devem renderizar vehicle.${field}`)
  }
})

// AC #101 moeda + legenda: KPIs/tabela usam formatBRLKpi; a tela mostra a legenda
// "Valores em R$" via common('valuesInBRL').
test('AC #101 moeda enxuta + legenda "Valores em R$"', () => {
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /import\s*\{\s*formatBRLKpi\s*\}\s*from\s*['"]\.\/format['"]/,
    'deve importar formatBRLKpi de ./format',
  )
  assert.match(
    src,
    /legend=\{common\(\s*['"]valuesInBRL['"]\s*\)\}/,
    "ScreenShell deve receber a legenda common('valuesInBRL')",
  )
  // A constante de referencia textual da legenda permanece.
  assert.match(src, /Valores em R\$/, 'a referencia textual "Valores em R$" deve permanecer')
})

// AC #101 estado de loading: agora usa common('loading') (nao mais literal "Carregando").
test('AC #101 graceful states: loading via common(loading), 2 emptyMessage e fallback de tabela', () => {
  const src = read(VEHICLE_BI_PATH)
  assert.match(
    src,
    /\{loading\s*&&\s*<p[^>]*>\{common\(\s*['"]loading['"]\s*\)\}<\/p>\}/,
    "estado de loading deve renderizar common('loading') (nao mais um literal 'Carregando')",
  )
  const emptyMatches = src.match(/emptyMessage=/g) ?? []
  const chartCount = (src.match(/<ChartCard\b/g) ?? []).length
  assert.ok(chartCount >= 2, `esperado >= 2 ChartCard; encontrados ${chartCount}`)
  assert.ok(
    emptyMatches.length >= chartCount,
    `cada ChartCard (${chartCount}) deve ter emptyMessage; encontrados ${emptyMatches.length}`,
  )
  // Fallback da tabela vazia via i18n.
  assert.match(src, /t\(\s*['"]noVehiclesInStock['"]\s*\)/, "deve haver fallback de tabela vazia via t('noVehiclesInStock')")
})

// AC #101 limpeza de i18n: chaves obsoletas do layout antigo nao devem mais ser
// referenciadas pela tela (duas series por idade/marca-loja).
test('AC #101 limpeza: chaves antigas floorPlanByAge/floorPlanByBrandStore/noBrandStoreData nao mais usadas', () => {
  const src = read(VEHICLE_BI_PATH)
  for (const key of ['floorPlanByAge', 'floorPlanByBrandStore', 'noBrandStoreData']) {
    assert.ok(
      !new RegExp(`['"]${key}['"]`).test(src),
      `a chave i18n obsoleta '${key}' nao deve mais ser referenciada por VehicleInventoryBI`,
    )
  }
})

// AC #101 paridade i18n: as chaves novas existem e sao identicas em pt-BR e en-US.
test('AC #101 i18n: chaves novas presentes em pt-BR e en-US (vehicleInventoryBI)', () => {
  const pt = JSON.parse(read(PT_BR_PATH))
  const en = JSON.parse(read(EN_US_PATH))
  const ptScreen = pt.screens?.vehicleInventoryBI ?? {}
  const enScreen = en.screens?.vehicleInventoryBI ?? {}
  const newKeys = [
    'brand',
    'all',
    'company',
    'allCompanies',
    'metric',
    'metricInventoryValue',
    'metricFloorPlan',
    'metricByAge',
    'metricByBrand',
    'noBrandData',
  ]
  for (const key of newKeys) {
    assert.ok(
      typeof ptScreen[key] === 'string' && ptScreen[key].length > 0,
      `pt-BR.screens.vehicleInventoryBI.${key} deve existir`,
    )
    assert.ok(
      typeof enScreen[key] === 'string' && enScreen[key].length > 0,
      `en-US.screens.vehicleInventoryBI.${key} deve existir`,
    )
  }
  // Os titulos parametrizados devem manter o placeholder {metric} nos dois locales.
  for (const key of ['metricByAge', 'metricByBrand']) {
    assert.match(ptScreen[key], /\{metric\}/, `pt-BR ${key} deve conter o placeholder {metric}`)
    assert.match(enScreen[key], /\{metric\}/, `en-US ${key} deve conter o placeholder {metric}`)
  }
  // As chaves obsoletas devem ter sido removidas dos dois locales.
  for (const key of ['floorPlanByAge', 'floorPlanByBrandStore', 'noBrandStoreData']) {
    assert.ok(!(key in ptScreen), `pt-BR nao deve mais conter a chave obsoleta '${key}'`)
    assert.ok(!(key in enScreen), `en-US nao deve mais conter a chave obsoleta '${key}'`)
  }
})

// AC data layer: agentsApi expoe as leituras das views reais consumidas pela tela
// (getInventorySummary + getVehicles e seus shapes).
test('AC data layer: agentsApi exporta inventory summary e vehicles das views reais', () => {
  const src = read(AGENTS_API_PATH)
  assert.match(
    src,
    /export\s+async\s+function\s+getInventorySummary\s*\(/,
    'agentsApi deve exportar getInventorySummary',
  )
  assert.match(
    src,
    /getInventorySummary[\s\S]*?\.from\(\s*['"]v_dia_inventory_summary['"]\s*\)/,
    "getInventorySummary deve ler a view 'v_dia_inventory_summary'",
  )
  assert.match(
    src,
    /export\s+async\s+function\s+getVehicles\s*\(/,
    'agentsApi deve exportar getVehicles',
  )
  assert.match(
    src,
    /getVehicles[\s\S]*?\.from\(\s*['"]v_dia_vehicle_current['"]\s*\)/,
    "getVehicles deve ler a view 'v_dia_vehicle_current'",
  )
  // O shape do summary expoe os campos consumidos pelos filtros/graficos.
  const inventoryBlock =
    src.match(/export\s+interface\s+InventorySummaryRow\s*\{[\s\S]*?\}/)?.[0] ?? ''
  assert.ok(inventoryBlock, 'nao foi possivel localizar InventorySummaryRow')
  for (const field of ['age_band', 'brand', 'store', 'inventory_value', 'floor_plan_cost']) {
    assert.match(
      inventoryBlock,
      new RegExp(`\\b${field}\\b`),
      `InventorySummaryRow deve declarar '${field}'`,
    )
  }
  // O shape do veiculo expoe os campos usados nos KPIs/tabela filtrados.
  const vehicleBlock = src.match(/export\s+interface\s+VehicleRow\s*\{[\s\S]*?\}/)?.[0] ?? ''
  assert.ok(vehicleBlock, 'nao foi possivel localizar VehicleRow')
  for (const field of ['brand', 'cost', 'status', 'store', 'days_in_stock', 'floor_plan_cost']) {
    assert.match(
      vehicleBlock,
      new RegExp(`\\b${field}\\b`),
      `VehicleRow deve declarar '${field}'`,
    )
  }
})
