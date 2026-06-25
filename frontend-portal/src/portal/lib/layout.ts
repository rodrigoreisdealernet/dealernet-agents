// Helpers de layout responsivo do portal.

/** Largura da área MDI (atualizada pelo WindowManager via ResizeObserver). */
export interface MdiSize {
  width: number
  height: number
}

export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

// Abaixo de DESKTOP_MIN o portal entra em modo adaptativo (1 janela por vez).
export const DESKTOP_MIN = 1024
export const TABLET_MIN = 768

export function breakpointOf(width: number): Breakpoint {
  if (width >= DESKTOP_MIN) return 'desktop'
  if (width >= TABLET_MIN) return 'tablet'
  return 'mobile'
}

/** É um layout "compacto" (tablet/mobile): janelas em tela cheia, sem drag. */
export function isCompact(width: number): boolean {
  return width < DESKTOP_MIN
}

const clampN = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)

/** Área MDI confiável: usa o mdiSize medido; se vier inválido (ex.: modo abas,
 *  área ainda não montada), cai para o tamanho da viewport descontando o chrome. */
export function effectiveArea(area: MdiSize): MdiSize {
  const w = area.width > 200 ? area.width : (typeof window !== 'undefined' ? window.innerWidth - 240 : 1200)
  const h = area.height > 200 ? area.height : (typeof window !== 'undefined' ? window.innerHeight - 110 : 700)
  return { width: w, height: h }
}

/** Janela flutuante GRANDE e centralizada/cascateada (~78% da área).
 *  Nunca minúscula: usa effectiveArea como base. `index` desloca em cascata. */
export function floatingRect(area: MdiSize, index = 0): { x: number; y: number; width: number; height: number } {
  const a = effectiveArea(area)
  const width = clampN(Math.round(a.width * 0.78), 480, a.width - 32)
  const height = clampN(Math.round(a.height * 0.8), 360, a.height - 32)
  // Centraliza a 1ª; cascateia as próximas a partir do centro.
  const baseX = Math.max(16, Math.round((a.width - width) / 2))
  const baseY = Math.max(16, Math.round((a.height - height) / 2))
  const step = 28
  const x = clampN(baseX + (index % 6) * step, 0, Math.max(0, a.width - width))
  const y = clampN(baseY + (index % 6) * step, 0, Math.max(0, a.height - height))
  return { x, y, width, height }
}

/**
 * Mantém uma janela dentro da área MDI: limita tamanho ao container e reposiciona
 * para não sair pela direita/baixo. Usado ao abrir, mover, redimensionar e ao
 * redimensionar o browser. Evita janelas "perdidas" fora da tela.
 */
export function clampRect(
  rect: { x: number; y: number; width: number; height: number },
  area: MdiSize,
  minW = 240,
  minH = 160,
) {
  const width = clampN(rect.width, minW, Math.max(minW, area.width))
  const height = clampN(rect.height, minH, Math.max(minH, area.height))
  const x = clampN(rect.x, 0, Math.max(0, area.width - width))
  const y = clampN(rect.y, 0, Math.max(0, area.height - height))
  return { x, y, width, height }
}
