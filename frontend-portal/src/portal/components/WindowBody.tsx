// Conteúdo de uma janela (component nativo ou iframe sandboxed), envolto em
// error boundary. Compartilhado entre o modo desktop (Window) e o compacto.

import { Suspense } from 'react'
import { SandboxedFrame } from '@/portal/components/SandboxedFrame'
import { WindowErrorBoundary } from '@/portal/components/WindowErrorBoundary'
import { resolveComponent } from '@/portal/renderers/registry'
import type { PortalWindow } from '@/portal/types'

function Body({ win, allowedOrigins }: { win: PortalWindow; allowedOrigins: string[] }) {
  if (win.kind === 'component' && win.componentKey) {
    const Comp = resolveComponent(win.componentKey)
    if (!Comp) {
      return (
        <div className="p-4 text-sm text-destructive">
          Componente não registrado: {win.componentKey}
        </div>
      )
    }
    return (
      <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Carregando…</div>}>
        <Comp params={win.params} />
      </Suspense>
    )
  }
  if (win.src) {
    return (
      <SandboxedFrame src={win.src} kind={win.kind} title={win.title} allowedOrigins={allowedOrigins} />
    )
  }
  return null
}

export function WindowBody({
  win,
  allowedOrigins,
  reloadKey,
}: {
  win: PortalWindow
  allowedOrigins: string[]
  reloadKey?: number
}) {
  return (
    <WindowErrorBoundary title={win.title}>
      <Body key={reloadKey} win={win} allowedOrigins={allowedOrigins} />
    </WindowErrorBoundary>
  )
}
