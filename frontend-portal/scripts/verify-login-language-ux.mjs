// Verificacao dependency-free do issue #129: login obriga usuario/senha e o
// seletor de idioma do TopBar mostra apenas a bandeira. Asserta sobre o
// TEXTO-FONTE; nao precisa de node_modules nem de render.
//
// Roda com: node --test scripts/verify-login-language-ux.mjs
//
// Cada teste traz no nome o(s) criterio(s) de aceite (spec
// docs/specs/129-corrigir-login-obrigar-usuario-senha.md) que verifica.

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

const LOGIN = 'src/portal/components/Login.tsx'
const TOPBAR = 'src/portal/components/TopBar.tsx'

// Extrai exatamente UM trecho que casa o regex; falha se houver 0 ou >1.
function extractOne(src, regex, label) {
  const matches = src.match(regex)
  assert.ok(matches, `nao encontrei o trecho esperado: ${label}`)
  assert.equal(matches.length, 1, `esperava exatamente 1 ${label}, achei ${matches.length}`)
  return matches[0]
}

// ---------------------------------------------------------------------------
// AC1/AC2: o <motion.form> de login NAO tem mais `noValidate`, de modo que a
// validacao nativa do browser (campos `required`) volta a barrar submissoes
// vazias; com ambos preenchidos o fluxo segue normalmente (required nao bloqueia).
// ---------------------------------------------------------------------------
test('AC1/AC2 Login: <motion.form> nao usa noValidate (validacao nativa ativa)', () => {
  const src = read(LOGIN)

  // Tag de abertura do form de login: de `<motion.form` ate o primeiro `>`.
  const formOpenTag = extractOne(src, /<motion\.form\b[\s\S]*?>/g, 'tag de abertura <motion.form>')

  assert.ok(/onSubmit=\{handleSubmit\}/.test(formOpenTag), 'o form de login deve ter onSubmit={handleSubmit}')
  assert.doesNotMatch(
    formOpenTag,
    /noValidate/,
    'a tag de abertura do <motion.form> de login NAO pode conter noValidate (senao a validacao nativa fica desligada)',
  )
})

test('AC1 Login: inputs de usuario e senha mantem o atributo required', () => {
  const src = read(LOGIN)

  const usuarioInput = extractOne(src, /<input\b[\s\S]*?id="usuario"[\s\S]*?\/>/g, 'input de usuario')
  const senhaInput = extractOne(src, /<input\b[\s\S]*?id="senha"[\s\S]*?\/>/g, 'input de senha')

  assert.match(usuarioInput, /\brequired\b/, 'o input de usuario deve continuar com required')
  assert.match(senhaInput, /\brequired\b/, 'o input de senha deve continuar com required')
})

// ---------------------------------------------------------------------------
// Helpers para escopar o trigger vs a lista do seletor de idioma no TopBar.
// ---------------------------------------------------------------------------
function languageTriggerRegion(src) {
  // O trigger do idioma e o unico DropdownMenu.Trigger com title={t('language')}.
  return extractOne(
    src,
    /<DropdownMenu\.Trigger\b[^>]*title=\{t\('language'\)\}[\s\S]*?<\/DropdownMenu\.Trigger>/g,
    "DropdownMenu.Trigger do idioma (title={t('language')})",
  )
}

function localesListRegion(src) {
  // A lista do dropdown: o bloco {locales.map((option) => ( ... ))}.
  return extractOne(
    src,
    /\{locales\.map\(\(option\)\s*=>\s*\([\s\S]*?\)\)\}/g,
    'bloco {locales.map((option) => (...))}',
  )
}

// ---------------------------------------------------------------------------
// AC3: o TRIGGER do seletor de idioma renderiza SOMENTE a bandeira atual:
//      tem <LocaleFlag locale={locale}/>, e NAO tem o icone <Languages> nem o
//      span com o codigo de locale (pt-BR / en-US).
// ---------------------------------------------------------------------------
test('AC3 TopBar: o trigger do idioma renderiza apenas <LocaleFlag>, sem icone nem codigo', () => {
  const src = read(TOPBAR)
  const trigger = languageTriggerRegion(src)

  // Bandeira da lingua atual presente, refletindo o locale corrente.
  assert.match(trigger, /<LocaleFlag\b/, 'o trigger deve renderizar <LocaleFlag />')
  assert.match(trigger, /<LocaleFlag\s+locale=\{locale\}/, 'a bandeira do trigger deve usar o locale atual (locale={locale})')

  // Sem o icone <Languages> que liderava o trigger.
  assert.doesNotMatch(trigger, /<Languages\b/, 'o trigger NAO pode renderizar o icone <Languages>')

  // Sem o <span> que exibia o codigo de locale (ex.: >{locale}</span>).
  assert.doesNotMatch(trigger, /<span\b/, 'o trigger NAO pode conter <span> (codigo de locale removido)')
  assert.doesNotMatch(trigger, />\s*\{locale\}\s*</, 'o trigger NAO pode renderizar o codigo {locale} como texto')
})

test('AC3 TopBar: o import do icone Languages foi removido (regressao de limpeza)', () => {
  const src = read(TOPBAR)
  // Nao deve mais importar Languages do lucide-react.
  const lucideImport = extractOne(
    src,
    /import\s+\{[\s\S]*?\}\s+from\s+'lucide-react'/g,
    "import de 'lucide-react'",
  )
  assert.doesNotMatch(lucideImport, /\bLanguages\b/, "Languages nao pode mais ser importado de 'lucide-react'")
})

// ---------------------------------------------------------------------------
// AC4: a LISTA do dropdown permanece intacta — cada opcao mapeia para
//      bandeira (<LocaleFlag locale={option}/>) + nome do idioma (tLocale(option))
//      e selecionar a opcao troca o idioma (setLocale(option)).
// ---------------------------------------------------------------------------
test('AC4 TopBar: a lista do dropdown mapeia cada locale para bandeira + nome e troca o idioma', () => {
  const src = read(TOPBAR)
  const list = localesListRegion(src)

  // Itera sobre todos os locales suportados.
  assert.match(list, /<DropdownMenu\.Item\b/, 'a lista deve renderizar DropdownMenu.Item por opcao')
  // Bandeira de cada opcao.
  assert.match(list, /<LocaleFlag\s+locale=\{option\}/, 'cada item da lista deve mostrar a bandeira da opcao (<LocaleFlag locale={option} />)')
  // Nome do idioma (rotulo localizado).
  assert.match(list, /\{tLocale\(option\)\}/, 'cada item da lista deve mostrar o nome do idioma (tLocale(option))')
  // Selecionar a opcao troca o idioma.
  assert.match(list, /onSelect=\{\(\)\s*=>\s*setLocale\(option\)\}/, 'selecionar um item deve chamar setLocale(option)')
})
