// Verificação de ESTRUTURA + LINKS do CLAUDE.md da raiz (issue #42).
//
// Mudança documentation-only: não há código de produto para testar, então
// não há harness pytest/psql aqui. Em vez de um teste-vaidade, este script
// afirma exatamente o que a spec (docs/specs/42-docs-criar-claude-md-na.md)
// exige do CLAUDE.md e — a asserção de maior valor — que TODO link markdown
// relativo aponta para um caminho que existe em disco (pega links mortos
// quando o repo se move).
//
// COMO RODAR (da raiz do worktree):
//   node --test scripts/check-claude-md.mjs
//
// Sem dependências novas: apenas node:test + node:assert + node:fs, no mesmo
// estilo de supabase/tests/*.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

// scripts/check-claude-md.mjs -> raiz do repo é o diretório pai de scripts/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md')

function readClaudeMd() {
  return readFileSync(CLAUDE_MD, 'utf8')
}

test('AC1: CLAUDE.md existe na raiz e não está vazio', () => {
  assert.ok(existsSync(CLAUDE_MD), 'CLAUDE.md não encontrado na raiz do repo')
  const text = readClaudeMd()
  assert.ok(
    text.trim().length > 200,
    `CLAUDE.md está vazio ou muito curto (${text.trim().length} chars)`,
  )
})

test('AC2,4,5,7: contém os títulos de seção exigidos pela spec', () => {
  const text = readClaudeMd()
  const requiredSections = [
    'Comece por aqui', // "Read First" / onboarding
    'Mapa do repositório', // tabela caminho -> o que tem
    'Como entregar uma mudança', // workflow de entrega
  ]
  for (const heading of requiredSections) {
    assert.ok(
      text.includes(heading),
      `seção obrigatória ausente: "${heading}"`,
    )
  }
  // Seção de validação: a spec aceita "Validação" ou "checks".
  assert.ok(
    /Valida[çc][ãa]o/i.test(text) || /checks/i.test(text),
    'seção de validação ausente (esperado "Validação" ou "checks")',
  )
})

test('AC5: cita /ship-issue e /ship-batch e referencia seus arquivos em .claude/commands/', () => {
  const text = readClaudeMd()
  assert.ok(text.includes('/ship-issue'), 'comando /ship-issue não citado')
  assert.ok(text.includes('/ship-batch'), 'comando /ship-batch não citado')
  assert.ok(
    text.includes('.claude/commands/ship-issue.md'),
    'referência a .claude/commands/ship-issue.md ausente',
  )
  assert.ok(
    text.includes('.claude/commands/ship-batch.md'),
    'referência a .claude/commands/ship-batch.md ausente',
  )
})

test('AC6: lista os três comandos de validação reais (frontend, temporal, supabase)', () => {
  const text = readClaudeMd()
  const requiredCommands = [
    'npm run lint',
    'pytest temporal/tests',
    'node --test --test-concurrency=1 supabase/tests',
  ]
  for (const cmd of requiredCommands) {
    assert.ok(text.includes(cmd), `comando de validação ausente: "${cmd}"`)
  }
})

test('AC1 (integridade): todo link markdown relativo resolve para um caminho existente', () => {
  const text = readClaudeMd()
  // Captura os alvos de links markdown relativos: ](./...)
  const linkRe = /\]\((\.\/[^)\s]+)\)/g
  const targets = new Set()
  let m
  while ((m = linkRe.exec(text)) !== null) {
    // Descarta âncora/fragmento (#secao) ao testar existência em disco.
    targets.add(m[1].split('#')[0])
  }

  assert.ok(targets.size > 0, 'nenhum link relativo encontrado — regex quebrou?')

  const dead = []
  for (const target of targets) {
    const abs = resolve(REPO_ROOT, target)
    if (!existsSync(abs)) dead.push(target)
  }

  assert.deepEqual(
    dead,
    [],
    `link(s) markdown relativo(s) apontando para caminho inexistente: ${dead.join(', ')}`,
  )
})
