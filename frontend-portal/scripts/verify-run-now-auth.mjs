// Verifica a correção do "Run now" devolvendo HTTP 401 quando a sessão Supabase
// fica obsoleta (ex.: stack local recriada → novas chaves de assinatura JWT, token
// velho no localStorage). A correção tem duas partes assertadas sobre o código:
//   1) o boot de auth valida a sessão (hasValidSession/getUser), não só a existência;
//   2) runAgentNow reautentica e repete a chamada uma vez ao receber 401.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentsApi = readFileSync(join(root, 'src/portal/lib/agentsApi.ts'), 'utf8')
const useAuth = readFileSync(join(root, 'src/hooks/use-auth.tsx'), 'utf8')

test('agentsApi expõe validação de sessão e reautenticação', () => {
  assert.match(agentsApi, /export async function hasValidSession\b/)
  assert.match(agentsApi, /export async function reauthenticateDemo\b/)
  // hasValidSession deve fazer round-trip ao servidor (getUser), não só getSession.
  const fn = agentsApi.slice(agentsApi.indexOf('function hasValidSession'))
  assert.match(fn.slice(0, 400), /supabase\.auth\.getUser\(\)/)
})

test('runAgentNow reautentica e repete a chamada ao receber 401', () => {
  const start = agentsApi.indexOf('export async function runAgentNow')
  assert.ok(start >= 0, 'runAgentNow deve existir')
  const fn = agentsApi.slice(start, start + 900)
  assert.match(fn, /res\.status === 401/)
  assert.match(fn, /reauthenticateDemo\(\)/)
})

test('boot de auth valida a sessão (hasValidSession), não apenas a existência', () => {
  assert.match(useAuth, /hasValidSession/)
  assert.doesNotMatch(useAuth, /\bhasSession\b/)
})
