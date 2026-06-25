export type ThemeModePreference = 'light' | 'dark'

export interface UserPreferences {
  themeMode?: ThemeModePreference
  accent?: string
  hex?: string
  locale?: string
}

export const AUTH_STORAGE_KEY = 'dealernet-portal-auth'
export const PREFS_PREFIX = 'dealernet-portal-prefs:'
export const DEFAULT_USUARIO = 'default'
export const LEGACY_MODE_KEY = 'dealernet-portal-theme'
export const LEGACY_ACCENT_KEY = 'dealernet-portal-accent'
export const LEGACY_HEX_KEY = 'dealernet-portal-themehex'

type PreferencesPatch = Partial<UserPreferences>

interface StoredSession {
  usuario?: unknown
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

function normalizeUsuario(usuario?: string | null): string {
  const trimmed = usuario?.trim()
  return trimmed || DEFAULT_USUARIO
}

export function currentUsuario(): string {
  const storage = getStorage()
  if (!storage) return DEFAULT_USUARIO

  try {
    const raw = storage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return DEFAULT_USUARIO
    const parsed = JSON.parse(raw) as StoredSession
    return typeof parsed.usuario === 'string' ? normalizeUsuario(parsed.usuario) : DEFAULT_USUARIO
  } catch {
    return DEFAULT_USUARIO
  }
}

export function userPrefsKey(usuario?: string | null): string {
  return `${PREFS_PREFIX}${normalizeUsuario(usuario ?? currentUsuario())}`
}

function readPrefs(storage: Storage, usuario: string): UserPreferences {
  try {
    const raw = storage.getItem(userPrefsKey(usuario))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as UserPreferences) : {}
  } catch {
    return {}
  }
}

function writePrefs(storage: Storage, usuario: string, prefs: UserPreferences): boolean {
  try {
    storage.setItem(userPrefsKey(usuario), JSON.stringify(prefs))
    return true
  } catch {
    // localStorage pode estar indisponível ou sem cota; defaults em memória bastam.
    return false
  }
}

function safeRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // melhor esforço: a migração não pode quebrar o boot.
  }
}

export function migrateLegacyKeys(usuario?: string | null): void {
  const storage = getStorage()
  if (!storage) return

  const targetUsuario = normalizeUsuario(usuario ?? currentUsuario())
  const legacy: UserPreferences = {}

  try {
    const themeMode = storage.getItem(LEGACY_MODE_KEY)
    if (themeMode === 'light' || themeMode === 'dark') legacy.themeMode = themeMode
  } catch {
    // ignora chave legada inválida/indisponível
  }

  try {
    const accent = storage.getItem(LEGACY_ACCENT_KEY)
    if (accent) legacy.accent = accent
  } catch {
    // ignora chave legada inválida/indisponível
  }

  try {
    const hex = storage.getItem(LEGACY_HEX_KEY)
    if (hex) legacy.hex = hex
  } catch {
    // ignora chave legada inválida/indisponível
  }

  if (!legacy.themeMode && !legacy.accent && !legacy.hex) return

  const current = readPrefs(storage, targetUsuario)
  const next: UserPreferences = { ...current }
  if (!next.themeMode && legacy.themeMode) next.themeMode = legacy.themeMode
  if (!next.accent && legacy.accent) next.accent = legacy.accent
  if (!next.hex && legacy.hex) next.hex = legacy.hex
  if (writePrefs(storage, targetUsuario, next)) {
    safeRemove(storage, LEGACY_MODE_KEY)
    safeRemove(storage, LEGACY_ACCENT_KEY)
    safeRemove(storage, LEGACY_HEX_KEY)
  }
}

export function getUserPrefs(usuario?: string | null): UserPreferences {
  const storage = getStorage()
  if (!storage) return {}

  const targetUsuario = normalizeUsuario(usuario ?? currentUsuario())
  migrateLegacyKeys(targetUsuario)
  return readPrefs(storage, targetUsuario)
}

export function setUserPrefs(partial: PreferencesPatch, usuario?: string | null): UserPreferences {
  const storage = getStorage()
  if (!storage) return {}

  const targetUsuario = normalizeUsuario(usuario ?? currentUsuario())
  migrateLegacyKeys(targetUsuario)
  const next: UserPreferences = { ...readPrefs(storage, targetUsuario) }

  for (const [key, value] of Object.entries(partial) as [keyof UserPreferences, string | undefined][]) {
    if (value === undefined) {
      delete next[key]
      continue
    }
    if (key === 'themeMode' && (value === 'light' || value === 'dark')) next.themeMode = value
    else if (key === 'accent') next.accent = value
    else if (key === 'hex') next.hex = value
    else if (key === 'locale') next.locale = value
  }

  writePrefs(storage, targetUsuario, next)
  return next
}
