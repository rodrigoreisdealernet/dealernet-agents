import { useSyncExternalStore } from 'react'
import { breakpointOf, isCompact, type Breakpoint } from '@/portal/lib/layout'

function subscribe(cb: () => void) {
  window.addEventListener('resize', cb)
  return () => window.removeEventListener('resize', cb)
}
function getWidth() {
  return window.innerWidth
}

/** Breakpoint atual (reativo ao resize da janela do browser). */
export function useBreakpoint(): { bp: Breakpoint; compact: boolean; width: number } {
  const width = useSyncExternalStore(subscribe, getWidth, () => DESKTOP_FALLBACK)
  return { bp: breakpointOf(width), compact: isCompact(width), width }
}

const DESKTOP_FALLBACK = 1280
