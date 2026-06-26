// Verificacao dependency-free do wiring i18n do Portal — Issue #58.
//
// Testes estruturais sobre texto-fonte, seguindo o padrao dos scripts verify-*:
// sem vitest/jsdom/node_modules, apenas node:test/node:assert/node:fs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

function messages(locale) {
  return JSON.parse(read(`src/i18n/messages/${locale}.json`))
}

const pt = messages('pt-BR')
const en = messages('en-US')

function getPath(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj)
}

function assertMessageKey(path) {
  assert.notEqual(getPath(pt, path), undefined, `pt-BR deve conter a chave ${path}`)
  assert.notEqual(getPath(en, path), undefined, `en-US deve conter a chave ${path}`)
}

function literalCalls(source, fnName) {
  const re = new RegExp(`\\b${fnName}\\(\\s*['\"]([^'\"]+)['\"]`, 'g')
  return [...source.matchAll(re)].map((match) => match[1])
}

function useTranslationsAliases(source) {
  const re = /const\s+(\w+)\s*=\s*useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g
  return [...source.matchAll(re)].map((match) => ({ alias: match[1], namespace: match[2] }))
}

function extractMenuArraySource(source, constName) {
  const marker = `const ${constName}: MenuItem[] = applyMenuTranslationKeys([`
  const start = source.indexOf(marker)
  assert.ok(start !== -1, `${constName} deve usar applyMenuTranslationKeys([...])`)
  const callStart = source.indexOf('applyMenuTranslationKeys([', start)
  assert.ok(callStart !== -1, `${constName} deve chamar applyMenuTranslationKeys([...])`)
  const bodyStart = source.indexOf('[', callStart)
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  assert.fail(`nao foi possivel encontrar o fim de ${constName}`)
}

function menuIdsFromSource(source) {
  const ids = [...source.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.ok(ids.length > 0, 'esperado encontrar ids de menu')
  return ids
}

// AC5: o npm test precisa executar automaticamente as verificacoes i18n.
test('AC5: package.json registra os scripts verify-i18n no npm test', () => {
  const pkg = JSON.parse(read('package.json'))
  const script = pkg.scripts?.test ?? ''
  assert.ok(script.includes('scripts/verify-i18n-parity.mjs'), 'npm test deve executar verify-i18n-parity.mjs')
  assert.ok(script.includes('scripts/verify-i18n-wiring.mjs'), 'npm test deve executar verify-i18n-wiring.mjs')
})

// AC1/AC3: default pt-BR, locales suportadas e persistencia por cookie.
test('AC1/AC3: locale.ts define default pt-BR, locales suportadas e helpers de cookie', () => {
  const src = read('src/i18n/locale.ts')
  assert.match(src, /export const defaultLocale\s*=\s*['"]pt-BR['"]/, 'defaultLocale deve ser pt-BR')
  assert.match(src, /export const locales\s*=\s*\[[^\]]*['"]pt-BR['"][^\]]*['"]en-US['"][^\]]*\]/, 'locales deve listar pt-BR e en-US')
  assert.match(src, /export const localeCookieName\s*=\s*['"]portal_locale['"]/, 'cookie deve se chamar portal_locale')
  for (const fn of ['resolveLocale', 'parseLocaleCookie', 'readLocaleCookie', 'writeLocaleCookie']) {
    assert.match(src, new RegExp(`export function ${fn}\\s*\\(`), `locale.ts deve exportar ${fn}`)
  }
  assert.match(src, /parseLocaleCookie\(document\.cookie\)/, 'readLocaleCookie deve restaurar locale a partir de document.cookie')
  assert.match(src, /document\.cookie\s*=\s*`\$\{localeCookieName\}=\$\{encodeURIComponent\(locale\)\}/, 'writeLocaleCookie deve persistir portal_locale')
})

// AC2/AC3/AC4: provider no topo da arvore com IntlProvider e troca imediata.
// Observacao: o harness do repo e source-text only (sem jsdom/RTL), entao o
// roundtrip real de DOM/cookie fica fora de escopo; estas assercoes travam o
// wiring que implementa o comportamento.
test('AC2/AC3/AC4: LocaleProvider envolve a aplicacao e atualiza cookie + html.lang', () => {
  const provider = read('src/i18n/LocaleProvider.tsx')
  const app = read('src/App.tsx')
  assert.match(provider, /import \{ IntlProvider \} from ['"]use-intl['"]/, 'LocaleProvider deve usar IntlProvider de use-intl')
  assert.match(provider, /useState<Locale>\(\(\) => readLocaleCookie\(\)\)/, 'locale inicial deve vir do cookie/default')
  assert.match(provider, /writeLocaleCookie\(next\)/, 'setLocale deve gravar cookie')
  assert.match(provider, /document\.documentElement\.lang\s*=\s*next/, 'setLocale deve atualizar documentElement.lang imediatamente')
  assert.match(provider, /document\.documentElement\.lang\s*=\s*locale/, 'efeito deve manter documentElement.lang sincronizado')
  assert.match(provider, /<IntlProvider\s+locale=\{locale\}\s+messages=\{messages\[locale\]\s*\?\?\s*messages\[defaultLocale\]\}/, 'IntlProvider deve receber locale e mensagens com fallback pt-BR')
  assert.match(app, /<LocaleProvider>[\s\S]*<AuthProvider>[\s\S]*<Gate \/>[\s\S]*<\/AuthProvider>[\s\S]*<\/LocaleProvider>/, 'App deve envolver a arvore autenticada com LocaleProvider')
})

// AC2: seletor visivel no TopBar, com labels traduzidos e troca sem reload.
test('AC2: TopBar renderiza seletor de idioma pt-BR/en-US que chama setLocale', () => {
  const src = read('src/portal/components/TopBar.tsx')
  assert.match(src, /import \{ locales \} from ['"]@\/i18n\/locale['"]/, 'TopBar deve consumir a lista canonica de locales')
  assert.match(src, /const \{ locale, setLocale \} = useLocale\(\)/, 'TopBar deve ler locale/setLocale do contexto')
  assert.match(src, /<LocaleFlag\s+locale=\{locale\}\s*\/>/, 'seletor deve exibir a bandeira da lingua atual no trigger (apenas bandeira — issue #129)')
  assert.match(src, /title=\{t\(['"]language['"]\)\}/, 'trigger deve usar a chave shell.language')
  assert.match(src, /locales\.map\(\(option\) => \(/, 'seletor deve renderizar todas as locales suportadas')
  assert.match(src, /onSelect=\{\(\) => setLocale\(option\)\}/, 'selecionar uma opcao deve chamar setLocale sem reload')
  assert.match(src, /\{tLocale\(option\)\}/, 'labels das opcoes devem vir do namespace locale')
  assert.equal(pt.locale['pt-BR'], 'Português (Brasil)', 'pt-BR deve mostrar Portugues (Brasil)')
  assert.equal(pt.locale['en-US'], 'English (US)', 'pt-BR deve mostrar English (US)')
  assert.equal(en.locale['pt-BR'], 'Portuguese (Brazil)', 'en-US deve mostrar Portuguese (Brazil)')
  assert.equal(en.locale['en-US'], 'English (US)', 'en-US deve mostrar English (US)')
})

// AC1/AC4: menus mock/extra sao decorados com chaves e renderizados via traducoes.
test('AC1/AC4: menus usam labelKey/titleKey e componentes renderizam titulos traduzidos', () => {
  const portalApi = read('src/portal/lib/portalApi.ts')
  const portalApiReal = read('src/portal/lib/portalApiReal.ts')
  const menuKeys = read('src/i18n/menuKeys.ts')
  const menu = read('src/i18n/menu.ts')
  const sidebar = read('src/portal/components/Sidebar.tsx')
  const win = read('src/portal/components/Window.tsx')
  const tabs = read('src/portal/components/TabsView.tsx')
  const compact = read('src/portal/components/CompactWindows.tsx')
  const statusBar = read('src/portal/components/StatusBar.tsx')

  assert.match(portalApi, /const MOCK_MENU: MenuItem\[\] = applyMenuTranslationKeys\(\[/, 'MOCK_MENU deve ser decorado com chaves i18n')
  assert.match(portalApiReal, /const EXTRA_MENU: MenuItem\[\] = applyMenuTranslationKeys\(\[/, 'EXTRA_MENU deve ser decorado com chaves i18n')
  assert.match(menuKeys, /labelKey:\s*item\.labelKey\s*\?\?\s*item\.id/, 'labelKey deve cair para o id do item')
  assert.match(menuKeys, /titleKey:\s*item\.spec\.titleKey\s*\?\?\s*item\.id/, 'titleKey deve cair para o id do item')
  assert.match(menu, /item\.labelKey \? t\(item\.labelKey\) : item\.text/, 'labels de menu devem preferir t(labelKey)')
  assert.match(menu, /spec\.titleKey \? t\(spec\.titleKey\) : spec\.title/, 'titulos de janela devem preferir t(titleKey)')
  assert.match(sidebar, /localizeMenuTree\(rawMenu, tMenu\)/, 'Sidebar deve localizar a arvore antes de renderizar')
  assert.match(win, /const title = translateWindowTitle\(win, tMenu\)/, 'Window deve traduzir o titulo renderizado')
  assert.match(tabs, /const title = translateWindowTitle\(tab, tMenu\)/, 'TabsView deve traduzir o titulo renderizado')
  assert.match(compact, /translateWindowTitle\(w, tMenu\)/, 'CompactWindows deve traduzir o titulo renderizado')
  assert.match(statusBar, /translateWindowTitle\(w, tMenu\)/, 'StatusBar deve traduzir janelas minimizadas')
  assert.match(statusBar, /translateBookmarkTitle\(b, tMenu\)/, 'StatusBar deve traduzir favoritos')
})

// AC1: todo id de MOCK_MENU/EXTRA_MENU vira menu.<id>; se faltar, use-intl
// exibiria chave crua para o usuario.
test('AC1/AC4: todas as chaves de menu referenciadas existem em pt-BR e en-US', () => {
  const mockMenu = extractMenuArraySource(read('src/portal/lib/portalApi.ts'), 'MOCK_MENU')
  const extraMenu = extractMenuArraySource(read('src/portal/lib/portalApiReal.ts'), 'EXTRA_MENU')
  const ids = [...new Set([...menuIdsFromSource(mockMenu), ...menuIdsFromSource(extraMenu)])].sort()

  assert.ok(ids.length >= 30, `esperado cobrir menu mock+extra amplo; encontrados ${ids.length}`)
  for (const id of ids) {
    assertMessageKey(`menu.${id}`)
  }
})

// AC1: os menus ainda mantem texto fallback para compatibilidade, mas o label
// exibido no Portal vem de menu.<id>. Estes casos eram os literais mistos mais
// visiveis; em pt-BR eles nao podem ser o texto exibido por default.
test('AC1: literais legados de menu nao sao os labels exibidos em pt-BR', () => {
  const legacyLabels = [
    ['ai-ops', 'AI Operations'],
    ['morning-brief-owner', 'Morning Brief'],
    ['ai-morning-queue', 'Fila de Findings'],
  ]

  for (const [id, oldLiteral] of legacyLabels) {
    assertMessageKey(`menu.${id}`)
    assert.notEqual(pt.menu[id], oldLiteral, `menu.${id} em pt-BR nao deve exibir o literal legado '${oldLiteral}'`)
  }
})

// AC4: telas representativas usam useTranslations e todas as t('...')/common('...')
// estaticas apontam para chaves existentes. Isto captura typos que renderizariam
// chaves cruas como shell.signOut/screens.foo.bar para o usuario.
test('AC4: chaves usadas em telas representativas existem em pt-BR e en-US', () => {
  const screens = [
    'src/portal/renderers/screens/BrandsCrud.tsx',
    'src/portal/renderers/screens/PartsBI.tsx',
    'src/portal/renderers/screens/PartsInventory.tsx',
    'src/portal/renderers/screens/ServiceDashboard.tsx',
    'src/portal/renderers/screens/ServiceOrders.tsx',
    'src/portal/renderers/screens/UsersAdmin.tsx',
    'src/portal/renderers/screens/MorningBrief.tsx',
    'src/portal/renderers/screens/CompaniesCrud.tsx',
    'src/portal/renderers/screens/SalesDashboard.tsx',
  ]

  for (const relPath of screens) {
    const src = read(relPath)
    const aliases = useTranslationsAliases(src)
    assert.ok(aliases.length > 0, `${relPath} deve usar useTranslations(...)`)

    let staticKeyCount = 0
    for (const { alias, namespace } of aliases) {
      assertMessageKey(namespace)
      for (const key of literalCalls(src, alias)) {
        staticKeyCount += 1
        assertMessageKey(`${namespace}.${key}`)
      }
    }
    assert.ok(staticKeyCount > 0, `${relPath} deve ter chamadas estaticas t('...') verificaveis`)
  }
})

// AC4: constantes I18N_PT_* podem existir como referencias/test fixtures, mas nao
// podem ser usadas diretamente no JSX como texto de UI traduzivel.
test('AC4: constantes portuguesas de referencia nao sao renderizadas em JSX', () => {
  const screens = [
    'src/portal/renderers/screens/PartsBI.tsx',
    'src/portal/renderers/screens/BrandsCrud.tsx',
    'src/portal/renderers/screens/PartsInventory.tsx',
    'src/portal/renderers/screens/ServiceDashboard.tsx',
    'src/portal/renderers/screens/ServiceOrders.tsx',
    'src/portal/renderers/screens/UsersAdmin.tsx',
  ]

  for (const relPath of screens) {
    const src = read(relPath)
    const renderedRefs = src.match(/=\{\s*I18N_PT_[A-Z0-9_]+\s*\}|>\s*\{\s*I18N_PT_[A-Z0-9_]+\s*\}\s*</g) ?? []
    assert.deepEqual(renderedRefs, [], `${relPath} nao deve renderizar constantes I18N_PT_*: ${renderedRefs.join(', ')}`)
  }
})

// AC5: namespaces previstos pela spec estao presentes nos dois arquivos.
test('AC5: mensagens contem namespaces locale/common/shell/menu/screens', () => {
  for (const namespace of ['locale', 'common', 'shell', 'menu', 'screens']) {
    assertMessageKey(namespace)
  }
})
