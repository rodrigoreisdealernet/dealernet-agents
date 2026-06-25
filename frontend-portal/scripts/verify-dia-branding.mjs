// Verificacao dependency-free do rebrand DIA (Issue #1).
//
// Ambiente OFFLINE sem runner de teste instalavel: usamos apenas os modulos
// nativos do Node (node:test, node:assert, node:fs) para assertar os criterios
// de aceite lendo os arquivos-fonte. Roda com: node --test scripts/verify-dia-branding.mjs
//
// Cada teste traz no nome o criterio de aceite (spec docs/specs/1-portal-dia-image.md)
// que verifica.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const BRAND = 'DIA — Dealernet Intelligence Agents'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

test('AC1: index.html tem o <title> com a marca DIA', () => {
  const html = read('index.html')
  assert.match(
    html,
    new RegExp(`<title>\\s*Portal ${escapeRe(BRAND)}\\s*</title>`),
    'index.html deve conter <title>Portal DIA — Dealernet Intelligence Agents</title>',
  )
})

test('AC2: TopBar.tsx renderiza config?.portalName com fallback da marca DIA', () => {
  const topbar = read('src/portal/components/TopBar.tsx')
  // Casa a expressao completa: {config?.portalName ?? 'DIA — Dealernet Intelligence Agents'}
  // Exige portalName E o fallback DIA juntos no mesmo nullish-coalescing,
  // pegando regressao tanto na fonte do nome quanto no texto de fallback.
  assert.match(
    topbar,
    new RegExp(`config\\?\\.portalName\\s*\\?\\?\\s*['"]${escapeRe(BRAND)}['"]`),
    "TopBar.tsx deve renderizar {config?.portalName ?? 'DIA — Dealernet Intelligence Agents'}",
  )
})

test('AC3: Sidebar.tsx exibe o badge "DIA" na sidebar recolhida', () => {
  const sidebar = read('src/portal/components/Sidebar.tsx')
  // O badge recolhido renderiza o texto "DIA" dentro de um <span>, e SO no
  // estado recolhido (ramo `collapsed ?` do ternario). Ancorar no `collapsed ?`
  // (com .*? em modo dotall) liga a assercao ao contexto do badge recolhido,
  // evitando casar com qualquer "DIA" solto no arquivo.
  assert.match(
    sidebar,
    /collapsed \?[\s\S]*?>\s*DIA\s*</,
    'Sidebar.tsx deve renderizar o texto "DIA" como badge da sidebar recolhida (ramo collapsed)',
  )
})

test('AC5: Sidebar.tsx referencia o novo asset /dia-logo.svg', () => {
  const sidebar = read('src/portal/components/Sidebar.tsx')
  assert.ok(
    sidebar.includes('/dia-logo.svg'),
    'Sidebar.tsx deve referenciar /dia-logo.svg nos pontos de logo',
  )
})

test('AC6: Sidebar.tsx nao referencia mais o logo antigo DMS', () => {
  const sidebar = read('src/portal/components/Sidebar.tsx')
  assert.ok(
    !sidebar.includes('/DMS_DealernetMultiSolutions.png'),
    'Sidebar.tsx nao deve mais referenciar /DMS_DealernetMultiSolutions.png',
  )
  assert.ok(
    !/>\s*DMS\s*</.test(sidebar),
    'Sidebar.tsx nao deve mais renderizar o badge de texto "DMS"',
  )
})

test('AC4: portalApi.ts (mock) tem o default portalName com a marca DIA', () => {
  const api = read('src/portal/lib/portalApi.ts')
  assert.match(
    api,
    new RegExp(`portalName:\\s*['"]${escapeRe(BRAND)}['"]`),
    'portalApi.ts deve ter portalName default = DIA — Dealernet Intelligence Agents',
  )
})

test('AC4: portalApiReal.ts (API real) tem o fallback portalName com a marca DIA', () => {
  const api = read('src/portal/lib/portalApiReal.ts')
  assert.ok(
    api.includes(BRAND),
    'portalApiReal.ts deve ter fallback portalName = DIA — Dealernet Intelligence Agents',
  )
})

test('AC5: public/dia-logo.svg existe, e SVG valido e contem a marca DIA', () => {
  const svg = read('public/dia-logo.svg')
  const trimmed = svg.trimStart()
  assert.ok(
    trimmed.startsWith('<svg') || trimmed.startsWith('<?xml'),
    'dia-logo.svg deve comecar com <svg ou <?xml (SVG valido)',
  )
  assert.ok(trimmed.includes('</svg>'), 'dia-logo.svg deve ter a tag de fechamento </svg>')
  assert.ok(svg.includes('DIA'), 'dia-logo.svg deve conter o texto "DIA"')
  assert.ok(
    svg.includes('Dealernet Intelligence Agents'),
    'dia-logo.svg deve conter o texto "Dealernet Intelligence Agents"',
  )
})

test('Non-Goal: Login.tsx AINDA usa a marca corporativa Dealernet_Logo35anos.png', () => {
  const login = read('src/portal/components/Login.tsx')
  assert.ok(
    login.includes('Dealernet_Logo35anos.png'),
    'Login.tsx deve preservar /Dealernet_Logo35anos.png (Non-Goal: marca corporativa nao muda)',
  )
})

// Escapa caracteres especiais de regex de um literal (incluindo o em-dash, ok,
// mas — e literal; cobrimos os metacaracteres por seguranca).
function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
