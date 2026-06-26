// Verificacao da "proxima execucao real" dos agentes DIA no dashboard
// (issue #124 — spec docs/specs/124-feat-ops-proxima-execucao-real.md).
//
// Duas frentes:
//  1. Logica pura `cronToHuman` / `cadenceForAgent` (src/portal/lib/cron.ts) —
//     importamos e EXECUTAMOS o modulo real e assertamos sobre as cadencias
//     localizadas concretas (estilo verify-kpi-format.mjs). O TS e importado
//     direto via stripping nativo de tipos do Node (--experimental-strip-types).
//  2. Wiring de fonte/i18n — AgentsDashboard.tsx renderiza next_run_at via
//     formatDateTime + usa a chave noSchedule; ambos os locales trazem
//     screens.agentsDashboard.nextRun e .noSchedule (estilo verify-*.mjs).
//
// Roda com: node --test --experimental-strip-types scripts/verify-agent-next-run.mjs
// (o script "test" do package.json injeta a flag para este arquivo).
//
// Rastreabilidade dos criterios de aceite:
//  - AC1 — proxima execucao + cadencia visiveis por agente.
//  - AC2 — cadencia derivada do cron (0 6 * * 1-5 -> dias uteis as 06:00).
//  - AC4 — estado "sem execucao agendada" / "no scheduled run".
//  - AC5 — cron invalido -> sem cadencia (null), nao quebra.
//  - AC6 — rotulos/valor localizados em pt-BR e en-US, sem chave crua.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { cronToHuman, cadenceForAgent, DIA_AGENT_CRONS } from '../src/portal/lib/cron.ts'

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

const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'
const AGENTS_DASHBOARD = 'src/portal/renderers/screens/AgentsDashboard.tsx'

// Os quatro agentes DIA (ops_agent_status_view).
const DIA_AGENTS = [
  'vehicle-aging-analyst',
  'collections-prioritizer',
  'parts-inventory-advisor',
  'service-estimate-rescue',
]

// ---------------------------------------------------------------------------
// AC2 — cadencia derivada do cron: "0 6 * * 1-5" -> "dias uteis as 06:00" /
//       "weekdays at 06:00" (com horario zero-padded).
// ---------------------------------------------------------------------------
test('cronToHuman: 0 6 * * 1-5 -> dias uteis as 06:00 / weekdays at 06:00', () => {
  assert.equal(cronToHuman('0 6 * * 1-5', 'pt-BR'), 'dias úteis às 06:00')
  assert.equal(cronToHuman('0 6 * * 1-5', 'en-US'), 'weekdays at 06:00')
})

// service-estimate-rescue roda 07:00 (zero-pad mantem dois digitos na hora).
test('cronToHuman: 0 7 * * 1-5 -> dias uteis as 07:00 / weekdays at 07:00', () => {
  assert.equal(cronToHuman('0 7 * * 1-5', 'pt-BR'), 'dias úteis às 07:00')
  assert.equal(cronToHuman('0 7 * * 1-5', 'en-US'), 'weekdays at 07:00')
})

// AC2 — dia unico da semana (parts-inventory roda segundas).
test('cronToHuman: 0 6 * * 1 -> segundas as 06:00 / Mondays at 06:00', () => {
  assert.equal(cronToHuman('0 6 * * 1', 'pt-BR'), 'segundas às 06:00')
  assert.equal(cronToHuman('0 6 * * 1', 'en-US'), 'Mondays at 06:00')
})

test('cronToHuman: diario 30 9 * * * -> todos os dias / daily', () => {
  assert.equal(cronToHuman('30 9 * * *', 'pt-BR'), 'todos os dias às 09:30')
  assert.equal(cronToHuman('30 9 * * *', 'en-US'), 'daily at 09:30')
})

test('cronToHuman: a cada N horas 0 */6 * * * -> a cada 6 horas / every 6 hours', () => {
  assert.equal(cronToHuman('0 */6 * * *', 'pt-BR'), 'a cada 6 horas')
  assert.equal(cronToHuman('0 */6 * * *', 'en-US'), 'every 6 hours')
})

// AC6 — locale desconhecido/ausente recai em pt-BR (nunca lanca, nunca chave crua).
test('cronToHuman: locale desconhecido recai em pt-BR', () => {
  assert.equal(cronToHuman('0 6 * * 1-5', 'fr-FR'), 'dias úteis às 06:00')
})

// AC5 — cron invalido/vazio -> null (caller omite a cadencia, sem quebrar).
test('cronToHuman: cron invalido/vazio -> null', () => {
  for (const bad of ['', '   ', null, undefined, '0 6 * *', '0 6 * * 1-5 7', 'lixo']) {
    assert.equal(cronToHuman(bad, 'pt-BR'), null, `esperado null para ${JSON.stringify(bad)}`)
    assert.equal(cronToHuman(bad, 'en-US'), null, `esperado null para ${JSON.stringify(bad)}`)
  }
})

// AC1/AC2 — cada agente DIA mapeia para uma cadencia humana nao-vazia e
// localizada em ambos os locales (prova de que o painel pode rotular todos).
test('cadenceForAgent: todo agente DIA tem cadencia nao-vazia em pt-BR e en-US', () => {
  for (const key of DIA_AGENTS) {
    assert.ok(DIA_AGENT_CRONS[key], `cron de seed faltando para ${key}`)
    const pt = cadenceForAgent(key, 'pt-BR')
    const en = cadenceForAgent(key, 'en-US')
    assert.equal(typeof pt, 'string', `${key} deve ter cadencia pt-BR`)
    assert.equal(typeof en, 'string', `${key} deve ter cadencia en-US`)
    assert.notEqual(pt.trim(), '')
    assert.notEqual(en.trim(), '')
    assert.notEqual(pt, en, `${key}: pt-BR e en-US devem diferir (localizado)`)
  }
})

test('cadenceForAgent: agent_key desconhecido -> null', () => {
  assert.equal(cadenceForAgent('agente-inexistente', 'pt-BR'), null)
})

// ---------------------------------------------------------------------------
// AC1/AC2 — AgentsDashboard renderiza next_run_at (via formatDateTime) e a
//           cadencia (cadenceForAgent), ao lado do "last run".
// ---------------------------------------------------------------------------
test('AgentsDashboard: renderiza next_run_at via formatDateTime + cadenceForAgent', () => {
  const src = read(AGENTS_DASHBOARD)
  assert.match(
    src,
    /import\s+\{[^}]*cadenceForAgent[^}]*\}\s+from\s+['"]@\/portal\/lib\/cron['"]/,
    'deve importar cadenceForAgent de @/portal/lib/cron',
  )
  assert.match(src, /cadenceForAgent\(\s*a\.agent_key\s*,\s*locale\s*\)/, 'deve calcular cadenceForAgent(a.agent_key, locale)')
  assert.match(src, /formatDateTime\(\s*a\.next_run_at\s*\)/, 'deve formatar a.next_run_at com formatDateTime')
})

// AC1/AC6 — o rotulo "Proxima execucao" usa a chave de traducao, nunca crua.
test('AgentsDashboard: rotulo nextRun via t(), valor ao lado do lastRun', () => {
  const src = read(AGENTS_DASHBOARD)
  assert.match(src, /t\(\s*['"]nextRun['"]\s*\)/, "deve renderizar t('nextRun')")
  assert.match(src, /t\(\s*['"]lastRun['"]\s*\)/, "regressao: t('lastRun') permanece")
})

// AC4 — estado "sem execucao agendada": disabled OU sem next_run_at usa noSchedule.
test('AgentsDashboard: estado noSchedule quando disabled ou sem next_run_at', () => {
  const src = read(AGENTS_DASHBOARD)
  assert.match(src, /t\(\s*['"]noSchedule['"]\s*\)/, "deve renderizar t('noSchedule')")
  // O valor so e mostrado quando habilitado E ha next_run_at.
  assert.match(
    src,
    /a\.enabled\s*&&\s*a\.next_run_at/,
    'deve condicionar o valor a (a.enabled && a.next_run_at)',
  )
})

// ---------------------------------------------------------------------------
// AC6 — ambos os locales definem screens.agentsDashboard.nextRun e .noSchedule,
//       nao-vazios e diferentes da chave crua.
// ---------------------------------------------------------------------------
test('i18n: nextRun e noSchedule definidos em pt-BR e en-US (nao-vazios)', () => {
  for (const [locale, relPath] of [
    ['pt-BR', PT_BR],
    ['en-US', EN_US],
  ]) {
    const dash = readJson(relPath).screens?.agentsDashboard
    assert.ok(dash, `${locale} deve definir screens.agentsDashboard`)
    for (const key of ['nextRun', 'noSchedule']) {
      assert.equal(typeof dash[key], 'string', `${locale} deve definir ${key}`)
      assert.notEqual(dash[key].trim(), '', `${locale} ${key} nao pode ser vazio`)
      assert.notEqual(dash[key], key, `${locale} ${key} nao pode ser a chave crua`)
    }
  }
})

// AC6 — os textos sao de fato localizados (pt-BR != en-US) e batem com a spec.
test('i18n: textos localizados batem com a spec (Proxima execucao / Sem execucao agendada)', () => {
  const pt = readJson(PT_BR).screens.agentsDashboard
  const en = readJson(EN_US).screens.agentsDashboard
  assert.equal(pt.nextRun, 'Próxima execução')
  assert.equal(pt.noSchedule, 'Sem execução agendada')
  assert.equal(en.nextRun, 'Next run')
  assert.equal(en.noSchedule, 'No scheduled run')
  assert.notEqual(pt.nextRun, en.nextRun)
  assert.notEqual(pt.noSchedule, en.noSchedule)
})
