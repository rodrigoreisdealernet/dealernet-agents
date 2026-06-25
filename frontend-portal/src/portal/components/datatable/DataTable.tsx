// DataTable corporativo (spec 11-padrao-grid-filtros): toolbar (busca global + seletor de
// colunas + limpar filtros), filtro/ordenação por coluna no header, paginação, skeleton,
// persistência de estado por usuário+tela. TanStack Table headless em modo manual — quem
// filtra/ordena/pagina é o useDataTableQuery (híbrido server/client por detecção de `total`).
// Visual padrão Boilerplate: linha 40px, header sticky, números à direita (tabular-nums),
// código em tom muted, badge de situação, linha inativa esmaecida.

import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { AlertCircle, FilterX, Loader2 } from 'lucide-react'
import type { CrudListApi, DnColumn, GridStorage } from './types'
import { useGridState } from './useGridState'
import { useDataTableQuery } from './useDataTableQuery'
import ColumnHeader from './ColumnHeader'
import Toolbar from './Toolbar'
import Pagination from './Pagination'
import TableSkeleton from './TableSkeleton'
import { cn } from '@/lib/utils'

export interface DataTableBase {
  codigo: number
  ativo: boolean
}

export interface DataTableProps<T extends DataTableBase> {
  /** Colunas de dados (a coluna Situação/ativo é injetada automaticamente). */
  colunas: DnColumn<T>[]
  api: CrudListApi<T>
  storage: GridStorage
  /** Chave da tela p/ persistência: PORTAL_DMS_<screenKey>_GridState. */
  screenKey: string
  /** Força o modo client mesmo com BFF v2 (escape hatch p/ rollback). */
  forceClientMode?: boolean
  /** Renderiza as ações da linha (editar/inativar). */
  renderAcoes: (item: T) => ReactNode
  /** Incrementar após save/delete para recarregar. */
  reloadKey: number
}

const ATIVO_COL = {
  key: 'ativo',
  label: 'Situação',
  tipo: 'badge',
  enumOptions: [
    { value: 'true', label: 'Ativo' },
    { value: 'false', label: 'Inativo' },
  ],
  serverParam: 'FiltroAtivo',
} as const

function renderCell<T extends DataTableBase>(col: DnColumn<T>, item: T): ReactNode {
  const valor = (item as Record<string, unknown>)[col.key]
  switch (col.tipo) {
    case 'badge': {
      if (col.key === 'ativo') {
        return (
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              item.ativo ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            {item.ativo ? 'Ativo' : 'Inativo'}
          </span>
        )
      }
      const opt = col.enumOptions?.find((o) => o.value === String(valor))
      return (
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
          {opt?.label ?? String(valor ?? '')}
        </span>
      )
    }
    case 'bool':
      return <span className="text-muted-foreground">{valor === true ? 'Sim' : 'Não'}</span>
    case 'codigo':
      return <span className="tabular-nums text-muted-foreground">{String(valor ?? '')}</span>
    case 'numero':
      return <span className="tabular-nums">{String(valor ?? '')}</span>
    default:
      return String(valor ?? '')
  }
}

export default function DataTable<T extends DataTableBase>({
  colunas,
  api,
  storage,
  screenKey,
  forceClientMode,
  renderAcoes,
  reloadKey,
}: DataTableProps<T>) {
  const colunasFull = useMemo(
    () => [...colunas, ATIVO_COL as unknown as DnColumn<T>],
    [colunas],
  )

  const grid = useGridState(screenKey, colunasFull, storage)
  const [retry, setRetry] = useState(0)
  const { rows, total, loading, refreshing, erro } = useDataTableQuery<T>({
    api,
    state: grid.state,
    colunas: colunasFull,
    hydrated: grid.hydrated,
    forceClientMode,
    reloadKey: reloadKey + retry * 1000,
  })

  const searchRef = useRef<HTMLInputElement>(null)

  const visiveis = colunasFull.filter((c) => !grid.state.columns.hidden.includes(c.key))
  const temFiltros = Object.keys(grid.state.filters).length > 0 || !!grid.state.busca

  // TanStack em modo manual: fonte de linhas/ordenação/filtros é o hook híbrido
  const columnDefs = useMemo<ColumnDef<T>[]>(
    () => [
      ...visiveis.map(
        (c): ColumnDef<T> => ({
          id: c.key,
          header: c.label,
          cell: ({ row }) => renderCell(c, row.original),
          meta: c,
        }),
      ),
      {
        id: '__acoes',
        header: 'Ações',
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">{renderAcoes(row.original)}</div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visiveis.map((c) => c.key).join('|'), renderAcoes],
  )

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    getRowId: (row) => String(row.codigo),
  })

  function handleKeyDown(e: React.KeyboardEvent) {
    const alvo = e.target as HTMLElement
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(alvo.tagName)) {
      e.preventDefault()
      searchRef.current?.focus()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
      <Toolbar<T>
        ref={searchRef}
        busca={grid.state.busca ?? ''}
        onBusca={grid.setBusca}
        colunas={colunasFull}
        hidden={grid.state.columns.hidden}
        onToggleColumn={grid.toggleColumn}
        temFiltros={temFiltros}
        onLimparFiltros={grid.limparFiltros}
      />

      {erro && (
        <div className="mx-5 mb-2 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle size={15} /> {erro}
          <button
            type="button"
            onClick={() => setRetry((r) => r + 1)}
            className="ml-auto rounded-md border border-destructive/40 px-2 py-0.5 text-xs hover:bg-destructive/10"
          >
            Tentar novamente
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto px-5">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                {hg.headers.map((h) => {
                  const col = h.column.columnDef.meta as DnColumn<T> | undefined
                  return (
                    <th
                      key={h.id}
                      style={col?.width ? { width: col.width } : undefined}
                      className={cn(
                        'py-2 pr-3 font-medium',
                        col?.tipo === 'numero' && 'text-right',
                        h.column.id === '__acoes' && 'w-24 text-right',
                      )}
                    >
                      {col ? (
                        <ColumnHeader<T>
                          col={col}
                          sort={grid.state.sort}
                          filterValue={grid.state.filters[col.key] ?? ''}
                          onSort={grid.setSort}
                          onFilter={(v) => grid.setFilter(col.key, v)}
                        />
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>

          {loading ? (
            <TableSkeleton cols={visiveis.length + 1} />
          ) : (
            <tbody className={cn('transition-opacity', refreshing && 'opacity-60')}>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    'h-10 border-b border-border/60 transition-colors hover:bg-muted/40',
                    !row.original.ativo && 'opacity-60',
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const col = cell.column.columnDef.meta as DnColumn<T> | undefined
                    return (
                      <td
                        key={cell.id}
                        className={cn('py-2 pr-3', col?.tipo === 'numero' && 'text-right')}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          )}
        </table>

        {!loading && rows.length === 0 && !erro && (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
            {temFiltros ? (
              <>
                <span>Nenhum resultado para os filtros aplicados.</span>
                <button
                  type="button"
                  onClick={grid.limparFiltros}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm transition-colors hover:bg-muted"
                >
                  <FilterX size={14} /> Limpar filtros
                </button>
              </>
            ) : (
              <span>Nenhum registro encontrado.</span>
            )}
          </div>
        )}

        {refreshing && (
          <div className="pointer-events-none absolute right-7 top-2">
            <Loader2 className="animate-spin text-muted-foreground" size={14} />
          </div>
        )}
      </div>

      <Pagination
        page={grid.state.page}
        size={grid.state.size}
        total={total}
        onPage={grid.setPage}
        onSize={grid.setSize}
      />
    </div>
  )
}
