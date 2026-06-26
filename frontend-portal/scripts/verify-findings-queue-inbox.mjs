// Verificacao dependency-free do inbox de triagem da Fila Matinal (issue #96).
//
// Ambiente OFFLINE sem runner instalavel (sem vitest/jsdom): usamos apenas
// modulos nativos do Node, lendo os arquivos-fonte e assertando contra o wiring
// que materializa os criterios de aceite da spec.
//
// Roda com: node --test scripts/verify-findings-queue-inbox.mjs

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

function readJson(relPath) {
  return JSON.parse(read(relPath))
}

function functionBody(src, signature) {
  const start = src.indexOf(signature)
  assert.ok(start !== -1, `assinatura nao encontrada: ${signature}`)
  const open = src.indexOf('{', start)
  assert.ok(open !== -1, `corpo nao encontrado para: ${signature}`)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    if (src[i] === '}') depth -= 1
    if (depth === 0) return src.slice(open, i + 1)
  }
  assert.fail(`fim do corpo nao encontrado para: ${signature}`)
}

const FINDINGS_QUEUE = 'src/portal/renderers/screens/FindingsQueue.tsx'
const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'

// ---------------------------------------------------------------------------
// AC1: a fila abre priorizada por severidade (critical -> low) e, no empate,
//      por Δ R$ decrescente; o api.list ordena antes de devolver a DataTable.
// ---------------------------------------------------------------------------
test('AC1 priorizacao: sortFindings usa severityRank critical->low e delta desc antes de mapear linhas', () => {
  const src = read(FINDINGS_QUEUE)

  const severityRank = functionBody(src, 'function severityRank')
  for (const [severity, rank] of [
    ['critical', 0],
    ['high', 1],
    ['medium', 2],
    ['low', 3],
  ]) {
    assert.match(severityRank, new RegExp(`${severity}:\\s*${rank}`), `severityRank deve mapear ${severity}:${rank}`)
  }
  assert.ok(
    severityRank.indexOf('critical') < severityRank.indexOf('high') &&
      severityRank.indexOf('high') < severityRank.indexOf('medium') &&
      severityRank.indexOf('medium') < severityRank.indexOf('low'),
    'severityRank deve manter a ordem critical -> high -> medium -> low',
  )
  assert.match(severityRank, /ranks\[severityKey\(value\)\]\s*\?\?\s*4/, 'severidade desconhecida deve ficar apos low')

  const sortFindings = functionBody(src, 'function sortFindings')
  assert.match(
    sortFindings,
    /severityRank\(a\.severity\)\s*-\s*severityRank\(b\.severity\)/,
    'sortFindings deve comparar severidade crescente pelo rank',
  )
  assert.match(
    sortFindings,
    /\(b\.delta\s*\?\?\s*0\)\s*-\s*\(a\.delta\s*\?\?\s*0\)/,
    'sortFindings deve desempatar por delta decrescente',
  )

  const listStart = src.indexOf('async list()')
  assert.ok(listStart !== -1, 'api.list deve existir')
  const listBody = src.slice(listStart, src.indexOf('return {', src.indexOf('data: filtered.map', listStart)))
  assert.match(listBody, /const\s+rows\s*=\s*await\s+getFindings\(\s*\{\s*agentKey,\s*limit:\s*1000\s*\}\s*\)/, 'api.list deve buscar findings sem status hard-coded')
  assert.match(listBody, /\.filter\([\s\S]*?\)\s*\.sort\(sortFindings\)/, 'api.list deve filtrar e ordenar com sortFindings antes de retornar')
})

// ---------------------------------------------------------------------------
// AC2: filtro de status na toolbar, em client-side, sem prender a API em
//      pending_approval; troca de status recarrega a DataTable sem reabrir tela.
// ---------------------------------------------------------------------------
test('AC2 filtro: status select oferece todos os estados e getFindings nao fica hard-coded em pending_approval', () => {
  const src = read(FINDINGS_QUEUE)

  assert.match(
    src,
    /type\s+StatusFilter\s*=\s*'all'\s*\|\s*'pending_approval'\s*\|\s*'approved'\s*\|\s*'rejected'\s*\|\s*'informational'/,
    'StatusFilter deve cobrir all/pending/approved/rejected/informational',
  )
  assert.match(src, /const\s+\[statusFilter,\s*setStatusFilter\]\s*=\s*useState<StatusFilter>/, 'deve manter statusFilter em estado React')
  const statusOptionsBlock = src.slice(src.indexOf('const statusOptions'), src.indexOf('const colunas'))
  const statusOptionValues = [...statusOptionsBlock.matchAll(/value:\s*'([^']+)'\s+as\s+const/g)].map(([, value]) => value)
  assert.deepEqual(
    statusOptionValues,
    ['all', 'pending_approval', 'approved', 'rejected', 'informational'],
    'statusOptions deve oferecer exatamente all + os 4 status esperados',
  )
  assert.equal(statusOptionValues.length, 5, 'statusOptions deve ter exatamente 5 opcoes')
  for (const value of ['all', 'pending_approval', 'approved', 'rejected', 'informational']) {
    assert.match(src, new RegExp(`value:\\s*'${value}'`), `statusOptions deve oferecer ${value}`)
  }
  assert.match(src, /<select\s+[\s\S]*?value=\{statusFilter\}[\s\S]*?onChange=\{\(e\)\s*=>\s*setStatusFilter\(e\.target\.value\s+as\s+StatusFilter\)\}/, 'toolbar deve renderizar select controlado por statusFilter')
  assert.match(
    src,
    /\.filter\(\(f\)\s*=>\s*statusFilter\s*===\s*'all'\s*\|\|\s*statusKey\(f\.status\)\s*===\s*statusFilter\)/,
    'deve aplicar filtro client-side usando statusKey(f.status)',
  )
  assert.match(src, /STATUS_RELOAD_OFFSET\[statusFilter\]/, 'mudanca de status deve alterar reloadKey efetivo da tabela')

  const getFindingsCalls = [...src.matchAll(/getFindings\(\s*\{([\s\S]*?)\}\s*\)/g)]
  assert.ok(getFindingsCalls.length >= 1, 'FindingsQueue deve chamar getFindings')
  for (const [, args] of getFindingsCalls) {
    assert.doesNotMatch(args, /status\s*:\s*['"]pending_approval['"]/, 'getFindings nao deve receber status pending_approval hard-coded')
  }
})

// ---------------------------------------------------------------------------
// AC3: selecao por linha e acoes em lote com ConfirmDialog, motivo obrigatorio
//      para rejeicao e feedback por item via Promise.allSettled.
// ---------------------------------------------------------------------------
test('AC3 lote: checkboxes por linha, botoes gated por selecao e ConfirmDialog com reject reason', () => {
  const src = read(FINDINGS_QUEUE)

  assert.match(src, /import\s+ConfirmDialog\s+from\s+['"]@\/portal\/components\/ui\/ConfirmDialog['"]/, 'deve reutilizar ConfirmDialog')
  assert.match(src, /decideFinding,\s*getFindings,\s*type\s+FindingRow/, 'deve importar decideFinding para processar cada item')
  assert.match(src, /const\s+\[selectedItems,\s*setSelectedItems\]\s*=\s*useState<Map<string,\s*FindingRowVM>>\(\(\)\s*=>\s*new\s+Map\(\)\)/, 'selecao deve ser Map em estado')
  assert.match(src, /const\s+selectedRows\s*=\s*useMemo\(\(\)\s*=>\s*Array\.from\(selectedItems\.values\(\)\)/, 'selectedRows deve derivar da selecao atual')
  assert.match(src, /const\s+toggleSelected\s*=\s*useCallback/, 'deve existir toggleSelected estavel')

  const renderAcoes = src.slice(src.indexOf('const renderAcoes'), src.indexOf('// Polling'))
  assert.match(renderAcoes, /<input\s+[\s\S]*?type="checkbox"/, 'renderAcoes deve renderizar checkbox por linha')
  assert.match(renderAcoes, /checked=\{selected\}/, 'checkbox deve refletir selectedItems.has(f.id)')
  assert.match(renderAcoes, /onChange=\{\(e\)\s*=>\s*toggleSelected\(f,\s*e\.target\.checked\)\}/, 'checkbox deve atualizar selectedItems')
  assert.match(renderAcoes, /aria-label=\{t\('selectFinding'\)\.replace\('\{label\}',\s*rowLabel\(f\)\)\}/, 'checkbox deve ter label i18n por finding')
  assert.match(renderAcoes, /disabled=\{disabled\}/, 'checkbox deve respeitar estado disabled por processamento/status')

  for (const mode of ['approve', 'reject']) {
    assert.match(src, new RegExp(`onClick=\\{\\(\\) => openBatchDialog\\('${mode}'\\)\\}`), `botao bulk ${mode} deve abrir dialogo`)
  }
  assert.match(src, /disabled=\{selectedCount\s*===\s*0\s*\|\|\s*processing\}/, 'botoes bulk devem ser desabilitados sem selecao ou em processamento')
  assert.match(src, /<ConfirmDialog[\s\S]*?open=\{batchMode\s*!==\s*null\}/, 'ConfirmDialog deve abrir para acoes em lote')

  const confirmBatch = functionBody(src, 'async function confirmBatch')
  assert.match(confirmBatch, /if\s*\(mode\s*===\s*'reject'\s*&&\s*!text\)\s*\{[\s\S]*?setDialogErr\(detailT\('rejectReasonRequired'\)\)/, 'rejeicao em lote deve exigir motivo')
  assert.match(confirmBatch, /Promise\.allSettled\(\s*items\.map\(\(item\)\s*=>\s*decideFinding\(/, 'deve processar itens com Promise.allSettled + decideFinding')
  assert.match(confirmBatch, /decision:\s*mode/, 'decideFinding deve receber approve/reject do modo em lote')
  assert.match(confirmBatch, /reason:\s*mode\s*===\s*'reject'\s*\?\s*text\s*:\s*undefined/, 'motivo deve ser enviado apenas na rejeicao')
  assert.match(confirmBatch, /setBatchResults\(results\)/, 'deve registrar feedback por item')
  assert.match(confirmBatch, /successes\.forEach\(\(id\)\s*=>\s*next\.delete\(id\)\)/, 'deve remover da selecao apenas sucessos processados')
})

// ---------------------------------------------------------------------------
// AC1/AC4: evidencia inline por linha — badge de severidade, Δ R$ formatado e
//          confianca formatada, mantendo tipo/cliente e botao Revisar.
// ---------------------------------------------------------------------------
test('AC4 evidencia inline: severidade em badge, delta formatBRL, confianca formatPct e Revisar preservado', () => {
  const src = read(FINDINGS_QUEUE)

  assert.match(src, /import\s+\{\s*formatBRL,\s*formatPct\s*\}\s+from\s+['"]\.\/format['"]/, 'deve importar formatBRL/formatPct')
  const colunas = src.slice(src.indexOf('const colunas'), src.indexOf('const selectedRows'))
  assert.match(colunas, /key:\s*'severidade'[\s\S]*?tipo:\s*'badge'[\s\S]*?enumOptions:\s*\[/, 'severidade deve ser badge com enumOptions')
  for (const value of ['critical', 'high', 'medium', 'low']) {
    assert.match(colunas, new RegExp(`\\{ value:\\s*'${value}',\\s*label:`), `badge de severidade deve mapear ${value}`)
  }
  assert.match(colunas, /key:\s*'delta',\s*label:\s*t\('delta'\),\s*tipo:\s*'texto'/, 'delta deve ser coluna legivel de texto')
  assert.match(colunas, /key:\s*'confianca',\s*label:\s*t\('confidence'\),\s*tipo:\s*'texto'/, 'confianca deve ser coluna legivel de texto')
  assert.match(colunas, /key:\s*'tipo'/, 'tipo/finding deve continuar em coluna inline')
  assert.match(colunas, /key:\s*'cliente'/, 'cliente/contrato deve continuar em coluna inline')

  const mapper = src.slice(src.indexOf('data: filtered.map'), src.indexOf('}))', src.indexOf('data: filtered.map')) + 3)
  assert.match(mapper, /severidade:\s*severityKey\(f\.severity\)/, 'linha deve normalizar severidade')
  assert.match(mapper, /delta:\s*formatBRL\(f\.delta\)/, 'linha deve formatar Δ R$ com formatBRL')
  assert.match(mapper, /confianca:\s*formatPct\(f\.confidence\)/, 'linha deve formatar confianca com formatPct')
  assert.match(src, /componentKey:\s*'finding-detail'/, 'botao Revisar deve continuar abrindo finding-detail')
  assert.match(src, /\{t\('review'\)\}/, 'botao Revisar deve manter label i18n review')
})

// ---------------------------------------------------------------------------
// AC5: polling a cada 10s recarrega a DataTable sem resetar selecao; estados
//      loading/error/empty ficam a cargo da DataTable corporativa.
// ---------------------------------------------------------------------------
test('AC5 polling/estados: 10s interval, cleanup e selecao preservada', () => {
  const src = read(FINDINGS_QUEUE)
  const pollingStart = src.indexOf('// Polling')
  assert.ok(pollingStart !== -1, 'deve haver bloco documentado de polling')
  const pollingBody = src.slice(pollingStart, src.indexOf('const api', pollingStart))

  assert.match(
    pollingBody,
    /window\.setInterval\(\s*\(\)\s*=>\s*setReloadKey\(\(k\)\s*=>\s*k\s*\+\s*1\),\s*10000\s*\)/,
    'polling deve usar window.setInterval para incrementar reloadKey a cada 10s',
  )
  assert.match(
    pollingBody,
    /return\s+\(\)\s*=>\s*window\.clearInterval\(t\)/,
    'polling deve limpar o interval no cleanup do useEffect',
  )
  assert.doesNotMatch(pollingBody, /setSelectedItems/, 'polling nao pode resetar selectedItems')
  assert.match(src, /const\s+\[selectedItems,\s*setSelectedItems\]/, 'selectedItems deve existir separado de reloadKey')
  assert.match(src, /const\s+\[reloadKey,\s*setReloadKey\]/, 'reloadKey deve existir separado de selectedItems')
  assert.match(src, /<DataTable<FindingRowVM>/, 'loading/empty/error states devem ser delegados a DataTable corporativa')
})

// ---------------------------------------------------------------------------
// AC2/AC3: novas chaves i18n usadas na toolbar/checkbox existem nos dois
//          locales, junto dos labels de status exibidos no filtro.
// ---------------------------------------------------------------------------
test('AC2/AC3 i18n: keys do inbox existem em pt-BR e en-US', () => {
  for (const [locale, relPath] of [
    ['pt-BR', PT_BR],
    ['en-US', EN_US],
  ]) {
    const messages = readJson(relPath)
    const q = messages.screens?.findingsQueue
    assert.ok(q, `${locale} deve definir screens.findingsQueue`)

    for (const key of [
      'selectFinding',
      'selectedCount',
      'pending',
      'approved',
      'rejected',
      'informational',
      'severity',
      'delta',
      'confidence',
    ]) {
      assert.equal(typeof q[key], 'string', `${locale} deve definir findingsQueue.${key}`)
      assert.notEqual(q[key].trim(), '', `${locale} findingsQueue.${key} nao pode ser vazio`)
    }
    assert.match(q.selectFinding, /\{label\}/, `${locale} selectFinding deve aceitar placeholder {label}`)
    assert.match(q.selectedCount, /\{count\}/, `${locale} selectedCount deve aceitar placeholder {count}`)
  }
})
