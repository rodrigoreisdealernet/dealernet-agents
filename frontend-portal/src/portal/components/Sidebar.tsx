// Menu lateral esquerdo colapsável (ícone↔texto). Substitui o menu no topo.
// Expandido (~240px): ícone + texto + grupos expansíveis.
// Colapsado (~56px): só ícones; grupos abrem em flyout; itens com tooltip.
// Ver docs/portal-mdi-arquitetura.md §4.3 (navegação).

import { useMemo, useState } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowLeftRight,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  FileText,
  GitBranch,
  LineChart,
  Palette,
  PanelLeft,
  Search,
  ShoppingCart,
  Tag,
  Users,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react'
import { usePortalStore } from '@/portal/store/portalStore'
import { useBreakpoint } from '@/hooks/use-breakpoint'
import { filterMenu } from '@/portal/lib/menuFilter'
import { cn } from '@/lib/utils'
import type { MenuItem, WindowSpec } from '@/portal/types'

// Mapa nome->ícone (o backend manda só o nome em MenuItem.icon).
const ICONS: Record<string, LucideIcon> = {
  Users,
  UserPlus,
  GitBranch,
  BarChart3,
  LineChart,
  ShoppingCart,
  FileText,
  Tag,
  Palette,
  ArrowLeftRight,
}
function iconOf(name?: string): LucideIcon | null {
  return name ? (ICONS[name] ?? null) : null
}

const EXPANDED_W = 240
const COLLAPSED_W = 56

export function Sidebar() {
  const { compact } = useBreakpoint()
  return compact ? <DrawerSidebar /> : <DesktopSidebar />
}

// --- Desktop: sidebar fixa colapsável --------------------------------------

function DesktopSidebar() {
  const menu = usePortalStore((s) => s.menu)
  const collapsed = usePortalStore((s) => s.sidebarCollapsed)
  const toggleSidebar = usePortalStore((s) => s.toggleSidebar)
  const config = usePortalStore((s) => s.config)

  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterMenu(menu, query), [menu, query])
  const filtering = query.trim().length > 0

  return (
    <Tooltip.Provider delayDuration={200}>
      <aside
        className="flex shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200"
        style={{ width: collapsed ? COLLAPSED_W : EXPANDED_W }}
      >
        <SidebarHeader collapsed={collapsed} portalName={config?.portalName} />

        {/* Busca só no modo expandido (não cabe no recolhido). */}
        {!collapsed && <MenuSearch value={query} onChange={setQuery} />}

        <nav data-tour="menu" className="flex-1 space-y-1 overflow-y-auto p-2">
          {collapsed
            ? menu.map((group) => <CollapsedGroup key={group.id} group={group} />)
            : filtered.length === 0
              ? <MenuEmpty query={query} />
              : filtered.map((group) => (
                  <ExpandedGroup key={group.id} group={group} forceOpen={filtering} />
                ))}
        </nav>

        <div className="border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={toggleSidebar}
            title={collapsed ? 'Expandir menu' : 'Recolher menu'}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-sidebar-muted transition-colors hover:bg-white/10 hover:text-sidebar-foreground"
          >
            {collapsed ? <PanelLeft size={18} /> : <ChevronLeft size={18} />}
            {!collapsed && <span>Recolher</span>}
          </button>
        </div>
      </aside>
    </Tooltip.Provider>
  )
}

// Campo de busca do menu (sidebar expandida + drawer).
function MenuSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="px-2 pt-2" data-tour="busca">
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sidebar-muted"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Buscar tela…"
          className="w-full rounded-md border border-sidebar-border bg-black/20 py-1.5 pl-8 pr-7 text-sm text-sidebar-foreground placeholder:text-sidebar-muted outline-none focus:border-sidebar-accent"
        />
        {value && (
          <button
            type="button"
            title="Limpar"
            onClick={() => onChange('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-sidebar-muted hover:bg-white/10 hover:text-sidebar-foreground"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

function MenuEmpty({ query }: { query: string }) {
  return (
    <div className="px-3 py-6 text-center text-sm text-sidebar-muted">
      Nenhuma tela encontrada para
      <div className="mt-1 truncate font-medium text-sidebar-foreground">“{query}”</div>
    </div>
  )
}

// --- Compacto: drawer overlay ----------------------------------------------

function DrawerSidebar() {
  const menu = usePortalStore((s) => s.menu)
  const open = usePortalStore((s) => s.drawerOpen)
  const setDrawerOpen = usePortalStore((s) => s.setDrawerOpen)

  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterMenu(menu, query), [menu, query])
  const filtering = query.trim().length > 0

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[1000] flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => setDrawerOpen(false)}
        aria-hidden
      />
      {/* Painel */}
      <aside className="relative flex w-[260px] max-w-[80vw] flex-col bg-sidebar text-sidebar-foreground shadow-2xl">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-3">
          <span className="flex flex-1 items-center justify-center rounded-lg bg-white px-2 py-1.5 shadow-sm">
            <img src="/dia-logo.svg" alt="DIA — Dealernet Intelligence Agents" className="h-7 w-auto" />
          </span>
          <button
            type="button"
            title="Fechar menu"
            onClick={() => setDrawerOpen(false)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted hover:bg-white/10 hover:text-sidebar-foreground"
          >
            <X size={18} />
          </button>
        </div>

        <MenuSearch value={query} onChange={setQuery} />

        {/* Ao escolher um item, a janela abre e o drawer fecha. */}
        <nav
          className="flex-1 space-y-1 overflow-y-auto p-2"
          onClick={() => setDrawerOpen(false)}
        >
          {filtered.length === 0 ? (
            <MenuEmpty query={query} />
          ) : (
            filtered.map((group) => (
              <ExpandedGroup key={group.id} group={group} forceOpen={filtering} />
            ))
          )}
        </nav>
      </aside>
    </div>
  )
}

function SidebarHeader({ collapsed }: { collapsed: boolean; portalName?: string }) {
  // Logo sobre o chrome escuro: cápsula clara garante legibilidade em qualquer tema.
  // Expandida: logo da marca. Recolhida: ícone compacto.
  return (
    <div className="flex h-14 items-center justify-center border-b border-sidebar-border px-3">
      {collapsed ? (
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-[11px] font-bold tracking-tight text-[#1f3a6e] shadow-sm">
          DIA
        </span>
      ) : (
        <span className="flex w-full items-center justify-center rounded-lg bg-white px-2 py-1.5 shadow-sm">
          <img src="/dia-logo.svg" alt="DIA — Dealernet Intelligence Agents" className="h-7 w-auto" />
        </span>
      )}
    </div>
  )
}

// --- Modo expandido: grupo com subitens dobrável ----------------------------

function ExpandedGroup({ group, forceOpen }: { group: MenuItem; forceOpen?: boolean }) {
  // Recolhido por default; o usuário expande o que precisar (forceOpen da busca abre tudo).
  const [open, setOpen] = useState(false)
  const openWindow = usePortalStore((s) => s.openWindow)
  const GroupIcon = iconOf(group.icon)

  const hasChildren = !!group.children?.length
  // Durante a busca, o grupo fica sempre aberto para mostrar os resultados.
  const isOpen = forceOpen || open

  return (
    <div>
      <button
        type="button"
        onClick={() => (hasChildren ? setOpen((o) => !o) : group.spec && openWindow(group.spec))}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm font-semibold uppercase tracking-wide text-sidebar-muted transition-colors hover:bg-white/10 hover:text-sidebar-foreground"
      >
        {GroupIcon && <GroupIcon size={18} className="shrink-0" />}
        <span className="flex-1 truncate text-left text-xs">{group.text}</span>
        {hasChildren && (
          <ChevronDown
            size={14}
            className={cn('shrink-0 opacity-60 transition-transform', isOpen ? '' : '-rotate-90')}
          />
        )}
      </button>
      {hasChildren && isOpen && (
        <div className="mt-0.5 space-y-0.5 pl-3">
          {group.children!.map((item) => (
            <MenuNode key={item.id} item={item} depth={1} forceOpen={forceOpen} onOpen={(s) => openWindow(s)} />
          ))}
        </div>
      )}
    </div>
  )
}

// Nó de menu RECURSIVO: se tem children, é sub-grupo expansível (qualquer profundidade);
// senão, é folha que abre a janela. Suporta a hierarquia Sistema > Admin > Segurança > item.
function MenuNode({
  item,
  depth,
  forceOpen,
  onOpen,
}: {
  item: MenuItem
  depth: number
  forceOpen?: boolean
  onOpen: (s: WindowSpec) => void
}) {
  // Sub-grupos também recolhidos por default (forceOpen da busca abre tudo).
  const [open, setOpen] = useState(false)
  const Icon = iconOf(item.icon)
  const hasChildren = !!item.children?.length

  // Folha ativa = a JANELA EM FOCO aponta para este destino. Antes marcava "qualquer
  // janela aberta", o que fazia a seleção acumular e nunca limpar no MDI (várias telas
  // abertas = vários itens destacados). Agora acompanha o activeWindowId: só um por vez.
  const isActive = usePortalStore((s) => {
    const active = s.windows.find((w) => w.id === s.activeWindowId)
    if (!active) return false
    return (
      (!!item.spec?.componentKey && active.componentKey === item.spec.componentKey) ||
      (!!item.spec?.src && active.src === item.spec.src)
    )
  })

  if (hasChildren) {
    const isOpen = forceOpen || open
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-muted transition-colors hover:bg-white/10 hover:text-sidebar-foreground"
        >
          {Icon && <Icon size={16} className="shrink-0" />}
          <span className="flex-1 truncate text-left">{item.text}</span>
          <ChevronDown size={13} className={cn('shrink-0 opacity-60 transition-transform', isOpen ? '' : '-rotate-90')} />
        </button>
        {isOpen && (
          <div className="mt-0.5 space-y-0.5 border-l border-white/10 pl-3">
            {item.children!.map((child) => (
              <MenuNode key={child.id} item={child} depth={depth + 1} forceOpen={forceOpen} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      disabled={!item.spec}
      onClick={() => item.spec && onOpen(item.spec)}
      className={cn(
        'group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors disabled:opacity-50',
        isActive
          ? 'bg-white/15 font-medium text-sidebar-foreground'
          : 'text-sidebar-muted hover:bg-white/10 hover:text-sidebar-foreground',
      )}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-sidebar-accent" />
      )}
      {Icon && <Icon size={16} className={cn('shrink-0', isActive ? 'text-sidebar-accent' : '')} />}
      <span className="truncate text-left">{item.text}</span>
    </button>
  )
}

// --- Modo colapsado: ícone do grupo + flyout com subitens -------------------

// Achata a árvore em folhas (com caminho dos grupos-pai), p/ o flyout do modo recolhido.
function flattenLeaves(items: MenuItem[], prefixo = ''): { id: string; text: string; icon?: string; spec?: WindowSpec }[] {
  const out: { id: string; text: string; icon?: string; spec?: WindowSpec }[] = []
  for (const it of items) {
    if (it.children?.length) {
      out.push(...flattenLeaves(it.children, prefixo ? `${prefixo} › ${it.text}` : it.text))
    } else if (it.spec) {
      out.push({ id: it.id, text: prefixo ? `${prefixo} › ${it.text}` : it.text, icon: it.icon, spec: it.spec })
    }
  }
  return out
}

function CollapsedGroup({ group }: { group: MenuItem }) {
  const openWindow = usePortalStore((s) => s.openWindow)
  const GroupIcon = iconOf(group.icon)
  const children = flattenLeaves(group.children ?? [])

  return (
    <DropdownMenu.Root>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <DropdownMenu.Trigger className="flex w-full items-center justify-center rounded-md p-2.5 text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary data-[state=open]:text-foreground">
            {GroupIcon ? <GroupIcon size={18} /> : <span className="text-xs">{group.text[0]}</span>}
          </DropdownMenu.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="right"
            sideOffset={8}
            className="z-[9999] rounded-md border bg-card px-2 py-1 text-xs shadow-lg"
          >
            {group.text}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={8}
          className="z-[9999] min-w-52 rounded-lg border bg-card p-1 shadow-xl"
        >
          <DropdownMenu.Label className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            {group.text}
          </DropdownMenu.Label>
          {children.map((item) => {
            const Icon = iconOf(item.icon)
            return (
              <DropdownMenu.Item
                key={item.id}
                disabled={!item.spec}
                onSelect={() => item.spec && openWindow(item.spec)}
                className="flex cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary data-[disabled]:opacity-50"
              >
                {Icon && <Icon size={16} className="shrink-0 text-muted-foreground" />}
                <span className="truncate">{item.text}</span>
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
