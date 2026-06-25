// Estado do grid (sort/página/filtros/busca/colunas) com hidratação + persistência debounced.
// Chave de persistência: PORTAL_DMS_<Tela>_GridState (spec §5.3; sem URL-sync — MDI sem rota).

import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyGridState, type DnColumn, type GridState, type GridStorage } from './types'

const SIZES = [25, 50, 100, 200]

function sanitize<T>(raw: GridState, colunas: DnColumn<T>[]): GridState {
  const keys = new Set<string>([...colunas.map((c) => c.key), 'ativo'])
  const filters: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw.filters ?? {})) {
    if (keys.has(k) && typeof v === 'string' && v) filters[k] = v
  }
  const [sortCol] = (raw.sort ?? '').split(':')
  return {
    v: 1,
    sort: sortCol && keys.has(sortCol) ? raw.sort : undefined,
    page: Number.isInteger(raw.page) && raw.page > 0 ? raw.page : 1,
    size: SIZES.includes(raw.size) ? raw.size : 50,
    filters,
    busca: typeof raw.busca === 'string' ? raw.busca : undefined,
    columns: {
      order: (raw.columns?.order ?? []).filter((k) => keys.has(k)),
      hidden: (raw.columns?.hidden ?? []).filter((k) => keys.has(k)),
    },
  }
}

export function useGridState<T>(screenKey: string, colunas: DnColumn<T>[], storage: GridStorage) {
  const key = `PORTAL_DMS_${screenKey}_GridState`
  const [state, setState] = useState<GridState>(emptyGridState)
  const [hydrated, setHydrated] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // hidrata 1x do storage
  useEffect(() => {
    let alive = true
    storage
      .load(key)
      .then((saved) => {
        if (alive && saved && saved.v === 1) setState(sanitize(saved, colunas))
      })
      .catch(() => {
        // estado padrão
      })
      .finally(() => {
        if (alive) setHydrated(true)
      })
    return () => {
      alive = false
    }
    // intencional: hidrata só na montagem da tela
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // persiste (debounce 800ms) após hidratado
  useEffect(() => {
    if (!hydrated) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => storage.save(key, state), 800)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [state, hydrated, key, storage])

  const patch = useCallback((p: Partial<GridState>) => {
    setState((s) => ({ ...s, ...p }))
  }, [])

  const setBusca = useCallback((busca: string) => patch({ busca, page: 1 }), [patch])
  const setSort = useCallback((sort?: string) => patch({ sort, page: 1 }), [patch])
  const setPage = useCallback((page: number) => patch({ page }), [patch])
  const setSize = useCallback((size: number) => patch({ size, page: 1 }), [patch])

  const setFilter = useCallback((col: string, valor: string) => {
    setState((s) => {
      const filters = { ...s.filters }
      if (valor) filters[col] = valor
      else delete filters[col]
      return { ...s, filters, page: 1 }
    })
  }, [])

  const limparFiltros = useCallback(() => {
    setState((s) => ({ ...s, filters: {}, busca: undefined, page: 1 }))
  }, [])

  const toggleColumn = useCallback((colKey: string) => {
    setState((s) => {
      const hidden = s.columns.hidden.includes(colKey)
        ? s.columns.hidden.filter((k) => k !== colKey)
        : [...s.columns.hidden, colKey]
      return { ...s, columns: { ...s.columns, hidden } }
    })
  }, [])

  return {
    state,
    hydrated,
    setBusca,
    setSort,
    setPage,
    setSize,
    setFilter,
    limparFiltros,
    toggleColumn,
  }
}
