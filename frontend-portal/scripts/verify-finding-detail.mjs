// Verificacao dependency-free do Finding Detail — evidencia estruturada +
// historico de decisao (issue #97). Asserta sobre o TEXTO-FONTE de
// FindingDetail.tsx / agentsApi.ts / registry.ts e dos JSONs de i18n; nao
// precisa de node_modules nem de runtime do React.
//
// Roda com: node --test scripts/verify-finding-detail.mjs
//
// Cada teste traz no nome o criterio de aceite (spec
// docs/specs/97-finding-detail-evidencia-estruturada-historico.md) que cobre.

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

const FINDING_DETAIL = 'src/portal/renderers/screens/FindingDetail.tsx'
const AGENTS_API = 'src/portal/lib/agentsApi.ts'
const REGISTRY = 'src/portal/renderers/registry.ts'
const PT_BR = 'src/i18n/messages/pt-BR.json'
const EN_US = 'src/i18n/messages/en-US.json'

// ---------------------------------------------------------------------------
// AC1 — Evidencia estruturada e segura: cada item renderiza label + detalhe
//       key/value e NUNCA cai no padrao primitivo String(ev.label ?? ev.summary
//       ...), que produz [object Object] para payloads sem `label`.
// ---------------------------------------------------------------------------
test('AC1 evidencia: nao usa mais o padrao primitivo String(ev.label ?? ev.summary ...)', () => {
  const src = read(FINDING_DETAIL)
  // Regressao: o padrao antigo que gerava [object Object] foi removido.
  assert.doesNotMatch(
    src,
    /String\(\s*ev\.label\s*\?\?\s*ev\.summary/,
    'nao deve renderizar evidencia com String(ev.label ?? ev.summary ...)',
  )
  // Nenhum item de evidencia deve ser interpolado cru no JSX via {ev} ou {ev.<x>}
  // sem passar pelo helper de serializacao (o que poderia emitir [object Object]).
  assert.doesNotMatch(
    src,
    /\{\s*ev\s*\}/,
    'nao deve interpolar o objeto de evidencia cru no JSX (geraria [object Object])',
  )
})

test('AC1 evidencia: usa helper que serializa valores com seguranca (objeto -> JSON, nunca [object Object])', () => {
  const src = read(FINDING_DETAIL)
  // Helper de serializacao segura existe e cobre os tipos primitivos + objeto.
  assert.match(
    src,
    /function\s+formatEvidenceValue\s*\(/,
    'deve existir um helper formatEvidenceValue() para serializar valores com seguranca',
  )
  // Objetos sao serializados via JSON.stringify (e nao via String(), que daria [object Object]).
  assert.match(src, /JSON\.stringify\(/, 'objetos de evidencia devem ser serializados com JSON.stringify')
  // null/undefined viram um placeholder legivel, nao a string "null"/"undefined".
  assert.match(
    src,
    /v\s*===\s*null\s*\|\|\s*v\s*===\s*undefined/,
    'deve tratar null/undefined explicitamente antes de serializar',
  )
})

test('AC1 evidencia: renderiza rotulo principal + detalhe key/value (dt/dd)', () => {
  const src = read(FINDING_DETAIL)
  // Escolha do rotulo: ha uma lista de chaves preferenciais e um seletor.
  assert.match(src, /EVIDENCE_LABEL_KEYS\s*=/, 'deve definir EVIDENCE_LABEL_KEYS (ordem de preferencia do rotulo)')
  assert.match(src, /function\s+evidenceLabelKey\s*\(/, 'deve existir evidenceLabelKey() para escolher o rotulo')
  // Detalhe key/value: itera as demais entradas do payload (Object.entries) e
  // as renderiza em uma lista de definicao dt/dd.
  assert.match(src, /Object\.entries\(\s*ev\s*\)/, 'deve iterar as entradas do payload para o detalhe key/value')
  assert.match(src, /<dt\b/, 'deve renderizar a chave em <dt>')
  assert.match(src, /<dd\b/, 'deve renderizar o valor em <dd>')
})

test('AC1 evidencia: payload sem label cai num rotulo fallback "Evidence N" (renderiza significativo)', () => {
  const src = read(FINDING_DETAIL)
  // Quando nenhuma chave preferencial existe, o rotulo cai para `${t('evidence')} ${i + 1}`.
  assert.match(
    src,
    /labelKey\s*\?\s*formatEvidenceValue\(\s*ev\[labelKey\]\s*\)\s*:\s*`\$\{t\('evidence'\)\}\s*\$\{i\s*\+\s*1\}`/,
    'sem chave de rotulo, deve usar o fallback `${t("evidence")} ${i + 1}`',
  )
})

test('AC1 evidencia: tem estado vazio explicito quando nao ha evidencia', () => {
  const src = read(FINDING_DETAIL)
  // Render condicional: lista quando ha itens, mensagem de vazio (noEvidence) caso contrario.
  assert.match(
    src,
    /data\.evidence\s*&&\s*data\.evidence\.length\s*>\s*0/,
    'deve checar se ha evidencia antes de renderizar a lista',
  )
  assert.match(src, /t\('noEvidence'\)/, 'deve renderizar o estado vazio via t("noEvidence")')
  for (const [locale, relPath] of [['pt-BR', PT_BR], ['en-US', EN_US]]) {
    const fd = readJson(relPath).screens.findingDetail
    assert.equal(typeof fd.noEvidence, 'string', `${locale} deve definir screens.findingDetail.noEvidence`)
    assert.notEqual(fd.noEvidence.trim(), '', `${locale} noEvidence nao pode ser vazio`)
  }
})

// ---------------------------------------------------------------------------
// AC2 — Historico de decisao real: agentsApi expoe decided_at/approver e o
//       FindingDetail renderiza a decisao (aprovado/rejeitado), quem, quando e
//       o motivo/nota.
// ---------------------------------------------------------------------------
test('AC2 contrato: FindingApprover + FindingDetail incluem decided_at e approver', () => {
  const src = read(AGENTS_API)
  // Tipo do approver persistido (jsonb).
  assert.match(src, /interface\s+FindingApprover\b/, 'deve declarar a interface FindingApprover')
  assert.match(src, /approver_id\??:/, 'FindingApprover deve ter approver_id')
  assert.match(src, /approver_name\??:/, 'FindingApprover deve ter approver_name')
  assert.match(src, /note\??:/, 'FindingApprover deve ter note')
  // FindingDetail expoe os campos de decisao.
  assert.match(src, /decided_at:\s*string\s*\|\s*null/, 'FindingDetail deve declarar decided_at: string | null')
  assert.match(src, /approver:\s*FindingApprover\s*\|\s*null/, 'FindingDetail deve declarar approver: FindingApprover | null')
})

test('AC2 contrato: FINDING_DETAIL_COLS seleciona decided_at e approver de ops_findings_view', () => {
  const src = read(AGENTS_API)
  const cols = src.match(/FINDING_DETAIL_COLS\s*=\s*\n?\s*'([^']+)'/)
  assert.ok(cols, 'deve existir a constante FINDING_DETAIL_COLS')
  const list = cols[1].split(',').map((c) => c.trim())
  assert.ok(list.includes('decided_at'), 'FINDING_DETAIL_COLS deve incluir decided_at')
  assert.ok(list.includes('approver'), 'FINDING_DETAIL_COLS deve incluir approver')
  // Read contract intacto: ainda le ops_findings_view (nao quebra o contrato existente).
  assert.match(src, /\.from\(\s*'ops_findings_view'\s*\)/, 'getFinding deve continuar lendo ops_findings_view')
})

test('AC2 UI: bloco de historico renderiza decisao, quem, quando e motivo/nota', () => {
  const src = read(FINDING_DETAIL)
  // So aparece quando decidido.
  assert.match(src, /isDecided\s*=/, 'deve computar isDecided')
  assert.match(src, /\{isDecided\s*&&/, 'o bloco de historico deve ser condicionado a isDecided')
  // Rotulo da decisao mapeia status -> aprovado/rejeitado.
  assert.match(src, /decisionApproved/, 'deve usar decisionApproved')
  assert.match(src, /decisionRejected/, 'deve usar decisionRejected')
  assert.match(src, /data\.status\s*===\s*'approved'/, 'deve mapear status approved')
  assert.match(src, /data\.status\s*===\s*'rejected'/, 'deve mapear status rejected')
  // Quem decidiu (approver_name/approver_id) e quando (decided_at formatado).
  assert.match(src, /approver\?\.approver_name\s*\?\?\s*approver\?\.approver_id/, 'quem decidiu vem de approver_name/approver_id')
  assert.match(src, /t\('decidedBy'\)/, 'deve renderizar quem decidiu (decidedBy)')
  assert.match(src, /formatDateTime\(\s*data\.decided_at\s*\)/, 'deve formatar e renderizar decided_at')
  assert.match(src, /t\('decidedAt'\)/, 'deve renderizar quando (decidedAt)')
  // Motivo/nota: rejeicao usa "reason", demais usam "note".
  assert.match(src, /approver\?\.note/, 'deve ler a nota/motivo de approver.note')
  assert.match(
    src,
    /data\.status\s*===\s*'rejected'\s*\?\s*t\('decisionReason'\)\s*:\s*t\('decisionNote'\)/,
    'o rotulo da nota deve ser reason em rejeicao e note caso contrario',
  )
})

test('AC2 i18n: chaves do historico de decisao existem e nao sao vazias em ambas locales', () => {
  const keys = ['decisionHistory', 'decisionApproved', 'decisionRejected', 'decidedBy', 'decidedAt', 'decisionReason', 'decisionNote']
  for (const [locale, relPath] of [['pt-BR', PT_BR], ['en-US', EN_US]]) {
    const fd = readJson(relPath).screens.findingDetail
    for (const k of keys) {
      assert.equal(typeof fd[k], 'string', `${locale} deve definir screens.findingDetail.${k}`)
      assert.notEqual(fd[k].trim(), '', `${locale} ${k} nao pode ser vazio`)
    }
  }
})

// ---------------------------------------------------------------------------
// AC3 — Comparacao esperado x faturado + impacto Δ com direcao over/under.
// ---------------------------------------------------------------------------
test('AC3 comparacao: bloco esperado x faturado x impacto com direcao over/under-billed', () => {
  const src = read(FINDING_DETAIL)
  // Direcao da discrepancia derivada de billed vs expected.
  assert.match(
    src,
    /overBilled\s*=\s*\(data\.billed_amount\s*\?\?\s*0\)\s*>\s*\(data\.expected_amount\s*\?\?\s*0\)/,
    'overBilled deve comparar billed_amount vs expected_amount',
  )
  assert.match(src, /t\('overBilled'\)/, 'deve usar a string overBilled')
  assert.match(src, /t\('underBilled'\)/, 'deve usar a string underBilled')
  // Os tres valores aparecem no bloco de comparacao.
  assert.match(src, /t\('comparison'\)/, 'deve ter o cabecalho de comparacao')
  assert.match(src, /t\('expected'\)/, 'deve renderizar o esperado')
  assert.match(src, /t\('billed'\)/, 'deve renderizar o faturado')
  assert.match(src, /formatBRLKpi\(data\.expected_amount\)/, 'deve formatar expected_amount em BRL')
  assert.match(src, /formatBRLKpi\(data\.billed_amount\)/, 'deve formatar billed_amount em BRL')
  assert.match(src, /formatBRLKpi\(data\.delta\)/, 'deve formatar o impacto delta em BRL')
  // Tratamento de cor acessivel ligado a direcao (sem depender so de cor: ha ▲/▼).
  assert.match(src, /impactColor\s*=\s*overBilled\s*\?/, 'a cor do impacto deve depender da direcao')
  assert.match(src, /overBilled\s*\?\s*'▲'\s*:\s*'▼'/, 'deve indicar a direcao tambem com seta (nao so cor)')
})

test('AC3 i18n: chaves de comparacao existem e nao sao vazias em ambas locales', () => {
  for (const [locale, relPath] of [['pt-BR', PT_BR], ['en-US', EN_US]]) {
    const fd = readJson(relPath).screens.findingDetail
    for (const k of ['comparison', 'overBilled', 'underBilled']) {
      assert.equal(typeof fd[k], 'string', `${locale} deve definir screens.findingDetail.${k}`)
      assert.notEqual(fd[k].trim(), '', `${locale} ${k} nao pode ser vazio`)
    }
  }
})

// ---------------------------------------------------------------------------
// AC4 — Trilha de auditoria antiga removida.
// ---------------------------------------------------------------------------
test('AC4 regressao: FindingDetail nao referencia mais audit-trail/openAuditTrail', () => {
  const src = read(FINDING_DETAIL)
  assert.doesNotMatch(src, /audit-trail/, 'FindingDetail nao deve mais referenciar a chave audit-trail')
  assert.doesNotMatch(src, /openAuditTrail/, 'FindingDetail nao deve mais usar openAuditTrail')
  assert.doesNotMatch(src, /getAuditTrail/, 'FindingDetail nao deve mais chamar getAuditTrail')
  // O entry point antigo abria janela via openWindow; nao deve mais importar a store para isso.
  assert.doesNotMatch(src, /openWindow/, 'FindingDetail nao deve mais abrir janela de audit-trail via openWindow')
})

test('AC4 regressao: AuditTrail.tsx removido e ausente do registry; getAuditTrail removido da API', () => {
  assert.ok(
    !existsSync(resolve(ROOT, 'src/portal/renderers/screens/AuditTrail.tsx')),
    'AuditTrail.tsx deve ter sido removido',
  )
  const registry = read(REGISTRY)
  assert.doesNotMatch(registry, /'audit-trail'/, 'o registry nao deve ter entrada audit-trail')
  assert.doesNotMatch(registry, /AuditTrail/, 'o registry nao deve importar AuditTrail')
  const api = read(AGENTS_API)
  assert.doesNotMatch(api, /export\s+async\s+function\s+getAuditTrail/, 'getAuditTrail deve ter sido removido da API')
  assert.doesNotMatch(api, /interface\s+AuditEvent\b/, 'a interface AuditEvent deve ter sido removida')
})

test('AC4 regressao: i18n nao tem mais o namespace auditTrail nem chaves openAuditTrail', () => {
  for (const [locale, relPath] of [['pt-BR', PT_BR], ['en-US', EN_US]]) {
    const msgs = readJson(relPath)
    assert.equal(msgs.screens.auditTrail, undefined, `${locale} nao deve mais ter screens.auditTrail`)
    const fd = msgs.screens.findingDetail
    assert.equal(fd.openAuditTrail, undefined, `${locale} nao deve mais ter findingDetail.openAuditTrail`)
    assert.equal(fd.auditTrail, undefined, `${locale} nao deve mais ter findingDetail.auditTrail`)
  }
})

// ---------------------------------------------------------------------------
// AC5 — Aprovar/rejeitar continua via decideFinding (motivo obrigatorio em
//       rejeicao) e atualiza a tela.
// ---------------------------------------------------------------------------
test('AC5 aprovacao: continua usando decideFinding e recarrega a tela apos decidir', () => {
  const src = read(FINDING_DETAIL)
  assert.match(
    src,
    /import\s+\{[^}]*decideFinding[^}]*\}\s+from\s+['"]@\/portal\/lib\/agentsApi['"]/,
    'deve importar decideFinding de agentsApi',
  )
  assert.match(src, /await\s+decideFinding\(\s*\{/, 'deve chamar decideFinding com os dados da decisao')
  assert.match(src, /decision:\s*mode/, 'deve passar a decisao (approve/reject) para decideFinding')
  // Rejeicao envia reason; aprovacao envia note.
  assert.match(src, /reason:\s*mode\s*===\s*'reject'\s*\?\s*text/, 'rejeicao deve enviar o motivo (reason)')
  // decideFinding existe de fato na API.
  assert.match(read(AGENTS_API), /export\s+async\s+function\s+decideFinding\s*\(/, 'agentsApi deve exportar decideFinding')
})

// ---------------------------------------------------------------------------
// AC5 — Guard de "motivo obrigatorio na rejeicao": o handler de confirmacao
//       bloqueia a rejeicao com motivo vazio (antes mesmo de chamar a API).
// ---------------------------------------------------------------------------
test('AC5 guard: rejeicao exige motivo nao-vazio (rejectReasonRequired) e aborta antes de decideFinding', () => {
  const src = read(FINDING_DETAIL)
  // A guarda checa mode === 'reject' && !text.trim() (motivo vazio/em branco).
  assert.match(
    src,
    /mode\s*===\s*'reject'\s*&&\s*!text\.trim\(\)/,
    'deve barrar rejeicao quando o motivo esta vazio/em branco (!text.trim())',
  )
  // Sinaliza o erro com a chave estavel rejectReasonRequired.
  assert.match(src, /setDialogErr\(\s*t\('rejectReasonRequired'\)\s*\)/, 'deve exibir t("rejectReasonRequired") no dialogo')
  // E retorna cedo (aborta) — a guarda precede a chamada a decideFinding.
  const guardIdx = src.search(/mode\s*===\s*'reject'\s*&&\s*!text\.trim\(\)/)
  const reasonRequiredIdx = src.search(/setDialogErr\(\s*t\('rejectReasonRequired'\)\s*\)\s*\n\s*return/)
  const decideIdx = src.search(/await\s+decideFinding\(/)
  assert.ok(reasonRequiredIdx > -1, 'a guarda deve retornar cedo (return) apos sinalizar o erro')
  assert.ok(
    guardIdx > -1 && decideIdx > -1 && guardIdx < decideIdx,
    'a guarda de motivo obrigatorio deve preceder a chamada a decideFinding',
  )
  // i18n: a chave existe e nao e vazia em ambas as locales.
  for (const [locale, relPath] of [['pt-BR', PT_BR], ['en-US', EN_US]]) {
    const fd = readJson(relPath).screens.findingDetail
    assert.equal(typeof fd.rejectReasonRequired, 'string', `${locale} deve definir screens.findingDetail.rejectReasonRequired`)
    assert.notEqual(fd.rejectReasonRequired.trim(), '', `${locale} rejectReasonRequired nao pode ser vazio`)
  }
})

// ---------------------------------------------------------------------------
// AC5 — Refresh pos-decisao: o load() de refresh ocorre DENTRO do handler de
//       confirmacao, DEPOIS do decideFinding (nao basta o load() do useEffect).
// ---------------------------------------------------------------------------
test('AC5 refresh: recarrega a tela com load() apos o decideFinding bem-sucedido', () => {
  const src = read(FINDING_DETAIL)
  // Pin especifico: do `await decideFinding(...)` ate o `load()` de refresh, sem
  // que outro return/catch interrompa — prova que e o refresh pos-decisao e nao
  // o load() do useEffect inicial.
  assert.match(
    src,
    /await\s+decideFinding\([\s\S]*?\)\s*[\s\S]*?\bload\(\)/,
    'o load() de refresh deve aparecer depois do await decideFinding(...) (no handler de confirmacao)',
  )
  // E o refresh nao pode estar antes da chamada a API.
  const decideIdx = src.search(/await\s+decideFinding\(/)
  const refreshIdx = src.indexOf('load()', decideIdx)
  assert.ok(decideIdx > -1 && refreshIdx > decideIdx, 'load() de refresh deve vir apos await decideFinding(...)')
})
