// Verificacao dependency-free do dimensionamento da logo no login (Issue #65).
//
// Ambiente OFFLINE sem runner de teste instalavel: usamos apenas os modulos
// nativos do Node (node:test, node:assert, node:fs) para assertar os criterios
// de aceite lendo o arquivo-fonte. Roda com: node --test scripts/verify-login-logo.mjs
//
// Cada teste traz no nome o criterio de aceite (spec docs/specs/65-portal-logo-do-login-subdimensionada.md)
// que verifica.

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

const LOGIN = read('src/portal/components/Login.tsx')

// Isola o bloco da capsula da logo (a <motion.div> que envolve a <img> da logo)
// para que as assertivas de classe nao sejam satisfeitas por outro elemento.
function logoBlock() {
  const imgIdx = LOGIN.indexOf('/Dealernet_Logo35anos.png')
  assert.ok(imgIdx !== -1, 'a tag <img> da logo do login deve existir em Login.tsx')
  // pega da motion.div mais proxima antes da img ate o fechamento da img
  const start = LOGIN.lastIndexOf('<motion.div', imgIdx)
  const end = LOGIN.indexOf('/>', imgIdx)
  assert.ok(start !== -1 && end !== -1, 'bloco da capsula da logo nao localizado')
  return LOGIN.slice(start, end + 2)
}

const BLOCK = logoBlock()

test('AC1: a capsula da logo usa padding minimo (nao px-5 py-3) para a marca dominar', () => {
  assert.doesNotMatch(
    BLOCK,
    /px-5\s+py-3/,
    'a capsula nao deve mais usar o padding largo px-5 py-3 que faz o fundo branco dominar',
  )
  assert.match(
    BLOCK,
    /\bp-(0|0\.5|1|1\.5|2)\b/,
    'a capsula deve usar um padding minimo (p-0..p-2) para deixar a logo ocupar a area',
  )
})

test('AC1/AC2: a logo cresce em relacao ao h-14 original mantendo w-auto', () => {
  assert.doesNotMatch(BLOCK, /\bh-14\b/, 'a logo nao deve mais usar a altura pequena h-14')
  assert.match(
    BLOCK,
    /\bh-(1[6-9]|2[0-9]|3[0-9])\b/,
    'a logo deve usar uma altura maior (>= h-16) para ganhar destaque',
  )
  assert.match(BLOCK, /\bw-auto\b/, 'a logo deve manter w-auto para preservar o aspect ratio')
})

test('AC3: a logo permanece responsiva (max-w-full evita estouro em telas pequenas)', () => {
  assert.match(
    BLOCK,
    /\bmax-w-full\b/,
    'a logo deve usar max-w-full para nao estourar o card em larguras pequenas',
  )
})

test('AC2: a logo nao força largura fixa numerica (sem w-<num>, evita distorcao)', () => {
  // w-auto + max-w-full garantem proporcao; uma largura fixa numerica (ex. w-44)
  // combinada com a altura fixa distorceria a imagem.
  assert.doesNotMatch(
    BLOCK,
    /\bw-\d/,
    'a logo nao deve usar largura fixa numerica (ex. w-44); use w-auto/max-w-full',
  )
})

test('AC4: a capsula mantem fundo branco (bg-white) para contraste em ambos os temas', () => {
  assert.match(
    BLOCK,
    /\bbg-white\b/,
    'a capsula deve manter bg-white para a logo ficar legivel no tema claro e escuro',
  )
})

test('AC6: o asset PNG da logo nao foi trocado (sem rebranding)', () => {
  assert.match(
    BLOCK,
    /src="\/Dealernet_Logo35anos\.png"/,
    'o arquivo da logo deve continuar sendo Dealernet_Logo35anos.png',
  )
})

test('AC5: a animacao de entrada da logo (motion spring) continua presente', () => {
  assert.match(BLOCK, /<motion\.div/, 'a logo deve continuar envolvida por motion.div (animacao)')
  assert.match(BLOCK, /scale:\s*0\.9/, 'a animacao de entrada (scale spring) da logo deve ser preservada')
  assert.match(
    BLOCK,
    /type:\s*'spring'/,
    'a transicao da logo deve continuar usando type: spring (nao linear/sem animacao)',
  )
})
