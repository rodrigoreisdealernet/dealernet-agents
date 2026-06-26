// Verificacao dependency-free do fluxo de decisao do Morning Brief (Resumo Matinal):
// ao Confirmar (approve) ou Dispensar (dismiss) uma acao preparada pelo DIA, o item
// tratado deve SAIR da fila ("DIA preparou estas acoes"), nao continuar listado.
//
// Bug original: Confirmar apenas marcava o card como verde e o mantinha na lista
// para sempre (so Dispensar ocultava localmente) — o usuario percebia "nada e
// executado, continua na fila matinal". Backend ja persiste/executa corretamente;
// a correcao e remover o finding da fila apos a decisao ter sucesso.
//
// Roda com: node --test scripts/verify-morning-brief-decision.mjs
// Asserta sobre o TEXTO-FONTE; nao precisa de node_modules.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = readFileSync(
  resolve(ROOT, 'src/portal/renderers/screens/MorningBrief.tsx'),
  'utf8',
)

// Recorta o corpo de uma funcao/callback nomeada para asserts focados.
function sliceFrom(marker, length = 600) {
  const i = SRC.indexOf(marker)
  assert.ok(i >= 0, `marcador nao encontrado: ${marker}`)
  return SRC.slice(i, i + length)
}

test('existe um helper removeFinding que remove o finding da lista (setFindings filter)', () => {
  const body = sliceFrom('const removeFinding =')
  assert.match(body, /setFindings\(\(list\)\s*=>\s*list\.filter\(/)
  // tambem limpa o estado de UI do item removido
  assert.match(body, /setFindingStates/)
})

test('Confirmar (approve) com sucesso remove o item da fila apos o decideFinding', () => {
  const body = sliceFrom('const onConfirm =')
  assert.match(body, /decision:\s*'approve'/)
  // a remocao acontece DEPOIS do await (no caminho de sucesso), nao no catch
  const awaitIdx = body.indexOf('await decideFinding')
  const removeIdx = body.indexOf('removeFinding(f.id)')
  const catchIdx = body.indexOf('catch')
  assert.ok(awaitIdx >= 0, 'onConfirm deve aguardar decideFinding')
  assert.ok(removeIdx > awaitIdx, 'onConfirm deve remover o finding apos o await')
  assert.ok(removeIdx < catchIdx, 'a remocao deve estar no caminho de sucesso, antes do catch')
})

test('Dispensar (dismiss) com sucesso remove o item da fila apos o decideFinding', () => {
  const body = sliceFrom('const onDismiss =')
  assert.match(body, /decision:\s*'dismiss'/)
  const awaitIdx = body.indexOf('await decideFinding')
  const removeIdx = body.indexOf('removeFinding(f.id)')
  const catchIdx = body.indexOf('catch')
  assert.ok(removeIdx > awaitIdx, 'onDismiss deve remover o finding apos o await')
  assert.ok(removeIdx < catchIdx, 'a remocao deve estar no caminho de sucesso, antes do catch')
})

test('falha na decisao ainda reverte o estado otimista para pending', () => {
  const confirm = sliceFrom('const onConfirm =')
  const dismiss = sliceFrom('const onDismiss =')
  assert.match(confirm, /\[f\.id\]:\s*'pending'/)
  assert.match(dismiss, /\[f\.id\]:\s*'pending'/)
})
