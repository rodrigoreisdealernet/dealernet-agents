import { useEffect, useState } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { DEFAULT_USUARIO, getUserPrefs, setUserPrefs, type UserPreferences } from '@/portal/lib/userPreferences'

type Mode = 'light' | 'dark'
export type Accent =
  | 'navy'
  | 'blue'
  | 'teal'
  | 'violet'
  | 'green'
  | 'red'
  | 'orange'
  | 'amber'
  | 'magenta'
  | 'slate'

// Paleta de cores do PORTAL (accent + chrome). Cada cor define um hue OKLCH; o tema
// deriva --primary (destaques) e --chrome (sidebar/topbar) a partir dele.
// Ampliada a pedido do cliente: além das frias sóbrias, cores de marca (vermelho FIAT,
// azul GM, etc). lightness/croma travados garantem contraste/legibilidade.
export const ACCENTS: { id: Accent; label: string; hue: number; chroma: number; swatch: string }[] = [
  { id: 'navy', label: 'Navy', hue: 245, chroma: 0.12, swatch: 'oklch(0.40 0.12 245)' },
  { id: 'blue', label: 'Azul Dealernet', hue: 258, chroma: 0.15, swatch: 'oklch(0.45 0.15 258)' },
  { id: 'teal', label: 'Teal', hue: 195, chroma: 0.11, swatch: 'oklch(0.50 0.11 195)' },
  { id: 'green', label: 'Verde', hue: 150, chroma: 0.12, swatch: 'oklch(0.48 0.12 150)' },
  { id: 'violet', label: 'Violeta', hue: 290, chroma: 0.14, swatch: 'oklch(0.48 0.14 290)' },
  { id: 'magenta', label: 'Magenta', hue: 340, chroma: 0.15, swatch: 'oklch(0.50 0.15 340)' },
  { id: 'red', label: 'Vermelho', hue: 25, chroma: 0.17, swatch: 'oklch(0.52 0.17 25)' },
  { id: 'orange', label: 'Laranja', hue: 50, chroma: 0.15, swatch: 'oklch(0.58 0.15 50)' },
  { id: 'amber', label: 'Âmbar', hue: 75, chroma: 0.13, swatch: 'oklch(0.62 0.13 75)' },
  { id: 'slate', label: 'Grafite', hue: 250, chroma: 0.03, swatch: 'oklch(0.42 0.03 250)' },
]

// Mapa MARCA (sigla) → cor padrão do portal. Espelha a tabela Tema do ERP
// (FIAT=gray/purple, GM=blue, VOLKS=volks, RENAULT=gray). Traduzimos os nomes
// legados p/ a paleta nova. Marca sem mapa cai no default 'navy'.
export const MARCA_ACCENT: Record<string, Accent> = {
  FIAT: 'red', // FIAT = vermelho da marca
  GM: 'blue',
  VOLKS: 'navy', // 'volks' legado ~ azul-escuro
  VW: 'navy',
  RENAULT: 'amber', // losango amarelo
  HYUNDAI: 'slate',
  TOYOTA: 'red',
}

const HEX_RX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function getSystemMode(): Mode {
  try {
    if (typeof window === 'undefined') return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function isMode(value: UserPreferences['themeMode']): value is Mode {
  return value === 'light' || value === 'dark'
}

function isAccent(value: UserPreferences['accent']): value is Accent {
  return ACCENTS.some((a) => a.id === value)
}

function loadThemePrefs(usuario?: string | null): { theme: Mode; accent: Accent; hex: string } {
  const prefs = getUserPrefs(usuario)
  return {
    theme: isMode(prefs.themeMode) ? prefs.themeMode : getSystemMode(),
    accent: isAccent(prefs.accent) ? prefs.accent : 'navy',
    hex: prefs.hex && HEX_RX.test(prefs.hex) ? prefs.hex : '',
  }
}

/** Resolve a cor padrão de uma marca (sigla). Default 'navy' se não mapeada. */
export function accentDaMarca(marcaSgl?: string): Accent {
  if (!marcaSgl) return 'navy'
  return MARCA_ACCENT[marcaSgl.trim().toUpperCase()] ?? 'navy'
}

/** Aplica a cor: redefine --primary (destaques) E --chrome (sidebar/topbar). */
function applyAccent(accent: Accent) {
  const def = ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0]
  const root = document.documentElement
  const { hue, chroma } = def
  // Primário (botões, links, foco) — lightness/croma do DS, variando o hue.
  root.style.setProperty('--primary', `oklch(0.45 ${chroma} ${hue})`)
  root.style.setProperty('--primary-hover', `oklch(0.41 ${chroma} ${hue})`)
  root.style.setProperty('--primary-active', `oklch(0.36 ${chroma} ${hue})`)
  root.style.setProperty('--ring', `color-mix(in oklch, oklch(0.45 ${chroma} ${hue}) 38%, transparent)`)
  // Chrome (sidebar/topbar) — versão ESCURA da cor, p/ texto branco ter contraste.
  root.style.setProperty('--chrome', `oklch(0.32 ${Math.min(chroma, 0.10)} ${hue})`)
}

/** Aplica a cor a partir de um HEX direto (tema por marca vindo da API). Deriva --primary
 *  e --chrome via color-mix em oklch (o navegador converte o hex). Hover/active escurecem;
 *  chrome = hex bem escurecido p/ texto branco. Aceita #RRGGBB e #RRGGBBAA. */
function applyHex(hex: string) {
  const root = document.documentElement
  root.style.setProperty('--primary', hex)
  root.style.setProperty('--primary-hover', `color-mix(in oklch, ${hex} 88%, black)`)
  root.style.setProperty('--primary-active', `color-mix(in oklch, ${hex} 76%, black)`)
  root.style.setProperty('--ring', `color-mix(in oklch, ${hex} 38%, transparent)`)
  root.style.setProperty('--chrome', `color-mix(in oklch, ${hex} 55%, black)`)
}

export function useTheme() {
  const { session } = useAuth()
  const authUsuario = session?.usuario ?? DEFAULT_USUARIO
  const initialPrefs = () => loadThemePrefs(authUsuario)
  const [prefsUsuario, setPrefsUsuario] = useState(authUsuario)
  const [theme, setTheme] = useState<Mode>(() => initialPrefs().theme)
  const [accent, setAccentState] = useState<Accent>(() => initialPrefs().accent)
  // Cor hex tem PRIORIDADE: se setada, pinta por hex; senão cai no accent (paleta fixa).
  const [hex, setHexState] = useState<string>(() => initialPrefs().hex)

  useEffect(() => {
    const next = loadThemePrefs(authUsuario)
    setPrefsUsuario(authUsuario)
    setTheme(next.theme)
    setAccentState(next.accent)
    setHexState(next.hex)
  }, [authUsuario])

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme)
    }
    setUserPrefs({ themeMode: theme }, prefsUsuario)
  }, [prefsUsuario, theme])

  // hex vence accent. Sem hex → aplica o accent fixo.
  useEffect(() => {
    if (hex && HEX_RX.test(hex)) {
      applyHex(hex)
    } else {
      applyAccent(accent)
    }
  }, [accent, hex])

  useEffect(() => {
    setUserPrefs({ accent }, prefsUsuario)
  }, [accent, prefsUsuario])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  // Escolha de accent fixo (paleta): limpa o override hex (volta ao modo paleta).
  const setAccent = (a: Accent) => {
    setUserPrefs({ accent: a, hex: undefined }, prefsUsuario)
    setHexState('')
    setAccentState(a)
  }

  /** Escolha de um TEMA por hex (vindo da API). Vira override do usuário (persiste). */
  const setHex = (h: string) => {
    if (!HEX_RX.test(h)) return
    setUserPrefs({ hex: h }, prefsUsuario)
    setHexState(h)
  }

  /** Cor padrão da MARCA (hex vindo da API), só se o usuário ainda não escolheu (accent NEM hex). */
  const aplicarHexMarcaSeSemOverride = (corHex?: string) => {
    const prefs = getUserPrefs(prefsUsuario)
    if (prefs.accent || prefs.hex) return
    if (corHex && HEX_RX.test(corHex)) setHexState(corHex)
  }

  /** Define a cor a partir da MARCA (accent fixo), MAS só se o usuário ainda não escolheu. */
  const aplicarMarcaSeSemOverride = (marcaSgl?: string) => {
    const prefs = getUserPrefs(prefsUsuario)
    if (prefs.accent || prefs.hex) return
    setAccentState(accentDaMarca(marcaSgl))
  }

  return {
    theme, setTheme, toggleTheme,
    accent, setAccent, aplicarMarcaSeSemOverride,
    hex, setHex, aplicarHexMarcaSeSemOverride,
  }
}
