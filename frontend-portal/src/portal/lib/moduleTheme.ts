// Identidade visual por tipo de conteúdo: cor de acento + ícone.
// As cores DERIVAM do accent atual (--primary do DS): cada tipo é uma
// variação discreta do tom escolhido — assim a faixa/ícone do módulo
// acompanha a paleta selecionada, mantendo um toque sutil de distinção.

import { Boxes, Globe, LayoutGrid, type LucideIcon } from 'lucide-react'
import type { WindowKind } from '@/portal/types'

export interface ModuleTheme {
  /** Cor derivada do --primary (via color-mix), pronta para style. */
  color: string
  icon: LucideIcon
  label: string
}

// Mistura o primário com branco/preto para criar variações discretas do mesmo tom.
const THEMES: Record<WindowKind, { icon: LucideIcon; label: string; mix: string }> = {
  component: { icon: LayoutGrid, label: 'Aplicação', mix: 'var(--primary)' },
  'iframe-aspx': { icon: Boxes, label: 'Sistema', mix: 'color-mix(in oklch, var(--primary) 75%, white)' },
  'iframe-external': { icon: Globe, label: 'Externo', mix: 'color-mix(in oklch, var(--primary) 60%, black)' },
}

export function moduleThemeOf(kind: WindowKind): ModuleTheme {
  const t = THEMES[kind]
  return { color: t.mix, icon: t.icon, label: t.label }
}

/** Cor do módulo (derivada do accent), pronta para style. */
export function moduleColor(kind: WindowKind): string {
  return THEMES[kind].mix
}
