// Janela MDI flutuante: drag/resize (react-rnd) + tools + animação (framer-motion).
// Paridade com createWindow do W5Portal.js legado (doc §4.2).

import { useState } from 'react'
import { useTranslations } from 'use-intl'
import { Rnd } from 'react-rnd'
import { motion } from 'framer-motion'
import { Maximize2, Minimize2, Minus, RefreshCw, Star, X } from 'lucide-react'
import { usePortalStore } from '@/portal/store/portalStore'
import { WindowBody } from '@/portal/components/WindowBody'
import { moduleColor } from '@/portal/lib/moduleTheme'
import { MenuIcon } from '@/portal/lib/menuIcon'
import { cn } from '@/lib/utils'
import { translateWindowTitle } from '@/i18n/menu'
import type { PortalWindow } from '@/portal/types'

const TOOLBAR_H = 40

export function Window({ win, allowedOrigins }: { win: PortalWindow; allowedOrigins: string[] }) {
  const tShell = useTranslations('shell')
  const tMenu = useTranslations('menu')
  const {
    activeWindowId,
    focusWindow,
    closeWindow,
    minimizeWindow,
    toggleMaximize,
    moveWindow,
    resizeWindow,
    addBookmark,
    removeBookmark,
  } = usePortalStore()
  const title = translateWindowTitle(win, tMenu)
  const bookmarked = usePortalStore((s) => s.bookmarks.some((b) => b.text === win.title))

  // Recarrega só o conteúdo desta janela (remonta o body) — não o portal inteiro.
  const [reloadKey, setReloadKey] = useState(0)

  if (win.minimized) return null

  const active = activeWindowId === win.id

  const toggleBookmark = () => {
    if (bookmarked) {
      removeBookmark(win.title)
    } else {
      addBookmark({ title: win.title, titleKey: win.titleKey, kind: win.kind, src: win.src, componentKey: win.componentKey }, win.title)
    }
  }

  // Maximizada ocupa toda a área MDI (o container é position:relative).
  const geometry = win.maximized
    ? { x: 0, y: 0, width: '100%', height: '100%' }
    : { x: win.x, y: win.y, width: win.width, height: win.height }

  return (
    <Rnd
      position={{ x: win.maximized ? 0 : win.x, y: win.maximized ? 0 : win.y }}
      size={{ width: geometry.width, height: geometry.height }}
      minWidth={240}
      minHeight={160}
      bounds="parent"
      dragHandleClassName="w5-drag"
      disableDragging={win.maximized}
      enableResizing={!win.maximized}
      style={{ zIndex: win.zIndex }}
      onMouseDown={() => focusWindow(win.id)}
      onDragStop={(_e, d) => moveWindow(win.id, d.x, d.y)}
      onResizeStop={(_e, _dir, ref, _delta, pos) =>
        resizeWindow(win.id, ref.offsetWidth, ref.offsetHeight, pos.x, pos.y)
      }
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 6 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className={cn(
          'flex h-full w-full flex-col overflow-hidden border border-border bg-card transition-shadow',
          win.maximized ? 'rounded-none' : 'rounded-[var(--radius-lg)]',
          active ? 'ring-1 ring-[var(--border-focus)]' : '',
        )}
        style={{ boxShadow: win.maximized ? 'none' : 'var(--shadow-modal)' }}
      >
        {/* Barra de título (drag handle): faixa de cor do módulo + ícone + título. */}
        <div
          className={cn(
            'w5-drag flex cursor-move items-center gap-2 border-b border-border pl-2 pr-1.5 transition-colors',
            active ? 'bg-card' : 'bg-[var(--surface-2)]',
          )}
          style={{
            height: TOOLBAR_H,
            boxShadow: active ? `inset 3px 0 0 0 ${moduleColor(win.kind)}` : undefined,
          }}
          onDoubleClick={() => toggleMaximize(win.id)}
        >
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
            style={{
              color: moduleColor(win.kind),
              backgroundColor: `color-mix(in oklch, ${moduleColor(win.kind)} 12%, transparent)`,
            }}
          >
            <MenuIcon name={win.icon} size={14} />
          </span>
          <span
            className={cn(
              'flex-1 select-none truncate text-sm',
              active ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
            )}
          >
            {title}
          </span>
          <ToolButton title={tShell('refresh')} onClick={() => setReloadKey((k) => k + 1)}>
            <RefreshCw size={14} />
          </ToolButton>
          <ToolButton
            title={bookmarked ? tShell('removeFavorite') : tShell('favorite')}
            active={bookmarked}
            onClick={toggleBookmark}
          >
            <Star size={14} fill={bookmarked ? 'currentColor' : 'none'} />
          </ToolButton>
          <ToolButton title={tShell('minimize')} onClick={() => minimizeWindow(win.id)}>
            <Minus size={14} />
          </ToolButton>
          <ToolButton
            title={win.maximized ? tShell('restore') : tShell('maximize')}
            onClick={() => toggleMaximize(win.id)}
          >
            {win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </ToolButton>
          <ToolButton title={tShell('close')} danger onClick={() => closeWindow(win.id)}>
            <X size={14} />
          </ToolButton>
        </div>

        {/* Conteúdo */}
        <div className="relative flex-1 overflow-hidden bg-card">
          <WindowBody win={win} allowedOrigins={allowedOrigins} reloadKey={reloadKey} />
        </div>
      </motion.div>
    </Rnd>
  )
}

function ToolButton({
  children,
  onClick,
  title,
  danger,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  danger?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-background',
        active ? 'text-primary' : 'text-muted-foreground',
        danger ? 'hover:bg-destructive hover:text-destructive-foreground' : 'hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
