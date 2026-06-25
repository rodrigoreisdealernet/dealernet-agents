// Testes do formatador de KPI cards (issue #54): formatBRLKpi.
//
// Diferente das demais verificacoes estruturais do repo (que assertam sobre o
// texto-fonte), aqui a logica sob teste e uma funcao pura — entao importamos e
// EXECUTAMOS o modulo real e assertamos sobre as saidas concretas. O TS e
// importado direto via stripping nativo de tipos do Node 24
// (--experimental-strip-types), sem introduzir um runner novo.
//
// Roda com: node --test --experimental-strip-types scripts/verify-kpi-format.mjs
// (o script "test" do package.json injeta a flag para este arquivo).
//
// Rastreabilidade dos criterios de aceite da spec
// docs/specs/54-ajustar-paineis-remover-r-e.md:
//  - "KPI cards display clean currency values" (sem R$, sem decimais, com
//    separador de milhar) -> formatBRLKpi
//  - "Precise values in tables and charts unaffected" -> regressao: formatBRL
//    continua com R$ e 2 decimais.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { formatBRL, formatBRLKpi } from '../src/portal/renderers/screens/format.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SCREENS = 'src/portal/renderers/screens'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// AC: KPI cards display clean currency values — inteiro mantem separador de
// milhar pt-BR, sem "R$", sem casas decimais.
test('formatBRLKpi: inteiro mantem separador de milhar, sem R$ e sem decimais', () => {
  const out = formatBRLKpi(19301100)
  assert.equal(out, '19.301.100')
  assert.ok(!out.includes('R$'), 'nao deve conter o simbolo R$')
  assert.ok(!out.includes(','), 'nao deve conter virgula decimal')
})

// AC: KPI cards display clean currency values — arredonda decimais para inteiro
// (1289544.52 -> 1.289.545, arredondamento para cima no .52).
test('formatBRLKpi: arredonda decimais para inteiro (1289544.52 -> "1.289.545")', () => {
  assert.equal(formatBRLKpi(1289544.52), '1.289.545')
})

// Arredondamento para baixo quando a fracao < 0.5.
test('formatBRLKpi: arredonda para baixo quando fracao < 0.5 (1289544.49 -> "1.289.544")', () => {
  assert.equal(formatBRLKpi(1289544.49), '1.289.544')
})

// Numeros pequenos (< 1000) nao ganham separador algum.
test('formatBRLKpi: numeros < 1000 nao ganham separador', () => {
  assert.equal(formatBRLKpi(999), '999')
  assert.equal(formatBRLKpi(42), '42')
})

// Zero deve renderizar "0" (e nao o placeholder "—").
test('formatBRLKpi: zero renderiza "0"', () => {
  assert.equal(formatBRLKpi(0), '0')
})

// Valores negativos preservam o sinal e o separador.
test('formatBRLKpi: valor negativo preserva sinal e separador', () => {
  assert.equal(formatBRLKpi(-19301100), '-19.301.100')
})

// AC (robustez): entradas invalidas/ausentes caem no placeholder "—".
test('formatBRLKpi: null/undefined/NaN/Infinity -> "—"', () => {
  assert.equal(formatBRLKpi(null), '—')
  assert.equal(formatBRLKpi(undefined), '—')
  assert.equal(formatBRLKpi(NaN), '—')
  assert.equal(formatBRLKpi(Infinity), '—')
  assert.equal(formatBRLKpi(-Infinity), '—')
})

// Tipos nao-numericos tambem caem no placeholder (defesa do typeof).
test('formatBRLKpi: entrada nao-numerica -> "—"', () => {
  // @ts-expect-error: cobrindo chamada indevida em runtime.
  assert.equal(formatBRLKpi('19301100'), '—')
})

// AC: Precise values in tables and charts unaffected — formatBRL CONTINUA com o
// simbolo "R$" e 2 casas decimais. Garante que os dois formatadores permanecem
// distintos (Non-Goal: nao mexer no formatBRL).
test('REGRESSAO formatBRL: mantem "R$" e 2 casas decimais', () => {
  const out = formatBRL(1289544.52)
  assert.ok(out.startsWith('R$'), 'formatBRL deve prefixar com R$')
  assert.ok(out.includes(',52'), 'formatBRL deve manter os centavos (2 decimais)')
  // Os dois formatadores devem divergir para o mesmo input.
  assert.notEqual(out, formatBRLKpi(1289544.52))
})

// REGRESSAO formatBRL: inteiro ainda recebe ",00" (2 decimais sempre).
test('REGRESSAO formatBRL: inteiro recebe ",00"', () => {
  const out = formatBRL(19301100)
  assert.ok(out.startsWith('R$'), 'formatBRL deve prefixar com R$')
  assert.ok(out.includes(',00'), 'formatBRL deve exibir ",00" para inteiros')
})

// REGRESSAO formatBRL: placeholder "—" preservado para entradas invalidas.
test('REGRESSAO formatBRL: null/NaN/Infinity -> "—"', () => {
  assert.equal(formatBRL(null), '—')
  assert.equal(formatBRL(NaN), '—')
  assert.equal(formatBRL(Infinity), '—')
})

// AC: Legend "Valores em R$" visible on all dashboards. O ScreenShell expoe uma
// prop `legend` (ui.tsx) que renderiza a nota de denominacao no header. Garante
// que a infra do legend existe e que ela so renderiza quando passada.
test('AC legend: ScreenShell aceita a prop `legend` e a renderiza no header', () => {
  const src = read(`${SCREENS}/ui.tsx`)
  assert.match(src, /\blegend\?\s*:/, 'ScreenShell deve declarar a prop opcional `legend`')
  // O legend so renderiza quando passado (render condicional), no header.
  assert.match(
    src,
    /\{legend\s*&&[\s\S]*?\{legend\}/,
    'ScreenShell deve renderizar `legend` condicionalmente (so quando passado)',
  )
})

// AC: cada dashboard com KPI cards exibe a nota "Valores em R$". Cobre os 13
// dashboards listados na spec (Acceptance Criteria #5).
test('AC legend: "Valores em R$" presente em todos os dashboards com KPI cards', () => {
  const dashboards = [
    'DiaOverview',
    'MorningBrief',
    'SalesDashboard',
    'ServiceDashboard',
    'PartsBI',
    'PartSales',
    'PartsInventory',
    'VehicleInventoryBI',
    'VehiclesInventory',
    'ExecutivePack',
    'AgentsDashboard',
    'ServiceOrders',
    'FindingDetail',
  ]
  for (const name of dashboards) {
    const src = read(`${SCREENS}/${name}.tsx`)
    assert.ok(
      src.includes('Valores em R$'),
      `${name}.tsx deve exibir a legenda "Valores em R$" (issue #54, AC legend)`,
    )
  }
})
