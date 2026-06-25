// Casca raiz do portal: Sidebar (esquerda) + [TopBar / WindowManager / StatusBar].
// Substitui o Ext.Viewport (border layout) do W5Portal.js legado (doc §4.1).

import { useEffect } from 'react'
import { usePortalStore } from '@/portal/store/portalStore'
import { Sidebar } from '@/portal/components/Sidebar'
import { TopBar } from '@/portal/components/TopBar'
import { WindowManager } from '@/portal/components/WindowManager'
import { StatusBar } from '@/portal/components/StatusBar'
import { SessionGuard } from '@/portal/components/SessionGuard'
import { DaiAssistant } from '@/portal/components/dai/DaiAssistant'
import { PortalTour } from '@/portal/components/tour/PortalTour'
import { useTour } from '@/portal/components/tour/useTour'

export function PortalShell() {
  const boot = usePortalStore((s) => s.boot)
  const loading = usePortalStore((s) => s.loading)
  const maybeAutoStart = useTour((s) => s.maybeAutoStart)

  useEffect(() => {
    boot()
  }, [boot])

  // Dispara o tour no 1º acesso, após o portal carregar (alvos já no DOM).
  useEffect(() => {
    if (!loading) {
      const t = setTimeout(() => maybeAutoStart(), 600)
      return () => clearTimeout(t)
    }
  }, [loading, maybeAutoStart])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-sm">Carregando portal…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <WindowManager />
        <StatusBar />
      </div>
      <SessionGuard />
      <DaiAssistant />
      <PortalTour />
    </div>
  )
}
