// Verificacao dependency-free da paridade i18n pt-BR/en-US — Issue #58.
//
// Ambiente OFFLINE sem runner instalavel: usa apenas node:test/node:assert e
// le os JSONs de mensagens para garantir que as duas locales mantem a mesma
// estrutura de chaves e nenhum texto vazio.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const MESSAGE_FILES = {
  'pt-BR': 'src/i18n/messages/pt-BR.json',
  'en-US': 'src/i18n/messages/en-US.json',
}

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

function parseMessages(locale) {
  const relPath = MESSAGE_FILES[locale]
  let parsed
  assert.doesNotThrow(() => {
    parsed = JSON.parse(read(relPath))
  }, `${relPath} deve ser JSON valido`)
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${relPath} deve conter um objeto JSON`)
  return parsed
}

function flattenLeaves(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) {
      flattenLeaves(value[key], prefix ? `${prefix}.${key}` : key, out)
    }
    return out
  }
  out.push(prefix)
  return out
}

function collectEmptyStrings(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectEmptyStrings(child, prefix ? `${prefix}.${key}` : key, out)
    }
    return out
  }
  if (typeof value === 'string' && value.trim() === '') out.push(prefix)
  return out
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter((key) => !rightSet.has(key))
}

test('AC5: pt-BR.json e en-US.json sao JSONs validos de objeto', () => {
  for (const locale of Object.keys(MESSAGE_FILES)) {
    parseMessages(locale)
  }
})

test('AC5: pt-BR e en-US tem estruturas de chaves identicas', () => {
  const ptKeys = flattenLeaves(parseMessages('pt-BR')).sort()
  const enKeys = flattenLeaves(parseMessages('en-US')).sort()

  const missingInEn = difference(ptKeys, enKeys)
  const extraInEn = difference(enKeys, ptKeys)

  assert.deepEqual(missingInEn, [], `chaves presentes em pt-BR e ausentes em en-US: ${missingInEn.join(', ')}`)
  assert.deepEqual(extraInEn, [], `chaves presentes em en-US e ausentes em pt-BR: ${extraInEn.join(', ')}`)
})

test('AC5: arquivos de mensagens nao contem valores string vazios', () => {
  for (const locale of Object.keys(MESSAGE_FILES)) {
    const emptyKeys = collectEmptyStrings(parseMessages(locale)).sort()
    assert.deepEqual(emptyKeys, [], `${locale} contem strings vazias nas chaves: ${emptyKeys.join(', ')}`)
  }
})
