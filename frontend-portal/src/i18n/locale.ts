export const defaultLocale = 'pt-BR'
export const locales = ['pt-BR', 'en-US'] as const
export type Locale = (typeof locales)[number]

export const localeCookieName = 'portal_locale'

export function resolveLocale(value: unknown): Locale {
  return locales.includes(value as Locale) ? (value as Locale) : defaultLocale
}

export function parseLocaleCookie(cookieHeader: string | null | undefined): Locale {
  if (!cookieHeader) return defaultLocale

  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${localeCookieName}=`))

  if (!cookie) return defaultLocale
  return resolveLocale(decodeURIComponent(cookie.slice(localeCookieName.length + 1)))
}

export function readLocaleCookie(): Locale {
  if (typeof document === 'undefined') return defaultLocale
  return parseLocaleCookie(document.cookie)
}

export function writeLocaleCookie(locale: Locale) {
  if (typeof document === 'undefined') return
  const maxAge = 60 * 60 * 24 * 365
  document.cookie = `${localeCookieName}=${encodeURIComponent(locale)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`
}
