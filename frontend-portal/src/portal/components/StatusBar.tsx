// Barra inferior: workspace (trocar/salvar/novo/excluir) · minimizadas · favoritos.
// Paridade com createStatusbar + createWorkspaceManager do W5Portal.js legado.

import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Layers, Plus, Save, Trash2 } from 'lucide-react'
import { useTranslations } from 'use-intl'
import { usePortalStore } from '@/portal/store/portalStore'
import { translateBookmarkTitle, translateWindowTitle } from '@/i18n/menu'

export function StatusBar() {
  const t = useTranslations('shell')
  const tMenu = useTranslations('menu')
  const workspaces = usePortalStore((s) => s.workspaces)
  const activeWorkspaceId = usePortalStore((s) => s.activeWorkspaceId)
  const loadWorkspace = usePortalStore((s) => s.loadWorkspace)
  const saveCurrentWorkspace = usePortalStore((s) => s.saveCurrentWorkspace)
  const createWorkspace = usePortalStore((s) => s.createWorkspace)
  const deleteCurrentWorkspace = usePortalStore((s) => s.deleteCurrentWorkspace)
  const windows = usePortalStore((s) => s.windows)
  const restoreWindow = usePortalStore((s) => s.restoreWindow)
  const bookmarks = usePortalStore((s) => s.bookmarks)
  const openWindow = usePortalStore((s) => s.openWindow)

  const [flash, setFlash] = useState<string | null>(null)
  const showFlash = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash((f) => (f === msg ? null : f)), 2500)
  }

  const minimized = windows.filter((w) => w.minimized)
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId)

  const onSave = async () => {
    await saveCurrentWorkspace()
    showFlash(t('workspaceSaved'))
  }
  const onNew = async () => {
    const name = window.prompt(t('newWorkspacePrompt'))
    if (!name?.trim()) return
    await createWorkspace(name.trim())
    showFlash(t('workspaceCreated'))
  }
  const onDelete = async () => {
    if (!activeWs) return
    if (!window.confirm(t('deleteWorkspaceConfirm').replace('{name}', activeWs.name))) return
    await deleteCurrentWorkspace()
    showFlash(t('workspaceDeleted'))
  }

  return (
    <footer className="flex h-9 shrink-0 items-center gap-2 border-t bg-card px-3 text-xs">
      {/* Seletor de workspace */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger data-tour="workspaces" className="flex items-center gap-1.5 rounded px-2 py-1 outline-none hover:bg-secondary data-[state=open]:bg-secondary">
          <Layers size={13} className="text-muted-foreground" />
          <span className="text-muted-foreground">{t('workspace')}:</span>
          <span className="font-medium text-foreground">{activeWs?.name ?? '—'}</span>
          <ChevronDown size={12} className="opacity-60" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={6}
            className="z-[9999] min-w-52 rounded-lg border bg-card p-1 shadow-xl"
          >
            <DropdownMenu.Label className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
              {t('switchWorkspace')}
            </DropdownMenu.Label>
            {workspaces.map((w) => (
              <DropdownMenu.Item
                key={w.id}
                onSelect={() => loadWorkspace(w.id)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
              >
                <span className="flex w-4 justify-center">
                  {w.id === activeWorkspaceId && <Check size={14} className="text-primary" />}
                </span>
                <span className="truncate">{w.name}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Ações de workspace */}
      <div className="flex items-center gap-0.5">
        <WsBtn title={t('saveWorkspace')} onClick={onSave} disabled={!activeWs}>
          <Save size={13} />
        </WsBtn>
        <WsBtn title={t('newWorkspace')} onClick={onNew}>
          <Plus size={13} />
        </WsBtn>
        <WsBtn title={t('deleteWorkspace')} onClick={onDelete} disabled={!activeWs} danger>
          <Trash2 size={13} />
        </WsBtn>
      </div>

      <Divider />

      {/* Minimizadas */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="rounded px-2 py-1 outline-none hover:bg-secondary data-[state=open]:bg-secondary">
          {t('minimized')} ({minimized.length})
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            sideOffset={6}
            className="z-[9999] min-w-48 rounded-lg border bg-card p-1 shadow-xl"
          >
            {minimized.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">{t('none')}</div>
            )}
            {minimized.map((w) => (
              <DropdownMenu.Item
                key={w.id}
                onSelect={() => restoreWindow(w.id)}
                className="cursor-pointer truncate rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
              >
                {translateWindowTitle(w, tMenu)}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Divider />

      {/* Favoritos */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger data-tour="favoritos" className="rounded px-2 py-1 outline-none hover:bg-secondary data-[state=open]:bg-secondary">
          {t('favorites')} ({bookmarks.length})
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            sideOffset={6}
            className="z-[9999] min-w-48 rounded-lg border bg-card p-1 shadow-xl"
          >
            {bookmarks.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">{t('noneMasc')}</div>
            )}
            {bookmarks.map((b) => (
              <DropdownMenu.Item
                key={b.text}
                onSelect={() => openWindow(b.spec)}
                className="cursor-pointer truncate rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
              >
                ⭐ {translateBookmarkTitle(b, tMenu)}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Mensagem transitória + contador */}
      <div className="ml-auto flex items-center gap-3">
        {flash && <span className="text-emerald-600 dark:text-emerald-400">{flash}</span>}
        <span className="text-muted-foreground">{t('openWindows').replace('{count}', String(windows.length))}</span>
      </div>
    </footer>
  )
}

function WsBtn({
  children,
  onClick,
  title,
  disabled,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors',
        'hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent',
        danger ? 'hover:bg-destructive hover:text-destructive-foreground' : '',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="h-4 w-px bg-border" />
}
