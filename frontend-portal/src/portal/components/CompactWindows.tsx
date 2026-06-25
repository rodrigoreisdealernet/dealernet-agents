// Modo compacto (tablet/mobile): janelas NÃO flutuam. Cada janela aberta vira
// uma aba; a janela ativa ocupa a área toda. Sem drag/resize/maximizar — não
// faz sentido em telas pequenas. Fechar pela própria aba.

import { X } from 'lucide-react'
import { usePortalStore } from '@/portal/store/portalStore'
import { WindowBody } from '@/portal/components/WindowBody'
import { cn } from '@/lib/utils'
import type { PortalWindow } from '@/portal/types'

interface Props {
  windows: PortalWindow[]
  allowedOrigins: string[]
}

export function CompactWindows({ windows, allowedOrigins }: Props) {
  const activeWindowId = usePortalStore((s) => s.activeWindowId)
  const focusWindow = usePortalStore((s) => s.focusWindow)
  const restoreWindow = usePortalStore((s) => s.restoreWindow)
  const closeWindow = usePortalStore((s) => s.closeWindow)

  if (windows.length === 0) return null

  // No compacto tratamos minimizada como "aba não-ativa": continua na lista.
  const active =
    windows.find((w) => w.id === activeWindowId && !w.minimized) ??
    windows.find((w) => !w.minimized) ??
    windows[0]

  const selectTab = (w: PortalWindow) => {
    if (w.minimized) restoreWindow(w.id)
    else focusWindow(w.id)
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Abas */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b bg-card px-2 py-1.5">
        {windows.map((w) => {
          const isActive = w.id === active.id
          return (
            <div
              key={w.id}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-md border px-3 py-1.5 text-sm',
                isActive
                  ? 'border-primary/60 bg-secondary'
                  : 'border-transparent text-muted-foreground hover:bg-secondary/60',
              )}
            >
              <button
                type="button"
                onClick={() => selectTab(w)}
                className="max-w-[40vw] truncate"
              >
                {w.title}
              </button>
              <button
                type="button"
                title="Fechar"
                onClick={() => closeWindow(w.id)}
                className="rounded p-0.5 hover:bg-background"
              >
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>

      {/* Janela ativa em tela cheia */}
      <div className="relative flex-1 overflow-hidden bg-card">
        <WindowBody win={active} allowedOrigins={allowedOrigins} />
      </div>
    </div>
  )
}
