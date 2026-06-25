// Área MDI. Dois modos:
//  - DESKTOP (≥1024px): janelas flutuantes (react-rnd), sobrepostas.
//  - COMPACTO (tablet/mobile): uma janela por vez em tela cheia + abas no topo.
// Rastreia o tamanho da área (ResizeObserver) p/ alimentar o clamping no store.

import { useEffect, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { LayoutGrid } from 'lucide-react'
import { useTranslations } from 'use-intl'
import { usePortalStore } from '@/portal/store/portalStore'
import { useBreakpoint } from '@/hooks/use-breakpoint'
import { Window } from '@/portal/components/Window'
import { TabsView } from '@/portal/components/TabsView'

const EMPTY_ORIGINS: string[] = []

export function WindowManager() {
  const windows = usePortalStore((s) => s.windows)
  const allowedOrigins = usePortalStore((s) => s.config?.allowedOrigins) ?? EMPTY_ORIGINS
  const setMdiSize = usePortalStore((s) => s.setMdiSize)
  const layoutMode = usePortalStore((s) => s.layoutMode)
  const { compact } = useBreakpoint()

  const areaRef = useRef<HTMLDivElement>(null)

  // Mede a área MDI e mantém o store atualizado (base do clamping responsivo).
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setMdiSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    setMdiSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [setMdiSize])

  // Abas: quando o usuário escolhe o modo 'tabs' OU em telas compactas (mobile).
  // MDI flutuante: modo 'mdi' no desktop.
  const useTabs = compact || layoutMode === 'tabs'

  if (useTabs) {
    return <TabsView />
  }

  const visible = windows.filter((w) => !w.minimized)

  return (
    <div ref={areaRef} className="mdi-canvas relative flex-1 overflow-hidden">
      {visible.length === 0 && <EmptyState />}
      <AnimatePresence>
        {visible.map((win) => (
          <Window key={win.id} win={win} allowedOrigins={allowedOrigins} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function EmptyState() {
  const t = useTranslations('shell')
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-border/70 bg-card/60 shadow-sm">
        <LayoutGrid className="text-primary/70" size={34} strokeWidth={1.5} />
      </div>
      <div>
        <p className="text-base font-semibold text-foreground">{t('emptyWorkspace')}</p>
        <p className="mt-1 max-w-xs px-6 text-sm text-muted-foreground">
          {t('emptyWorkspaceHint')}
        </p>
      </div>
    </div>
  )
}
