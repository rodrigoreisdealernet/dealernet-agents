// Verificacao dependency-free do alinhamento da versao de Node no CI
// (issue #109 — `node: bad option: --experimental-strip-types`). Asserta sobre
// o TEXTO-FONTE de `.github/workflows/ci.yml` e do `package.json`; nao precisa
// de node_modules.
//
// Roda com: node --test scripts/verify-ci-node-version.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/109-ci-frontend-portal-tests-falha.md) que verifica.

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

// Versao minima exigida por `node --test --experimental-strip-types`.
const MIN_MAJOR = 22
const MIN_MINOR = 6

// Extrai o bloco do job `frontend:` do ci.yml (ate o proximo job no mesmo nivel
// de indentacao de 2 espacos, ou o fim do arquivo).
function frontendJobBlock(yml) {
  const lines = yml.split('\n')
  const start = lines.findIndex((l) => /^  frontend:\s*$/.test(l))
  assert.ok(start !== -1, 'job `frontend:` nao encontrado em ci.yml')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

test('AC2: job frontend do CI fixa Node >= 22.6 (suporta --experimental-strip-types)', () => {
  const yml = read('../.github/workflows/ci.yml')
  const block = frontendJobBlock(yml)
  const m = block.match(/node-version:\s*'?(\d+)(?:\.(\d+))?/)
  assert.ok(m, 'node-version nao declarado no job frontend')
  const major = Number(m[1])
  const minor = m[2] === undefined ? Infinity : Number(m[2])
  const ok = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)
  assert.ok(
    ok,
    `node-version do job frontend (${m[0]}) deve ser >= ${MIN_MAJOR}.${MIN_MINOR}; ` +
      'Node 20 quebra `--experimental-strip-types` (issue #109)',
  )
})

test('AC1: script `test` invoca node --test (sem regressao para um runner diferente)', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.scripts && typeof pkg.scripts.test === 'string', 'scripts.test ausente')
  assert.match(pkg.scripts.test, /node --test\b/, 'scripts.test deve usar `node --test`')
})

test('AC3: flag --experimental-strip-types preservada (verify-kpi-format.mjs importa format.ts)', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(
    pkg.scripts.test,
    /--experimental-strip-types/,
    'a flag e necessaria: verify-kpi-format.mjs importa format.ts e exige type-stripping',
  )
  const kpi = read('scripts/verify-kpi-format.mjs')
  assert.match(
    kpi,
    /from\s+['"][^'"]*format\.ts['"]/,
    'verify-kpi-format.mjs deve importar format.ts (justifica o type-stripping)',
  )
})
