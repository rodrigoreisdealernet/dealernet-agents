// Verificacao dependency-free do fluxo de locale end-to-end — Issue #76.
//
// Roda no harness source-text only do frontend, sem node_modules/jsdom.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(ROOT, '..')

function read(relPath, root = ROOT) {
  const full = resolve(root, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

function readJson(relPath) {
  return JSON.parse(read(relPath))
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

function exportedFnBody(src, signature) {
  const start = src.indexOf(signature)
  assert.ok(start !== -1, `assinatura nao encontrada: ${signature}`)
  const next = src.indexOf('\nexport ', start + signature.length)
  return src.slice(start, next === -1 ? undefined : next)
}

function blockAfter(src, marker) {
  const start = src.indexOf(marker)
  assert.ok(start !== -1, `marcador nao encontrado: ${marker}`)
  const open = src.indexOf('{', start)
  assert.ok(open !== -1, `bloco nao encontrado apos: ${marker}`)
  let depth = 0
  for (let index = open; index < src.length; index += 1) {
    if (src[index] === '{') depth += 1
    else if (src[index] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, index + 1)
    }
  }
  assert.fail(`fim do bloco nao encontrado apos: ${marker}`)
}

test('AC1: DIA chat envia locale do Portal no contexto da ops-api', () => {
  const assistantApi = read('src/portal/lib/assistantApi.ts')
  const daiStore = read('src/portal/components/dai/useDaiStore.ts')
  const daiAssistant = read('src/portal/components/dai/DaiAssistant.tsx')
  const chatWithAssistant = exportedFnBody(assistantApi, 'function chatWithAssistant')
  const daiContext = blockAfter(daiStore, 'const context =')

  assert.match(assistantApi, /import\s+type\s+\{\s*Locale\s*\}\s+from\s+['"]@\/i18n\/locale['"]/, 'assistantApi deve tipar locale')
  assert.match(assistantApi, /locale\?:\s*Locale/, 'AssistantChatContext deve aceitar locale')
  assert.match(chatWithAssistant, /context:\s*AssistantChatContext/, 'chatWithAssistant deve receber AssistantChatContext')
  assert.match(
    chatWithAssistant,
    /body:\s*JSON\.stringify\(\{\s*messages,\s*context\s*\}\)/,
    'request body do chat deve incluir o objeto context completo',
  )
  assert.doesNotMatch(
    chatWithAssistant,
    /body:\s*JSON\.stringify\(\{\s*messages\s*\}\)/,
    'request body do chat nao pode omitir context.locale',
  )
  assert.match(daiStore, /send:\s*\(text:\s*string,\s*locale:\s*Locale,\s*fallbackReply:\s*string\)/, 'store deve exigir locale ao enviar')
  assert.match(daiContext, /locale,\s*\n/, 'objeto context passado ao assistantApi deve incluir o campo locale')
  assert.match(daiStore, /chatWithAssistant\(toApiMessages\(history\),\s*context\)/, 'chat deve enviar o objeto context com locale')
  assert.match(daiAssistant, /const\s+\{\s*locale\s*\}\s*=\s*useLocale\(\)/, 'painel DIA deve ler locale selecionado')
  assert.match(daiAssistant, /send\(text,\s*locale,\s*t\(['"]replyError['"]\)\)/, 'painel DIA deve repassar locale ao envio')
})

test('AC1/AC3: disparo de agente envia locale e usa fallback pt-BR', () => {
  const agentsApi = read('src/portal/lib/agentsApi.ts')
  const agentsDashboard = read('src/portal/renderers/screens/AgentsDashboard.tsx')
  const runAgentNow = exportedFnBody(agentsApi, 'function runAgentNow')

  assert.match(agentsApi, /import\s+type\s+\{\s*Locale\s*\}\s+from\s+['"]@\/i18n\/locale['"]/, 'agentsApi deve importar Locale')
  assert.match(runAgentNow, /runAgentNow\(agentKey:\s*string,\s*locale\?:\s*Locale\)/, 'runAgentNow deve aceitar locale opcional')
  assert.match(
    runAgentNow,
    /body:\s*JSON\.stringify\(\{\s*locale:\s*locale\s*\?\?\s*['"]pt-BR['"]\s*\}\)/,
    'request body do disparo de agente deve incluir locale com fallback pt-BR',
  )
  assert.doesNotMatch(runAgentNow, /body:\s*JSON\.stringify\(\{\s*\}\)/, 'request body do agente nao pode omitir locale')
  assert.match(agentsDashboard, /const\s+\{\s*locale\s*\}\s*=\s*useLocale\(\)/, 'AgentsDashboard deve ler locale selecionado')
  assert.match(agentsDashboard, /await\s+runAgentNow\(\s*agentKey,\s*locale\s*\)/, 'AgentsDashboard deve repassar locale ao disparar agente')
})

test('AC2: portal_assistant usa diretiva dinamica e nao a instrucao fixa antiga', () => {
  const portalAssistant = read('temporal/src/agents/portal_assistant.py', REPO_ROOT)
  const i18n = read('temporal/src/agents/i18n.py', REPO_ROOT)

  assert.match(portalAssistant, /language_directive\(locale\)/, 'prompt deve injetar diretiva conforme locale resolvido')
  assert.match(portalAssistant, /context\.get\(["']locale["']\)/, 'build_messages deve ler context.locale')
  assert.doesNotMatch(portalAssistant, /SEMPRE\s+em\s+portugu[eê]s/i, 'nao deve manter instrucao fixa de portugues')
  assert.match(i18n, /Reply in English \(en-US\)/, 'helper deve fornecer diretiva en-US')
  assert.match(i18n, /Responda em portugu[eê]s do Brasil \(pt-BR\)/, 'helper deve fornecer diretiva pt-BR')
})

test('AC4: pt-BR e en-US mantem exatamente o mesmo key-set', () => {
  const ptKeys = flattenLeaves(readJson('src/i18n/messages/pt-BR.json')).sort()
  const enKeys = flattenLeaves(readJson('src/i18n/messages/en-US.json')).sort()

  assert.ok(ptKeys.length >= 603, `pt-BR deve manter o catalogo completo (>=603 chaves), tem ${ptKeys.length}`)
  assert.equal(enKeys.length, ptKeys.length, 'pt-BR e en-US devem ter a mesma quantidade de chaves')
  assert.deepEqual(enKeys, ptKeys, 'catalogos pt-BR/en-US devem ter key-set identico')
})

test('AC4: componentes migrados usam t() para textos antes hardcoded', () => {
  const agentsDashboard = read('src/portal/renderers/screens/AgentsDashboard.tsx')
  const daiAssistant = read('src/portal/components/dai/DaiAssistant.tsx')
  const login = read('src/portal/components/Login.tsx')
  const topBar = read('src/portal/components/TopBar.tsx')
  const colorPicker = read('src/portal/components/forms/ColorPicker.tsx')
  const portalTour = read('src/portal/components/tour/PortalTour.tsx')
  const buscaModalField = read('src/portal/components/ui/BuscaModalField.tsx')
  const messagesPt = readJson('src/i18n/messages/pt-BR.json')
  const messagesEn = readJson('src/i18n/messages/en-US.json')

  assert.match(agentsDashboard, /useTranslations\(['"]screens\.agentsDashboard['"]\)/, 'AgentsDashboard deve usar namespace i18n')
  for (const key of ['runNow', 'running', 'runSuccess', 'runError']) {
    assert.match(agentsDashboard, new RegExp(`t\\(['"]${key}['"]\\)`), `AgentsDashboard deve renderizar t('${key}')`)
    assert.equal(typeof messagesPt.screens.agentsDashboard[key], 'string', `pt-BR deve definir ${key}`)
    assert.equal(typeof messagesEn.screens.agentsDashboard[key], 'string', `en-US deve definir ${key}`)
  }
  assert.match(daiAssistant, /useTranslations\(['"]dai['"]\)/, 'DIA assistant deve usar namespace dai')
  for (const key of ['replyError', 'openScreenCommand', 'openedScreen']) {
    assert.match(daiAssistant, new RegExp(`t\\(['"]${key}['"]`), `DaiAssistant deve renderizar t('${key}')`)
    assert.equal(typeof messagesPt.dai[key], 'string', `pt-BR deve definir dai.${key}`)
    assert.equal(typeof messagesEn.dai[key], 'string', `en-US deve definir dai.${key}`)
  }

  assert.match(login, /useTranslations\(['"]shell['"]\)/, 'Login deve traduzir controles shell')
  assert.match(login, /useTranslations\(['"]locale['"]\)/, 'Login deve traduzir nomes de locale')
  for (const key of ['themeColor', 'portalColor', 'language', 'toggleTheme']) {
    assert.match(login, new RegExp(`t\\(['"]${key}['"]\\)`), `Login deve usar t('${key}')`)
  }
  assert.match(login, /tLocale\(option\)/, 'Login deve traduzir opcoes de idioma')

  assert.match(topBar, /useTranslations\(['"]shell['"]\)/, 'TopBar deve traduzir controles shell')
  assert.match(topBar, /useTranslations\(['"]locale['"]\)/, 'TopBar deve traduzir nomes de locale')
  for (const key of ['themeColor', 'portalColor', 'language', 'toggleTheme', 'guest']) {
    assert.match(topBar, new RegExp(`t\\(['"]${key}['"]\\)`), `TopBar deve usar t('${key}')`)
  }
  assert.match(topBar, /tLocale\(option\)/, 'TopBar deve traduzir opcoes de idioma')

  assert.match(colorPicker, /useTranslations\(['"]common['"]\)/, 'ColorPicker deve usar namespace common')
  assert.match(colorPicker, /aria-label=\{t\(['"]colorPicker['"]\)\}/, 'ColorPicker deve traduzir aria-label')
  assert.doesNotMatch(colorPicker, /aria-label=["'][^"']+["']/, 'ColorPicker nao deve voltar a aria-label literal')

  assert.match(portalTour, /useTranslations\(['"]tour['"]\)/, 'PortalTour deve usar namespace tour')
  for (const key of ['close', 'skip', 'back', 'finish', 'next']) {
    assert.match(portalTour, new RegExp(`t\\(['"]${key}['"]\\)`), `PortalTour deve usar t('${key}')`)
  }
  assert.match(portalTour, /t\(`steps\.\$\{current\.key\}\.title`\)/, 'PortalTour deve traduzir titulo do passo')
  assert.match(portalTour, /t\(`steps\.\$\{current\.key\}\.body`\)/, 'PortalTour deve traduzir corpo do passo')
  assert.doesNotMatch(portalTour, />\s*(Pular|Voltar|Pr[oó]ximo|Concluir|Fechar)\s*</, 'PortalTour nao deve renderizar literais antigos')

  assert.match(buscaModalField, /useTranslations\(['"]common\.searchModal['"]\)/, 'BuscaModalField deve usar namespace searchModal')
  for (const key of ['search', 'noneSelected', 'clear', 'close', 'queryPlaceholder', 'searching', 'minChars', 'noResults']) {
    assert.match(buscaModalField, new RegExp(`t\\(['"]${key}['"]\\)`), `BuscaModalField deve usar t('${key}')`)
  }
  assert.doesNotMatch(buscaModalField, />\s*Buscar\s*</, 'BuscaModalField nao deve renderizar literal Buscar')
})

test('AC5: npm test executa a verificacao de locale da issue 76', () => {
  const pkg = readJson('package.json')
  assert.ok(pkg.scripts.test.includes('scripts/verify-issue76-i18n-locale.mjs'))
})
