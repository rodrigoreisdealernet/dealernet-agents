// Verificacao dependency-free das preferencias por usuario do Portal (Issue #61).
//
// Roda com: node --test --experimental-strip-types scripts/verify-user-preferences.mjs
// Cada teste cita o criterio de aceite que verifica.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

let importCounter = 0

async function importUserPreferences(label) {
  const url = new URL('../src/portal/lib/userPreferences.ts', import.meta.url)
  url.searchParams.set('case', `${label}-${importCounter++}`)
  return import(url.href)
}

function createMemoryStorage(initialEntries = []) {
  const store = new Map(initialEntries)

  return {
    get length() {
      return store.size
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null
    },
    getItem(key) {
      const normalized = String(key)
      return store.has(normalized) ? store.get(normalized) : null
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    },
    removeItem(key) {
      store.delete(String(key))
    },
    clear() {
      store.clear()
    },
  }
}

function installMemoryStorage(initialEntries) {
  const storage = createMemoryStorage(initialEntries)
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    writable: true,
    configurable: true,
  })
  return storage
}

function removeStorage() {
  delete globalThis.localStorage
}

test.afterEach(() => {
  removeStorage()
})

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), 'utf8')
}

function storedJson(storage, key) {
  const raw = storage.getItem(key)
  assert.ok(raw, `valor esperado no localStorage para ${key}`)
  return JSON.parse(raw)
}

function setAuth(storage, authKey, usuario) {
  storage.setItem(authKey, JSON.stringify({ usuario, nome: usuario }))
}

test('AC1: preferencias de tema persistem no namespace do usuario e restauram em nova importacao', async () => {
  const storage = installMemoryStorage()
  const prefs = await importUserPreferences('ac1')
  const usuario = 'consultor.a'
  const expected = { themeMode: 'dark', accent: 'teal', hex: '#112233' }

  assert.equal(prefs.userPrefsKey(usuario), `${prefs.PREFS_PREFIX}${usuario}`)

  assert.deepEqual(prefs.setUserPrefs(expected, usuario), expected)
  assert.deepEqual(storedJson(storage, prefs.userPrefsKey(usuario)), expected)
  assert.deepEqual(prefs.getUserPrefs(usuario), expected)

  const restartedPrefs = await importUserPreferences('ac1-restart')
  assert.deepEqual(restartedPrefs.getUserPrefs(usuario), expected)
})

test('AC2: usuarios diferentes ficam isolados e a identidade atual seleciona o namespace correto', async () => {
  const storage = installMemoryStorage()
  const prefs = await importUserPreferences('ac2')
  const usuarioA = 'usuario.a'
  const usuarioB = 'usuario.b'

  setAuth(storage, prefs.AUTH_STORAGE_KEY, usuarioA)
  assert.equal(prefs.currentUsuario(), usuarioA)
  assert.deepEqual(prefs.setUserPrefs({ themeMode: 'dark', accent: 'red' }), {
    themeMode: 'dark',
    accent: 'red',
  })

  setAuth(storage, prefs.AUTH_STORAGE_KEY, usuarioB)
  assert.equal(prefs.currentUsuario(), usuarioB)
  assert.deepEqual(prefs.setUserPrefs({ themeMode: 'light', accent: 'blue', hex: '#010203' }), {
    themeMode: 'light',
    accent: 'blue',
    hex: '#010203',
  })

  assert.notEqual(prefs.userPrefsKey(usuarioA), prefs.userPrefsKey(usuarioB))
  assert.deepEqual(storedJson(storage, prefs.userPrefsKey(usuarioA)), {
    themeMode: 'dark',
    accent: 'red',
  })
  assert.deepEqual(storedJson(storage, prefs.userPrefsKey(usuarioB)), {
    themeMode: 'light',
    accent: 'blue',
    hex: '#010203',
  })
  assert.deepEqual(prefs.getUserPrefs(), {
    themeMode: 'light',
    accent: 'blue',
    hex: '#010203',
  })

  setAuth(storage, prefs.AUTH_STORAGE_KEY, usuarioA)
  assert.equal(prefs.currentUsuario(), usuarioA)
  assert.deepEqual(prefs.getUserPrefs(), { themeMode: 'dark', accent: 'red' })
})

test('AC3: useTheme preserva a API publica consumida pelo portal', () => {
  const source = read('src/hooks/use-theme.ts')
  const hookSource = source.slice(source.indexOf('export function useTheme'))
  const returnBlock = /return\s*\{([\s\S]*?)\n\s*\}/.exec(hookSource)?.[1] ?? ''

  for (const key of [
    'theme',
    'setTheme',
    'toggleTheme',
    'accent',
    'setAccent',
    'hex',
    'setHex',
    'aplicarMarcaSeSemOverride',
    'aplicarHexMarcaSeSemOverride',
  ]) {
    assert.match(returnBlock, new RegExp(`\\b${key}\\b`), `useTheme deve retornar ${key}`)
  }
})

test('AC4: migracao legada copia chaves globais sem sobrescrever preferencias existentes', async () => {
  let storage = installMemoryStorage()
  const prefs = await importUserPreferences('ac4')
  const usuario = 'legado.vazio'

  storage.setItem(prefs.LEGACY_MODE_KEY, 'dark')
  storage.setItem(prefs.LEGACY_ACCENT_KEY, 'green')
  storage.setItem(prefs.LEGACY_HEX_KEY, '#445566')

  assert.deepEqual(prefs.getUserPrefs(usuario), {
    themeMode: 'dark',
    accent: 'green',
    hex: '#445566',
  })
  assert.deepEqual(storedJson(storage, prefs.userPrefsKey(usuario)), {
    themeMode: 'dark',
    accent: 'green',
    hex: '#445566',
  })
  assert.equal(storage.getItem(prefs.LEGACY_MODE_KEY), 'dark')
  assert.equal(storage.getItem(prefs.LEGACY_ACCENT_KEY), 'green')
  assert.equal(storage.getItem(prefs.LEGACY_HEX_KEY), '#445566')

  storage = installMemoryStorage()
  const usuarioComPrefs = 'legado.existente'
  storage.setItem(
    prefs.userPrefsKey(usuarioComPrefs),
    JSON.stringify({ themeMode: 'light', accent: 'navy' }),
  )
  storage.setItem(prefs.LEGACY_MODE_KEY, 'dark')
  storage.setItem(prefs.LEGACY_ACCENT_KEY, 'teal')
  storage.setItem(prefs.LEGACY_HEX_KEY, '#ABCDEF')

  assert.deepEqual(prefs.getUserPrefs(usuarioComPrefs), {
    themeMode: 'light',
    accent: 'navy',
    hex: '#ABCDEF',
  })
})

test('AC4 + AC2: migracao legada sequencial preserva chaves globais para cada usuario', async () => {
  const storage = installMemoryStorage()
  const prefs = await importUserPreferences('ac4-ac2-sequencial')
  const usuarioA = 'legacy.userA'
  const usuarioB = 'legacy.userB'
  const expected = { themeMode: 'dark', accent: 'green', hex: '#445566' }

  storage.setItem(prefs.LEGACY_MODE_KEY, expected.themeMode)
  storage.setItem(prefs.LEGACY_ACCENT_KEY, expected.accent)
  storage.setItem(prefs.LEGACY_HEX_KEY, expected.hex)

  setAuth(storage, prefs.AUTH_STORAGE_KEY, usuarioA)
  assert.deepEqual(prefs.getUserPrefs(), expected)
  assert.deepEqual(storedJson(storage, prefs.userPrefsKey(usuarioA)), expected)
  assert.equal(storage.getItem(prefs.LEGACY_MODE_KEY), expected.themeMode)
  assert.equal(storage.getItem(prefs.LEGACY_ACCENT_KEY), expected.accent)
  assert.equal(storage.getItem(prefs.LEGACY_HEX_KEY), expected.hex)

  setAuth(storage, prefs.AUTH_STORAGE_KEY, usuarioB)
  assert.deepEqual(prefs.getUserPrefs(), expected)
  assert.deepEqual(storedJson(storage, prefs.userPrefsKey(usuarioB)), expected)

  assert.notEqual(prefs.userPrefsKey(usuarioA), prefs.userPrefsKey(usuarioB))
  assert.deepEqual(storedJson(storage, prefs.userPrefsKey(usuarioA)), expected)
  assert.deepEqual(storedJson(storage, prefs.userPrefsKey(usuarioB)), expected)
  assert.equal(storage.getItem(prefs.LEGACY_MODE_KEY), expected.themeMode)
  assert.equal(storage.getItem(prefs.LEGACY_ACCENT_KEY), expected.accent)
  assert.equal(storage.getItem(prefs.LEGACY_HEX_KEY), expected.hex)
})

test('AC5: localStorage ausente ou JSON invalido retorna defaults seguros sem excecao', async () => {
  removeStorage()
  const prefsWithoutStorage = await importUserPreferences('ac5-sem-storage')

  assert.doesNotThrow(() => prefsWithoutStorage.currentUsuario())
  assert.equal(prefsWithoutStorage.currentUsuario(), prefsWithoutStorage.DEFAULT_USUARIO)
  assert.doesNotThrow(() => prefsWithoutStorage.getUserPrefs('offline'))
  assert.deepEqual(prefsWithoutStorage.getUserPrefs('offline'), {})
  assert.doesNotThrow(() => prefsWithoutStorage.setUserPrefs({ themeMode: 'dark' }, 'offline'))
  assert.deepEqual(prefsWithoutStorage.setUserPrefs({ themeMode: 'dark' }, 'offline'), {})

  const storage = installMemoryStorage()
  const prefs = await importUserPreferences('ac5-json-invalido')
  storage.setItem(prefs.userPrefsKey('json.quebrado'), '{nao-json')
  storage.setItem(prefs.AUTH_STORAGE_KEY, '{usuario')

  assert.doesNotThrow(() => prefs.getUserPrefs('json.quebrado'))
  assert.deepEqual(prefs.getUserPrefs('json.quebrado'), {})
  assert.doesNotThrow(() => prefs.currentUsuario())
  assert.equal(prefs.currentUsuario(), prefs.DEFAULT_USUARIO)
})

test('AC6: campo locale persiste e restaura na camada de preferencias por usuario', async () => {
  installMemoryStorage()
  const prefs = await importUserPreferences('ac6')
  const usuario = 'i18n.usuario'

  assert.deepEqual(prefs.setUserPrefs({ locale: 'pt-BR' }, usuario), { locale: 'pt-BR' })
  assert.equal(prefs.getUserPrefs(usuario).locale, 'pt-BR')

  const restartedPrefs = await importUserPreferences('ac6-restart')
  assert.equal(restartedPrefs.getUserPrefs(usuario).locale, 'pt-BR')
})

test('AC7: verify-user-preferences.mjs esta registrado no npm test dependency-free', () => {
  const pkg = JSON.parse(read('package.json'))

  assert.match(pkg.scripts.test, /node --test --experimental-strip-types/)
  assert.ok(
    pkg.scripts.test.includes('scripts/verify-user-preferences.mjs'),
    'npm test deve executar scripts/verify-user-preferences.mjs',
  )
})
