// Fonte única de verdade do MDI (Zustand). Ver docs/portal-mdi-arquitetura.md §4.5.
// Equivalente moderno e tipado ao gerenciamento de janelas do W5Portal.js legado.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Bookmark,
  Empresa,
  MenuItem,
  PortalConfig,
  PortalWindow,
  WindowSpec,
  WorkspaceMeta,
} from '@/portal/types'
import { portalApi } from '@/portal/lib/portalApi'
import { getCompanies, getMyRole, type CompanyRow } from '@/portal/lib/agentsApi'
import { clampRect, floatingRect, type MdiSize } from '@/portal/lib/layout'

const CASCADE_STEP = 28
const CASCADE_ORIGIN = { x: 24, y: 24 }

const PERSIST_KEY = 'dealernet-portal-mdi'

let idSeq = 0
const nextId = () => `win-${++idSeq}`

/** Duas telas são o "mesmo destino" se apontam para o mesmo componente ou a mesma URL. */
function isSameTarget(w: { kind: string; src?: string; componentKey?: string }, spec: WindowSpec): boolean {
  if (w.kind !== spec.kind) return false
  if (spec.kind === 'component') return !!spec.componentKey && w.componentKey === spec.componentKey
  return !!spec.src && w.src === spec.src
}

/** Reidrata janelas vindas de um workspace: novos ids, z-index sequencial e
 *  clamp à área MDI atual (evita janela salva fora da tela em outra resolução). */
function rehydrateWindows(saved: PortalWindow[], area: MdiSize): { windows: PortalWindow[]; topZ: number } {
  let z = 0
  const windows = saved.map((w) => {
    const rect = w.maximized
      ? { x: w.x, y: w.y, width: w.width, height: w.height }
      : clampRect({ x: w.x, y: w.y, width: w.width, height: w.height }, area)
    return { ...w, ...rect, id: `win-${++idSeq}`, zIndex: ++z }
  })
  return { windows, topZ: z }
}

interface PortalState {
  // dados de boot
  config: PortalConfig | null
  menu: MenuItem[]
  /** app_role do usuário corrente (via Supabase JWT) — gating do menu/telas. */
  role: string | null
  workspaces: WorkspaceMeta[]
  activeWorkspaceId: string | null
  empresas: Empresa[]
  empresaAtualId: string | null
  loading: boolean

  // estado do MDI
  windows: PortalWindow[]
  activeWindowId: string | null
  bookmarks: Bookmark[]
  topZ: number

  // UI shell
  sidebarCollapsed: boolean
  /** Drawer da sidebar aberto (só usado no modo compacto/mobile). */
  drawerOpen: boolean
  /** Tamanho da área MDI (px), atualizado pelo WindowManager. Base do clamping. */
  mdiSize: MdiSize
  /** Modo de exibição das telas: 'mdi' (janelas flutuantes) ou 'tabs' (abas, estilo navegador). */
  layoutMode: 'mdi' | 'tabs'

  // ações
  boot(): Promise<void>
  changeEmpresa(id: string): Promise<void>
  toggleSidebar(): void
  setDrawerOpen(open: boolean): void
  setMdiSize(size: MdiSize): void
  setLayoutMode(mode: 'mdi' | 'tabs'): void
  openWindow(spec: WindowSpec): void
  closeWindow(id: string): void
  closeAll(): void
  focusWindow(id: string): void
  moveWindow(id: string, x: number, y: number): void
  resizeWindow(id: string, width: number, height: number, x: number, y: number): void
  minimizeWindow(id: string): void
  minimizeAll(): void
  restoreWindow(id: string): void
  toggleMaximize(id: string): void
  cascade(): void
  addBookmark(spec: WindowSpec, text: string): void
  removeBookmark(text: string): void

  // workspaces
  loadWorkspace(id: string): Promise<void>
  saveCurrentWorkspace(): Promise<void>
  createWorkspace(name: string): Promise<void>
  deleteCurrentWorkspace(): Promise<void>
}

export const usePortalStore = create<PortalState>()(
  persist(
    (set, get) => ({
  config: null,
  menu: [],
  role: null,
  workspaces: [],
  activeWorkspaceId: null,
  empresas: [],
  empresaAtualId: null,
  loading: true,

  windows: [],
  activeWindowId: null,
  bookmarks: [],
  topZ: 1,

  sidebarCollapsed: false,
  drawerOpen: false,
  mdiSize: { width: 1280, height: 720 },
  layoutMode: 'tabs',

  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
  },

  setLayoutMode(mode) {
    set((s) => {
      // Ao entrar no modo JANELAS, recascateia as telas abertas com tamanho bom
      // (evita janelas minúsculas vindas do modo abas). Cascata com ~78% da área.
      if (mode === 'mdi') {
        let z = s.topZ
        const windows = s.windows.map((w, i) => {
          const rect = floatingRect(s.mdiSize, i)
          return { ...w, ...rect, maximized: false, minimized: false, zIndex: ++z }
        })
        return { layoutMode: mode, windows, topZ: z }
      }
      return { layoutMode: mode }
    })
  },

  setDrawerOpen(open) {
    set({ drawerOpen: open })
  },

  setMdiSize(size) {
    set((s) => {
      if (size.width === s.mdiSize.width && size.height === s.mdiSize.height) return s
      // Reposiciona/redimensiona janelas para caberem na nova área (ex.: resize do browser).
      const windows = s.windows.map((w) => {
        if (w.maximized) return w
        const r = clampRect({ x: w.x, y: w.y, width: w.width, height: w.height }, size)
        return { ...w, ...r }
      })
      return { mdiSize: size, windows }
    })
  },

  async boot() {
    set({ loading: true })
    // Resiliente: cada chamada cai para um default se falhar (ex.: uma API ainda
    // não importada na KB). O portal SEMPRE carrega — não trava por causa de 1 endpoint.
    const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[portal] boot: falha ao carregar parte do portal', e)
        return fallback
      }
    }
    const [config, menu, workspaces, companies, role] = await Promise.all([
      safe(portalApi.getConfig(), null as unknown as PortalConfig),
      safe(portalApi.getMenu(), [] as MenuItem[]),
      safe(portalApi.getWorkspaces(), [] as WorkspaceMeta[]),
      // Empresas vivas da view v_dia_company_current (issue #37). Sem sessão/erro
      // (ex.: modo mock sem Supabase) → []; o EmpresaSelector apenas não renderiza.
      safe(getCompanies(), [] as CompanyRow[]),
      // Role do Supabase (gating do menu). Sem sessão/erro → null (esconde itens admin).
      safe(getMyRole(), null as unknown as string),
    ])
    // Adapta as empresas reais ao shape do seletor (id/nome/grupo). O grupo do
    // dropdown passa a ser a MARCA (brand_name); sem marca cai em "Sem marca".
    // `ativa` vem do status da view (ativo/inativo) — o boot abaixo seleciona a
    // primeira empresa ATIVA, caindo na primeira da lista só se nenhuma for ativa.
    const empresas: Empresa[] = companies.map((c) => ({
      id: c.entity_id,
      nome: c.trade_name ?? c.name ?? c.legal_name ?? c.entity_id,
      grupo: c.brand_name ?? 'Sem marca',
      ativa: c.status === 'ativo',
    }))
    set({
      config,
      menu,
      role,
      workspaces,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      empresas,
      empresaAtualId: empresas.find((e) => e.ativa)?.id ?? empresas[0]?.id ?? null,
      loading: false,
    })
  },

  async changeEmpresa(id) {
    const { empresaAtualId } = get()
    if (id === empresaAtualId) return
    // No real: troca a empresa da sessão no backend (que pode redefinir o cookie).
    // Aqui também faria sentido fechar janelas, pois o contexto de dados mudou.
    await portalApi.setEmpresa(id)
    set((s) => ({
      empresaAtualId: id,
      empresas: s.empresas.map((e) => ({ ...e, ativa: e.id === id })),
      windows: [],
      activeWindowId: null,
    }))
  },

  openWindow(spec) {
    const { windows, topZ, mdiSize } = get()

    // Bloqueia abertura duplicada (paridade com W5Portal.js:905): se já existe
    // uma janela com o mesmo destino, foca/restaura a existente em vez de criar.
    const existing = windows.find((w) => isSameTarget(w, spec))
    if (existing) {
      const z = topZ + 1
      set({
        windows: windows.map((w) =>
          // Atualiza params ao refocar (ex.: abrir finding-detail de outro finding).
          w.id === existing.id ? { ...w, params: spec.params, minimized: false, zIndex: z } : w,
        ),
        activeWindowId: existing.id,
        topZ: z,
      })
      return
    }

    const count = windows.length
    const z = topZ + 1

    // Diálogo (item com width/height explícito) → flutuante nesse tamanho, centralizado.
    // Tela de operação (sem tamanho) → flutuante GRANDE centralizada/cascateada.
    const explicitSize = spec.width != null && spec.height != null
    let rect: { x: number; y: number; width: number; height: number }
    if (explicitSize) {
      const a = clampRect(
        { x: 0, y: 0, width: spec.width!, height: spec.height! },
        mdiSize,
      )
      // centraliza o diálogo
      const big = floatingRect(mdiSize, count)
      rect = {
        width: a.width,
        height: a.height,
        x: Math.max(16, big.x + Math.round((big.width - a.width) / 2)),
        y: Math.max(16, big.y + Math.round((big.height - a.height) / 2)),
      }
    } else {
      rect = floatingRect(mdiSize, count)
    }
    // Telas de operação/CRUD (kind 'component' sem tamanho explícito) abrem
    // MAXIMIZADAS por padrão, ocupando a área de trabalho. Diálogos (com
    // width/height explícito) seguem flutuantes/centralizados. Guarda o rect
    // flutuante em prevRect para que "restaurar" volte a um tamanho razoável.
    const openMaximized = spec.kind === 'component' && !explicitSize
    const win: PortalWindow = {
      id: nextId(),
      title: spec.title,
      kind: spec.kind,
      icon: spec.icon,
      src: spec.src,
      componentKey: spec.componentKey,
      params: spec.params,
      ...rect,
      maximized: openMaximized,
      minimized: false,
      zIndex: z,
      ...(openMaximized ? { prevRect: rect } : {}),
    }
    set({ windows: [...windows, win], activeWindowId: win.id, topZ: z })
  },

  closeWindow(id) {
    set((s) => ({
      windows: s.windows.filter((w) => w.id !== id),
      activeWindowId: s.activeWindowId === id ? null : s.activeWindowId,
    }))
  },

  closeAll() {
    set({ windows: [], activeWindowId: null })
  },

  focusWindow(id) {
    set((s) => {
      const z = s.topZ + 1
      return {
        windows: s.windows.map((w) => (w.id === id ? { ...w, zIndex: z } : w)),
        activeWindowId: id,
        topZ: z,
      }
    })
  },

  moveWindow(id, x, y) {
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, x, y } : w)) }))
  },

  resizeWindow(id, width, height, x, y) {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, width, height, x, y } : w)),
    }))
  },

  minimizeWindow(id) {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
      activeWindowId: s.activeWindowId === id ? null : s.activeWindowId,
    }))
  },

  minimizeAll() {
    set((s) => ({
      windows: s.windows.map((w) => ({ ...w, minimized: true })),
      activeWindowId: null,
    }))
  },

  restoreWindow(id) {
    set((s) => {
      const z = s.topZ + 1
      return {
        windows: s.windows.map((w) =>
          w.id === id ? { ...w, minimized: false, zIndex: z } : w,
        ),
        activeWindowId: id,
        topZ: z,
      }
    })
  },

  toggleMaximize(id) {
    set((s) => {
      const z = s.topZ + 1
      return {
        windows: s.windows.map((w) => {
          if (w.id !== id) return w
          if (!w.maximized) {
            // Vai maximizar: guarda a geometria atual para restaurar depois.
            return {
              ...w,
              maximized: true,
              minimized: false,
              zIndex: z,
              prevRect: { x: w.x, y: w.y, width: w.width, height: w.height },
            }
          }
          // Vai restaurar: volta ao prevRect (se existir).
          const r = w.prevRect
          return {
            ...w,
            maximized: false,
            minimized: false,
            zIndex: z,
            ...(r ? { x: r.x, y: r.y, width: r.width, height: r.height } : {}),
            prevRect: undefined,
          }
        }),
        activeWindowId: id,
        topZ: z,
      }
    })
  },

  cascade() {
    set((s) => {
      let z = s.topZ
      const windows = s.windows
        .filter((w) => !w.minimized)
        .map((w, i) => ({
          ...w,
          maximized: false,
          x: CASCADE_ORIGIN.x + i * CASCADE_STEP,
          y: CASCADE_ORIGIN.y + i * CASCADE_STEP,
          zIndex: ++z,
        }))
      // preserva as minimizadas como estão
      const minimized = s.windows.filter((w) => w.minimized)
      return { windows: [...minimized, ...windows], topZ: z }
    })
  },

  addBookmark(spec, text) {
    set((s) =>
      s.bookmarks.some((b) => b.text === text)
        ? s
        : { bookmarks: [...s.bookmarks, { spec, text }] },
    )
  },

  removeBookmark(text) {
    set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.text !== text) }))
  },

  // --- Workspaces (load/save/create/delete) -------------------------------

  async loadWorkspace(id) {
    const ws = await portalApi.getWorkspace(id)
    if (!ws) return
    const { mdiSize } = get()
    const { windows, topZ } = rehydrateWindows(ws.data.windows, mdiSize)
    set({
      activeWorkspaceId: id,
      windows,
      topZ,
      bookmarks: ws.data.bookmarks ?? [],
      activeWindowId: windows[windows.length - 1]?.id ?? null,
    })
  },

  async saveCurrentWorkspace() {
    const { activeWorkspaceId, workspaces, windows, bookmarks } = get()
    if (!activeWorkspaceId) return
    const meta = workspaces.find((w) => w.id === activeWorkspaceId)
    if (!meta) return
    // Salva o estado atual das janelas (sem o id efêmero — será reidratado no load).
    await portalApi.saveWorkspace(activeWorkspaceId, meta.name, { windows, bookmarks })
  },

  async createWorkspace(name) {
    const { windows, bookmarks } = get()
    const meta = await portalApi.createWorkspace(name, { windows, bookmarks })
    const list = await portalApi.getWorkspaces()
    set({ workspaces: list, activeWorkspaceId: meta.id })
  },

  async deleteCurrentWorkspace() {
    const { activeWorkspaceId } = get()
    if (!activeWorkspaceId) return
    await portalApi.deleteWorkspace(activeWorkspaceId)
    const list = await portalApi.getWorkspaces()
    const nextId = list[0]?.id ?? null
    set({ workspaces: list, activeWorkspaceId: nextId, windows: [], bookmarks: [], activeWindowId: null })
    if (nextId) await get().loadWorkspace(nextId)
  },
    }),
    {
      name: PERSIST_KEY,
      // Persiste só o estado do MDI; config/menu/workspaces vêm sempre do backend.
      partialize: (s) => ({
        windows: s.windows,
        bookmarks: s.bookmarks,
        topZ: s.topZ,
        sidebarCollapsed: s.sidebarCollapsed,
        layoutMode: s.layoutMode,
      }),
      // Ao reidratar, garante que o gerador de IDs não colida com janelas restauradas.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const max = state.windows.reduce((m, w) => {
          const n = Number(w.id.replace('win-', ''))
          return Number.isFinite(n) && n > m ? n : m
        }, 0)
        idSeq = max
      },
    },
  ),
)
