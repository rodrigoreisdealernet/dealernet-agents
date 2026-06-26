// Verificacao dependency-free do Painel de Agentes redesenhado como console de
// observabilidade — Issue #95 (spec: docs/specs/95-redesenhar-painel-de-agentes-como.md).
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest, sem node_modules
// no worktree): usamos apenas modulos nativos do Node (node:test, node:assert,
// node:fs) para assertar — lendo o arquivo-fonte AgentsDashboard.tsx como texto —
// que a tela satisfaz os criterios de aceite da spec.
//
// Roda com: node --test scripts/verify-agents-observability.mjs
//
// Este e o padrao estabelecido do repo (ver verify-parts-bi.mjs / verify-chartcard.mjs):
// testes estruturais sobre o texto-fonte, sem introduzir um framework de testes
// novo (Non-Goal explicito das specs deste repo).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SCREEN_PATH = 'src/portal/renderers/screens/AgentsDashboard.tsx'
const PT_MESSAGES_PATH = 'src/i18n/messages/pt-BR.json'
const EN_MESSAGES_PATH = 'src/i18n/messages/en-US.json'

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — "Scannable agent health": classificacao de saude por agente.
// ─────────────────────────────────────────────────────────────────────────────
test('AC1: agentHealth classifica cada agente em healthy/attention/failing/idle/disabled', () => {
  const src = read(SCREEN_PATH)

  // Funcao de classificacao exportada (marcador estavel para outros consumidores).
  assert.match(
    src,
    /export\s+function\s+agentHealth\s*\(\s*\w+\s*:\s*AgentStatus\s*\)/,
    'deve haver uma funcao exportada agentHealth(a: AgentStatus) que deriva a saude',
  )

  // O tipo de saude deve cobrir os tres estados pedidos pela spec (failing/attention/
  // healthy) alem de idle/disabled. Ancoramos no alias de tipo AgentHealth.
  const healthTypeBlock =
    src.match(/type\s+AgentHealth\s*=([\s\S]*?)\n/)?.[1] ?? ''
  assert.ok(healthTypeBlock, 'nao foi possivel localizar o tipo AgentHealth')
  for (const state of ['failing', 'attention', 'healthy', 'idle', 'disabled']) {
    assert.match(
      healthTypeBlock,
      new RegExp(`'${state}'`),
      `o tipo AgentHealth deve incluir o estado '${state}'`,
    )
  }

  // A classificacao deve ser COMPORTAMENTAL, derivada de campos reais da view:
  // - failing quando ha falha recente OU mais falhas que sucessos.
  assert.match(
    src,
    /a\.failed_runs\s*>\s*a\.succeeded_runs/,
    "agentHealth deve marcar 'failing' quando failed_runs > succeeded_runs",
  )
  assert.match(
    src,
    /isFailedStatus\(\s*a\.last_run_status\s*\)/,
    "agentHealth deve marcar 'failing' quando o ultimo status indica falha (isFailedStatus)",
  )
  // - attention quando ha findings pendentes.
  assert.match(
    src,
    /a\.pending_findings\s*>\s*0/,
    "agentHealth deve marcar 'attention' quando ha pending_findings > 0",
  )
  // - disabled tem precedencia para agentes desligados.
  assert.match(
    src,
    /if\s*\(\s*!a\.enabled\s*\)\s*return\s*'disabled'/,
    "agentHealth deve retornar 'disabled' para agentes nao habilitados (precedencia)",
  )

  // Indicador visual unico: cada saude mapeia para um Tone do design-system (badge/cor).
  assert.match(
    src,
    /HEALTH_TONE\s*:\s*Record<\s*AgentHealth\s*,\s*Tone\s*>/,
    'deve existir um mapa HEALTH_TONE: Record<AgentHealth, Tone> (indicador visual unico)',
  )
  // failing -> danger e healthy -> success sao os polos semanticos que importam.
  assert.match(src, /failing:\s*'danger'/, "HEALTH_TONE deve mapear failing -> 'danger'")
  assert.match(src, /healthy:\s*'success'/, "HEALTH_TONE deve mapear healthy -> 'success'")
  assert.match(src, /attention:\s*'warning'/, "HEALTH_TONE deve mapear attention -> 'warning'")

  // O badge de saude e renderizado com o tone derivado.
  assert.match(
    src,
    /<Badge\s+tone=\{HEALTH_TONE\[health\]\}>/,
    'o card deve renderizar <Badge tone={HEALTH_TONE[health]}> como indicador de saude',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — "Scannable agent health": taxa de sucesso (sucessos / total) renderizada.
// ─────────────────────────────────────────────────────────────────────────────
test('AC1: taxa de sucesso = succeeded_runs / total_runs e exibida com ProgressBar', () => {
  const src = read(SCREEN_PATH)

  // Calculo: succeeded / total (em %). Assertamos a matematica para que o teste
  // FALHE se trocarem por uma metrica diferente.
  assert.match(
    src,
    /a\.succeeded_runs\s*\/\s*a\.total_runs/,
    'successRate deve dividir succeeded_runs por total_runs',
  )
  // Sem corridas nao ha taxa (evita divisao por zero / numero enganoso).
  assert.match(
    src,
    /a\.total_runs\s*<=\s*0\s*\)\s*return\s+null/,
    'successRate deve retornar null quando total_runs <= 0 (sem divisao por zero)',
  )
  // Renderizacao: rotulo de taxa + barra de progresso com tom semantico.
  assert.match(
    src,
    /t\(\s*'successRate'\s*\)/,
    "deve renderizar o rotulo i18n 'successRate'",
  )
  assert.match(
    src,
    /<ProgressBar\s+value=\{rate\}\s+tone=\{successTone\(rate\)\}/,
    'a taxa de sucesso deve ser exibida via <ProgressBar value={rate} tone={successTone(rate)}>',
  )
  // O tom da barra deve degradar com a taxa: >=90 success, >=60 warning, senao danger.
  assert.match(src, /rate\s*>=\s*90\)\s*return\s*'success'/, 'successTone: >=90% -> success')
  assert.match(src, /rate\s*>=\s*60\)\s*return\s*'warning'/, 'successTone: >=60% -> warning')
  // Anchor o ramo de fallback DENTRO da funcao successTone — caso contrario um
  // `return 'danger'` em qualquer outro lugar do arquivo manteria o teste verde.
  const successToneBlock =
    src.match(/function\s+successTone\s*\([\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(successToneBlock, 'nao foi possivel localizar a funcao successTone')
  assert.match(
    successToneBlock,
    /rate\s*>=\s*60\)\s*return\s*'warning'\s*\n\s*return\s*'danger'/,
    "successTone: o ramo final (apos o teste >=60) deve retornar 'danger'",
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — "Scannable agent health": contagem de falhas enfatizada quando > 0.
// ─────────────────────────────────────────────────────────────────────────────
test('AC1: contagem de falhas e enfatizada (destructive) somente quando failed_runs > 0', () => {
  const src = read(SCREEN_PATH)

  // O bloco de falhas e condicional a failed_runs > 0 e usa cor de destaque.
  // Ancoramos o inicio do bloco condicional e validamos seu conteudo (a partir
  // dele): numero de falhas, cor de destaque e rotulo i18n no mesmo trecho.
  assert.match(
    src,
    /a\.failed_runs\s*>\s*0\s*&&\s*\(/,
    'deve haver um bloco condicional `a.failed_runs > 0 && (...)` para a contagem de falhas',
  )
  const failureStart = src.search(/a\.failed_runs\s*>\s*0\s*&&\s*\(/)
  const failureBlock = src.slice(failureStart, failureStart + 220)
  assert.match(
    failureBlock,
    /\{a\.failed_runs\}/,
    'o bloco de falhas deve exibir o numero {a.failed_runs}',
  )
  assert.match(
    failureBlock,
    /text-destructive/,
    'a contagem de falhas deve ser enfatizada com a cor de destaque (text-destructive)',
  )
  assert.match(
    failureBlock,
    /t\(\s*'failures'\s*\)/,
    "a contagem de falhas deve usar o rotulo i18n 'failures'",
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — "Scannable agent health": status + timestamp da ultima execucao.
// ─────────────────────────────────────────────────────────────────────────────
test('AC1: status e timestamp da ultima execucao sao exibidos', () => {
  const src = read(SCREEN_PATH)
  assert.match(
    src,
    /t\(\s*'lastRun'\s*\)/,
    "deve renderizar o rotulo i18n 'lastRun'",
  )
  // O timestamp e formatado pelo helper compartilhado e o status bruto e exibido.
  assert.match(
    src,
    /formatDateTime\(\s*a\.last_run_finished_at\s*\)/,
    'deve formatar o horario da ultima execucao via formatDateTime(a.last_run_finished_at)',
  )
  assert.match(
    src,
    /a\.last_run_status\s*\?\?\s*'—'/,
    "deve exibir a.last_run_status (com fallback '—') ao lado do horario",
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — "Disabled agents are explicit": marca + acao indisponivel.
// ─────────────────────────────────────────────────────────────────────────────
test('AC2: agente desativado e marcado e seu botao "Executar agora" fica desabilitado', () => {
  const src = read(SCREEN_PATH)

  // Marca visual: badge de "disabled" + opacidade reduzida no card.
  assert.match(
    src,
    /!a\.enabled\s*&&\s*<Badge\s+tone="neutral">\{t\(\s*'healthDisabled'\s*\)\}<\/Badge>/,
    'um agente nao habilitado deve renderizar um Badge "healthDisabled"',
  )
  assert.match(
    src,
    /a\.enabled\s*\?\s*''\s*:\s*' opacity-60'/,
    'o card de um agente desativado deve ser atenuado (opacity-60)',
  )

  // Acao indisponivel: o botao "Executar agora" e disabled quando !a.enabled.
  assert.match(
    src,
    /disabled=\{\s*!a\.enabled\s*\|\|\s*isRunning\s*\}/,
    'o botao Executar agora deve ter disabled={!a.enabled || isRunning}',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — "Useful ordering/prioritization": agentes que precisam de atencao primeiro.
// ─────────────────────────────────────────────────────────────────────────────
test('AC3: sortAgentsByPriority ordena por HEALTH_PRIORITY (failing/attention primeiro)', () => {
  const src = read(SCREEN_PATH)

  // Existe um mapa de prioridade por saude e uma funcao de ordenacao exportada.
  assert.match(
    src,
    /HEALTH_PRIORITY\s*:\s*Record<\s*AgentHealth\s*,\s*number\s*>/,
    'deve existir um mapa HEALTH_PRIORITY: Record<AgentHealth, number>',
  )
  assert.match(
    src,
    /export\s+function\s+sortAgentsByPriority\s*\(\s*\w+\s*:\s*AgentStatus\[\]\s*\)/,
    'deve haver uma funcao exportada sortAgentsByPriority(agents: AgentStatus[])',
  )

  // A prioridade deve colocar failing(0) e attention(1) ANTES de healthy(2)/idle(3)/
  // disabled(4). Assertamos os numeros para que o teste FALHE se a ordem inverter.
  const priorityBlock =
    src.match(/HEALTH_PRIORITY[\s\S]*?\{([\s\S]*?)\}/)?.[1] ?? ''
  assert.ok(priorityBlock, 'nao foi possivel localizar o corpo de HEALTH_PRIORITY')
  const priorityOf = (state) =>
    Number(priorityBlock.match(new RegExp(`${state}\\s*:\\s*(\\d+)`))?.[1])
  const failing = priorityOf('failing')
  const attention = priorityOf('attention')
  const healthy = priorityOf('healthy')
  const idle = priorityOf('idle')
  const disabled = priorityOf('disabled')
  assert.ok(
    failing < attention &&
      attention < healthy &&
      healthy < idle &&
      idle < disabled,
    `a prioridade deve ser failing<attention<healthy<idle<disabled; obtido ` +
      `${failing},${attention},${healthy},${idle},${disabled}`,
  )

  // A ordenacao deve ser ESTAVEL (desempate deterministico por agent_key) e nao
  // mutar o array de origem (usa spread antes do sort).
  assert.match(
    src,
    /\[\.\.\.\s*agents\s*\]\.sort\(/,
    'sortAgentsByPriority nao deve mutar o array de origem (deve usar [...agents].sort)',
  )
  assert.match(
    src,
    /a\.agent_key\.localeCompare\(\s*b\.agent_key\s*\)/,
    'o desempate da ordenacao deve ser deterministico via agent_key.localeCompare',
  )

  // CHAVE PRIMARIA do comparador: a ordenacao tem de comparar HEALTH_PRIORITY da
  // SAUDE de cada agente (pa - pb), nao apenas o desempate por agent_key. Sem isso,
  // se o comparador primario fosse removido (reduzido a so localeCompare), as
  // assertions acima continuariam verdes com a feature quebrada. Ancoramos no
  // corpo real de sortAgentsByPriority.
  const sortBody =
    src.match(/function\s+sortAgentsByPriority\s*\([\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(sortBody, 'nao foi possivel localizar o corpo de sortAgentsByPriority')
  assert.match(
    sortBody,
    /HEALTH_PRIORITY\[\s*agentHealth\(a\)\s*\]/,
    'o comparador deve computar HEALTH_PRIORITY[agentHealth(a)] (chave primaria por saude)',
  )
  assert.match(
    sortBody,
    /HEALTH_PRIORITY\[\s*agentHealth\(b\)\s*\]/,
    'o comparador deve computar HEALTH_PRIORITY[agentHealth(b)] (chave primaria por saude)',
  )
  // E deve efetivamente ORDENAR por essa chave: retorna a diferenca de prioridade
  // quando elas diferem (pa !== pb -> pa - pb), antes de cair no desempate.
  assert.match(
    sortBody,
    /if\s*\(\s*pa\s*!==\s*pb\s*\)\s*return\s*pa\s*-\s*pb/,
    'o comparador deve retornar (pa - pb) quando as prioridades diferem (chave primaria)',
  )

  // A ordenacao deve ser observavel na lista renderizada: a lista mapeada usa o
  // resultado ordenado, nao o array bruto.
  assert.match(
    src,
    /const\s+orderedAgents\s*=\s*sortAgentsByPriority\(\s*agents\s*\)/,
    'orderedAgents deve ser derivado de sortAgentsByPriority(agents)',
  )
  assert.match(
    src,
    /orderedAgents\.map\(/,
    'a lista renderizada deve iterar orderedAgents (ordenacao observavel)',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — "Loading, error, and empty states" + sem piscar a tela no refresh.
// ─────────────────────────────────────────────────────────────────────────────
test('AC4: estados dedicados de skeleton/erro/vazio existem e o poll nao apaga a tela', () => {
  const src = read(SCREEN_PATH)

  // Loading: skeleton pulsante (placeholder) em vez de texto puro.
  assert.match(
    src,
    /function\s+AgentCardSkeleton\s*\(/,
    'deve haver um componente AgentCardSkeleton (placeholder de carregamento)',
  )
  assert.match(
    src,
    /animate-pulse/,
    'o skeleton deve ser um placeholder pulsante (animate-pulse), nao texto puro',
  )
  assert.match(
    src,
    /const\s+showSkeleton\s*=\s*loading\s*&&\s*agents\.length\s*===\s*0/,
    'o skeleton so deve aparecer no carregamento inicial (loading && agents.length === 0)',
  )
  assert.match(
    src,
    /showSkeleton\s*&&[\s\S]*?AgentCardSkeleton/,
    'showSkeleton deve renderizar AgentCardSkeleton',
  )

  // Empty: estado vazio dedicado quando nao ha agentes (e nao e erro/loading).
  assert.match(
    src,
    /const\s+showEmpty\s*=\s*!loading\s*&&\s*!error\s*&&\s*agents\.length\s*===\s*0/,
    'showEmpty deve ser !loading && !error && agents.length === 0',
  )
  assert.match(
    src,
    /showEmpty\s*&&[\s\S]*?t\(\s*'noAgents'\s*\)/,
    "o estado vazio deve renderizar a mensagem i18n 'noAgents'",
  )

  // Error: estado de erro dedicado quando nao ha dados a exibir.
  assert.match(
    src,
    /const\s+showLoadError\s*=\s*!!error\s*&&\s*agents\.length\s*===\s*0/,
    'showLoadError deve ser !!error && agents.length === 0',
  )
  assert.match(
    src,
    /showLoadError\s*&&[\s\S]*?t\(\s*'loadError'\s*\)/,
    "o estado de erro deve renderizar a mensagem i18n 'loadError'",
  )

  // Sem piscar: o poll de 10s NAO limpa os agentes em caso de erro — exibe um
  // banner nao-bloqueante e preserva os dados ja exibidos.
  assert.match(
    src,
    /error\s*&&\s*agents\.length\s*>\s*0\s*&&/,
    'um erro durante o poll com dados ja exibidos deve mostrar banner nao-bloqueante',
  )
  // O catch do load nao zera os agentes — apenas seta o erro.
  assert.match(
    src,
    /\.catch\(\s*\(e\)\s*=>\s*alive\s*&&\s*setError\(/,
    'o catch do load deve apenas setError (nao deve limpar os agentes ja carregados)',
  )
  assert.ok(
    !/setAgents\(\s*\[\s*\]\s*\)/.test(src),
    'o load nao deve resetar agentes para [] (evita piscar a tela no refresh)',
  )

  // O poll de 10s e instalado e limpo no unmount (evita updates apos desmontar).
  assert.match(
    src,
    /setInterval\(\s*load\s*,\s*10000\s*\)/,
    'deve existir um poll de 10s (setInterval(load, 10000))',
  )
  assert.match(
    src,
    /clearInterval\(\s*timer\s*\)/,
    'o intervalo de poll deve ser limpo no cleanup do efeito',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — "Clear Executar agora feedback": running/success/error por agente.
// ─────────────────────────────────────────────────────────────────────────────
test('AC5: o disparo mostra feedback running/success/error por agente, com mensagem de erro', () => {
  const src = read(SCREEN_PATH)

  // Estado por-agente (mapa keyed por agent_key) — independente do polling.
  assert.match(
    src,
    /runNowStates\s*,\s*setRunNowStates\s*\]\s*=\s*useState<\s*Record<\s*string\s*,\s*RunNowState\s*>/,
    'o feedback de execucao deve ser um Record<string, RunNowState> por agente',
  )

  // O handler transiciona running -> success/error e captura a mensagem do erro.
  assert.match(
    src,
    /setRunNowStates\(\s*\(s\)\s*=>\s*\(\{\s*\.\.\.s\s*,\s*\[agentKey\]\s*:\s*\{\s*status:\s*'running'\s*\}/,
    'handleRunNow deve marcar o agente como running antes de chamar runAgentNow',
  )
  assert.match(
    src,
    /await\s+runAgentNow\(\s*agentKey\s*,\s*locale\s*\)/,
    'handleRunNow deve chamar runAgentNow(agentKey, locale)',
  )
  assert.match(
    src,
    /\[agentKey\]\s*:\s*\{\s*status:\s*'success'\s*\}/,
    'em sucesso, o estado do agente deve virar status: success',
  )
  assert.match(
    src,
    /status:\s*'error'\s*,\s*message:\s*e\s+instanceof\s+Error\s*\?\s*e\.message/,
    'em erro, o estado deve virar status: error capturando e.message',
  )

  // O feedback e renderizado distintamente: running no botao, badge de sucesso,
  // e a MENSAGEM de erro visivel ao usuario.
  assert.match(
    src,
    /isRunning\s*\?\s*t\(\s*'running'\s*\)\s*:\s*t\(\s*'runNow'\s*\)/,
    "o botao deve alternar entre 'running' e 'runNow'",
  )
  assert.match(
    src,
    /runNowState\?\.status\s*===\s*'success'\s*&&\s*<Badge\s+tone="success">\{t\(\s*'runSuccess'\s*\)\}/,
    'em sucesso deve renderizar um Badge de sucesso (runSuccess)',
  )
  assert.match(
    src,
    /runNowState\?\.status\s*===\s*'error'\s*&&\s*\([\s\S]*?runNowState\.message\s*\|\|\s*t\(\s*'runError'\s*\)/,
    'em erro deve renderizar a mensagem do erro (fallback runError) ao usuario',
  )

  // O clique de "Executar agora" nao deve disparar a navegacao do card (stopPropagation),
  // garantindo que o resto da UI nao congela / nao perde o clique.
  assert.match(
    src,
    /event\.stopPropagation\(\)/,
    'o clique no botao deve chamar event.stopPropagation() (nao abre a fila ao executar)',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — "Production KPI hierarchy": KPIs com label+value e legenda "Valores em R$".
// ─────────────────────────────────────────────────────────────────────────────
test('AC6: KPIs usam KpiCard (label+value+accent) e a legenda valuesInBRL e preservada', () => {
  const src = read(SCREEN_PATH)

  // A legenda "Valores em R$" e preservada via common('valuesInBRL') no ScreenShell.
  assert.match(
    src,
    /legend=\{common\(\s*'valuesInBRL'\s*\)\}/,
    "o ScreenShell deve preservar a legenda common('valuesInBRL')",
  )

  // Quatro KpiCards com hierarquia label/value; pelo menos um com accent semantico.
  const kpiCards = src.match(/<KpiCard\b/g) ?? []
  assert.ok(
    kpiCards.length >= 4,
    `devem existir >= 4 KpiCard no topo; encontrados ${kpiCards.length}`,
  )
  assert.match(
    src,
    /<KpiCard[\s\S]*?label=\{t\([\s\S]*?value=/,
    'os KpiCard devem ter hierarquia label + value',
  )
  // accent semantico (micro-indicador de variacao/estado) onde os dados permitem.
  assert.match(
    src,
    /kpis\s*&&\s*kpis\.pending_count\s*>\s*0\s*\?\s*'warning'\s*:\s*'neutral'/,
    'o KPI de pendentes deve acentuar warning quando pending_count > 0',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AC7 (este script) + paridade i18n: as chaves novas existem em pt-BR e en-US.
// ─────────────────────────────────────────────────────────────────────────────
test('AC7: chaves i18n novas existem em pt-BR e en-US (sem regressao de paridade)', () => {
  const pt = JSON.parse(read(PT_MESSAGES_PATH))
  const en = JSON.parse(read(EN_MESSAGES_PATH))
  const ptDash = pt?.screens?.agentsDashboard ?? {}
  const enDash = en?.screens?.agentsDashboard ?? {}

  const requiredKeys = [
    'successRate',
    'failures',
    'healthHealthy',
    'healthAttention',
    'healthFailing',
    'healthIdle',
    'healthDisabled',
    'noAgents',
    'loadError',
    'lastRun',
    'runNow',
    'running',
    'runSuccess',
    'runError',
  ]
  for (const key of requiredKeys) {
    assert.ok(
      typeof ptDash[key] === 'string' && ptDash[key].length > 0,
      `pt-BR deve definir screens.agentsDashboard.${key}`,
    )
    assert.ok(
      typeof enDash[key] === 'string' && enDash[key].length > 0,
      `en-US deve definir screens.agentsDashboard.${key}`,
    )
  }

  // A legenda compartilhada que a tela referencia deve existir nos dois locais.
  assert.equal(pt?.common?.valuesInBRL, 'Valores em R$', "pt-BR common.valuesInBRL deve ser 'Valores em R$'")
  assert.ok(
    typeof en?.common?.valuesInBRL === 'string' && en.common.valuesInBRL.length > 0,
    'en-US common.valuesInBRL deve existir',
  )

  // Toda chave i18n usada via t('...') na tela deve existir no namespace pt-BR
  // (pega rotulos novos esquecidos no dicionario).
  const src = read(SCREEN_PATH)
  const usedKeys = new Set(
    [...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_]+)'\s*\)/g)].map((m) => m[1]),
  )
  for (const key of usedKeys) {
    assert.ok(
      typeof ptDash[key] === 'string',
      `a tela usa t('${key}') mas pt-BR nao define screens.agentsDashboard.${key}`,
    )
  }
})
