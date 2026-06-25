import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { IntlProvider } from 'use-intl'
import { defaultLocale, readLocaleCookie, type Locale, writeLocaleCookie } from './locale'
import ptBR from './messages/pt-BR.json'
import enUS from './messages/en-US.json'

const messages: Record<Locale, typeof ptBR> = {
  'pt-BR': ptBR,
  'en-US': enUS,
}

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readLocaleCookie())

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    writeLocaleCookie(next)
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])

  return (
    <LocaleContext.Provider value={value}>
      <IntlProvider locale={locale} messages={messages[locale] ?? messages[defaultLocale]} timeZone="America/Sao_Paulo">
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  )
}

export function useLocale() {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale must be used within LocaleProvider')
  return value
}
