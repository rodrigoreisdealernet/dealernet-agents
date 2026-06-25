import { useEffect, useState } from 'react'

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

const MODE_KEY = 'dealernet-portal-theme'
const ACCENT_KEY = 'dealernet-portal-accent'
// Cor HEX escolhida pelo usuário (tema por marca, vindo da API). Tem prioridade sobre o accent fixo.
const HEX_KEY = 'dealernet-portal-themehex'

const HEX_RX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function getInitialMode(): Mode {
  if (typeof window === 'undefined') return 'light'
  const stored = localStorage.getItem(MODE_KEY) as Mode | null
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getInitialAccent(): Accent {
  if (typeof window === 'undefined') return 'navy'
  const stored = localStorage.getItem(ACCENT_KEY) as Accent | null
  return ACCENTS.some((a) => a.id === stored) ? (stored as Accent) : 'navy'
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

function getInitialHex(): string {
  if (typeof window === 'undefined') return ''
  const stored = localStorage.getItem(HEX_KEY) ?? ''
  return HEX_RX.test(stored) ? stored : ''
}

export function useTheme() {
  const [theme, setTheme] = useState<Mode>(getInitialMode)
  const [accent, setAccentState] = useState<Accent>(getInitialAccent)
  // Cor hex tem PRIORIDADE: se setada, pinta por hex; senão cai no accent (paleta fixa).
  const [hex, setHexState] = useState<string>(getInitialHex)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(MODE_KEY, theme)
  }, [theme])

  // hex vence accent. Sem hex → aplica o accent fixo.
  useEffect(() => {
    if (hex && HEX_RX.test(hex)) {
      applyHex(hex)
    } else {
      applyAccent(accent)
    }
  }, [accent, hex])

  useEffect(() => {
    localStorage.setItem(ACCENT_KEY, accent)
  }, [accent])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  // Escolha de accent fixo (paleta): limpa o override hex (volta ao modo paleta).
  const setAccent = (a: Accent) => {
    localStorage.removeItem(HEX_KEY)
    setHexState('')
    setAccentState(a)
  }

  /** Escolha de um TEMA por hex (vindo da API). Vira override do usuário (persiste). */
  const setHex = (h: string) => {
    if (!HEX_RX.test(h)) return
    localStorage.setItem(HEX_KEY, h)
    setHexState(h)
  }

  /** Cor padrão da MARCA (hex vindo da API), só se o usuário ainda não escolheu (accent NEM hex). */
  const aplicarHexMarcaSeSemOverride = (corHex?: string) => {
    if (localStorage.getItem(ACCENT_KEY) || localStorage.getItem(HEX_KEY)) return
    if (corHex && HEX_RX.test(corHex)) setHexState(corHex)
  }

  /** Define a cor a partir da MARCA (accent fixo), MAS só se o usuário ainda não escolheu. */
  const aplicarMarcaSeSemOverride = (marcaSgl?: string) => {
    if (localStorage.getItem(ACCENT_KEY) || localStorage.getItem(HEX_KEY)) return
    setAccentState(accentDaMarca(marcaSgl))
  }

  return {
    theme, setTheme, toggleTheme,
    accent, setAccent, aplicarMarcaSeSemOverride,
    hex, setHex, aplicarHexMarcaSeSemOverride,
  }
}
