// Modo ABAS (estilo navegador): cada tela aberta vira uma aba no topo;
// só o conteúdo da aba ativa é renderizado, em tela cheia.
// Reusa o mesmo estado do portalStore (windows / activeWindowId) que o MDI.

import { X } from 'lucide-react'
import { useTranslations } from 'use-intl'
import { usePortalStore } from '@/portal/store/portalStore'
import { WindowBody } from '@/portal/components/WindowBody'
import { moduleColor } from '@/portal/lib/moduleTheme'
import { MenuIcon } from '@/portal/lib/menuIcon'
import { cn } from '@/lib/utils'
import { translateWindowTitle } from '@/i18n/menu'
import type { PortalWindow } from '@/portal/types'

const EMPTY_ORIGINS: string[] = []

export function TabsView() {
  const windows = usePortalStore((s) => s.windows)
  const activeId = usePortalStore((s) => s.activeWindowId)
  const allowedOrigins = usePortalStore((s) => s.config?.allowedOrigins) ?? EMPTY_ORIGINS
  const focusWindow = usePortalStore((s) => s.focusWindow)
  const closeWindow = usePortalStore((s) => s.closeWindow)

  // Em abas, ignoramos minimizado/maximizado: toda janela aberta é uma aba.
  const tabs = windows
  const active = tabs.find((w) => w.id === activeId) ?? tabs[tabs.length - 1] ?? null

  if (tabs.length === 0) {
    return (
      <div className="mdi-canvas relative flex-1 overflow-hidden">
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* Barra de abas */}
      <div className="flex h-10 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-[var(--surface-2)] px-1.5 pt-1.5">
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            tab={tab}
            active={tab.id === active?.id}
            onSelect={() => focusWindow(tab.id)}
            onClose={() => closeWindow(tab.id)}
          />
        ))}
      </div>

      {/* Conteúdo da aba ativa (apenas uma montada). */}
      <div className="relative flex-1 overflow-hidden bg-card">
        {active && (
          <div className="absolute inset-0">
            <WindowBody win={active} allowedOrigins={allowedOrigins} />
          </div>
        )}
      </div>
    </div>
  )
}

function Tab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: PortalWindow
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const tMenu = useTranslations('menu')
  const tShell = useTranslations('shell')
  const title = translateWindowTitle(tab, tMenu)
  // Responsivo: a aba ATIVA fica confortável (texto completo); as inativas
  // encolhem até um mínimo legível (ícone + ~8 chars). Passando disso, a barra
  // rola na horizontal (overflow-x-auto no container). Ícone = ícone REAL da
  // tela (vindo do menu), não mais o genérico por tipo.
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      title={title}
      className={cn(
        'group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm transition-colors',
        active
          ? 'min-w-[150px] max-w-[240px] border-border bg-card text-foreground'
          : 'min-w-[92px] max-w-[170px] border-transparent bg-transparent text-muted-foreground hover:bg-card/60',
      )}
      style={active ? { boxShadow: `inset 0 2px 0 0 ${moduleColor(tab.kind)}` } : undefined}
    >
      <MenuIcon name={tab.icon} size={14} className="shrink-0" style={{ color: moduleColor(tab.kind) }} />
      <span className="flex-1 truncate">{title}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-secondary hover:text-foreground',
          // some sempre visível na aba ativa; nas demais só no hover (poupa espaço)
          active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        title={tShell('closeTab')}
        aria-label={tShell('closeTab')}
      >
        <X size={13} />
      </button>
    </div>
  )
}

function EmptyState() {
  const t = useTranslations('shell')
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-border bg-card/60 shadow-sm">
        <span className="text-3xl">🗔</span>
      </div>
      <div>
        <p className="text-base font-semibold text-foreground">{t('noOpenScreen')}</p>
        <p className="mt-1 max-w-xs px-6 text-sm text-muted-foreground">
          {t('openScreenHint')}
        </p>
      </div>
    </div>
  )
}
