// Motor híbrido do DataTable (spec §2): detecta a capacidade do BFF pela resposta.
// - Resposta SEM `total` (backend legado) → modo CLIENT: 1 fetch da coleção, filtro/sort/página locais.
// - Resposta COM `total` (BFF v2) → modo SERVER: page/size/sort/busca/filtros com serverParam
//   refazem o fetch; filtros sem serverParam refinam a página corrente no cliente.

import { useEffect, useMemo, useRef, useState } from 'react'
import { parseFilter, type CrudListApi, type DnColumn, type GridState } from './types'

function useDebounced<V>(value: V, ms: number): V {
  const [v, setV] = useState(value)
  useEffect(() => {
    if (ms <= 0) {
      setV(value)
      return
    }
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function matchFilter(valor: unknown, raw: string): boolean {
  const { op, valor: alvo } = parseFilter(raw)
  switch (op) {
    case 'contains':
      return String(valor ?? '').toLowerCase().includes(alvo.toLowerCase())
    case 'startsWith':
      return String(valor ?? '').toLowerCase().startsWith(alvo.toLowerCase())
    case 'eq':
      return String(valor ?? '').toLowerCase() === alvo.toLowerCase()
    case 'in':
      return alvo.split(',').includes(String(valor ?? ''))
    case 'gt':
      return Number(valor) >= Number(alvo)
    case 'lt':
      return Number(valor) <= Number(alvo)
    case 'between': {
      const [min, max] = alvo.split(',')
      const n = Number(valor)
      return n >= Number(min) && n <= Number(max)
    }
    default:
      return true
  }
}

export interface DataTableQueryArgs<T> {
  api: CrudListApi<T>
  state: GridState
  colunas: DnColumn<T>[]
  hydrated: boolean
  forceClientMode?: boolean
  /** Incrementar para forçar recarga (após save/delete). */
  reloadKey: number
}

/** Acesso dinâmico a campo (interfaces não têm index signature). */
const getVal = <T,>(item: T, key: string): unknown => (item as Record<string, unknown>)[key]

export function useDataTableQuery<T extends object>({
  api,
  state,
  colunas,
  hydrated,
  forceClientMode = false,
  reloadKey,
}: DataTableQueryArgs<T>) {
  const [all, setAll] = useState<T[] | null>(null) // dataset completo (modo client)
  const [pageData, setPageData] = useState<T[]>([]) // página do servidor (modo server)
  const [serverTotal, setServerTotal] = useState(0)
  const [serverPaged, setServerPaged] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const firstLoad = useRef(true)

  // separa filtros server (coluna com serverParam, quando o modo server está ativo) dos client
  const serverParamByCol = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of colunas) if (c.serverParam) m[c.key] = c.serverParam
    return m
  }, [colunas])

  const serverFilters: Record<string, string> = {}
  const clientFilters: Record<string, string> = {}
  for (const [col, raw] of Object.entries(state.filters)) {
    if (serverPaged && !forceClientMode && serverParamByCol[col]) serverFilters[col] = raw
    else clientFilters[col] = raw
  }
  const serverFiltersKey = JSON.stringify(serverFilters)

  const busca = useDebounced(state.busca ?? '', serverPaged ? 300 : 0)

  // chave de refetch: em modo server, qualquer mudança server-side; em client, só reload
  const serverFetchKey = serverPaged
    ? `${state.page}|${state.size}|${state.sort ?? ''}|${busca}|${serverFiltersKey}`
    : 'client'

  useEffect(() => {
    if (!hydrated) return
    let alive = true
    const isFirst = firstLoad.current
    if (isFirst) setLoading(true)
    else setRefreshing(true)
    setErro(null)

    api
      .list({
        page: state.page,
        size: state.size,
        sort: state.sort,
        busca: busca || undefined,
        filters: serverFilters,
      })
      .then((res) => {
        if (!alive) return
        firstLoad.current = false
        const isServer = res.total !== undefined && !forceClientMode
        setServerPaged(isServer)
        if (isServer) {
          setPageData(res.data)
          setServerTotal(res.total ?? res.data.length)
          setAll(null)
        } else {
          setAll(res.data)
        }
      })
      .catch(() => {
        if (alive) setErro('Não foi possível carregar os dados.')
      })
      .finally(() => {
        if (alive) {
          setLoading(false)
          setRefreshing(false)
        }
      })
    return () => {
      alive = false
    }
    // serverFetchKey já agrega page/size/sort/busca/filtros-server quando em modo server
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, reloadKey, serverFetchKey])

  // pipeline client (filtra/ordena/pagina) — modo client usa o dataset completo;
  // modo server aplica SÓ os filtros client como refino da página corrente (spec §2)
  const { rows, total } = useMemo(() => {
    const base = serverPaged ? pageData : (all ?? [])
    let out = base

    if (!serverPaged && busca.trim()) {
      const termo = busca.trim().toLowerCase()
      const buscaveis = colunas.filter((c) => c.tipo === 'texto' || c.tipo === 'codigo')
      out = out.filter((item) =>
        buscaveis.some((c) => String(getVal(item, c.key) ?? '').toLowerCase().includes(termo)),
      )
    }

    const filtros = serverPaged ? clientFilters : state.filters
    for (const [col, raw] of Object.entries(filtros)) {
      out = out.filter((item) => matchFilter(getVal(item, col), raw))
    }

    if (!serverPaged && state.sort) {
      const [colKey, dir] = state.sort.split(':')
      const col = colunas.find((c) => c.key === colKey)
      const mult = dir === 'desc' ? -1 : 1
      const numerico = col?.tipo === 'numero' || col?.tipo === 'codigo'
      out = [...out].sort((a, b) => {
        if (numerico) return (Number(getVal(a, colKey)) - Number(getVal(b, colKey))) * mult
        return (
          String(getVal(a, colKey) ?? '').localeCompare(String(getVal(b, colKey) ?? ''), 'pt-BR') *
          mult
        )
      })
    }

    if (serverPaged) return { rows: out, total: serverTotal }

    const totalClient = out.length
    const ini = (state.page - 1) * state.size
    return { rows: out.slice(ini, ini + state.size), total: totalClient }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, pageData, serverPaged, serverTotal, busca, state.filters, state.sort, state.page, state.size, colunas, serverFiltersKey])

  return { rows, total, loading, refreshing, erro, serverPaged }
}
