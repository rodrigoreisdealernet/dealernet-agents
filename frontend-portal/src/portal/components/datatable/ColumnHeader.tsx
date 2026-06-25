// Cabeçalho de coluna: label + indicador de ordenação + popover de filtro (spec §1/§6:
// clique no funil abre controles; funil preenchido quando filtro ativo).

import * as Popover from '@radix-ui/react-popover'
import { ArrowDown, ArrowUp, Filter, X } from 'lucide-react'
import type { DnColumn } from './types'
import FilterText from './filters/FilterText'
import FilterEnum from './filters/FilterEnum'
import FilterNumberRange from './filters/FilterNumberRange'
import FilterBool from './filters/FilterBool'
import { cn } from '@/lib/utils'

export default function ColumnHeader<T>({
  col,
  sort,
  filterValue,
  onSort,
  onFilter,
}: {
  col: DnColumn<T>
  /** sort atual do grid: "col:asc|desc" */
  sort?: string
  filterValue: string
  onSort: (next?: string) => void
  onFilter: (v: string) => void
}) {
  const ordenavel = col.ordenavel !== false
  const filtravel = col.filtravel !== false && col.tipo !== 'data'
  const [sortCol, sortDir] = (sort ?? '').split(':')
  const isSorted = sortCol === col.key
  const filtroAtivo = filterValue !== ''

  function cycleSort() {
    if (!ordenavel) return
    if (!isSorted) onSort(`${col.key}:asc`)
    else if (sortDir === 'asc') onSort(`${col.key}:desc`)
    else onSort(undefined)
  }

  return (
    <div className={cn('flex items-center gap-1', col.tipo === 'numero' && 'justify-end')}>
      <button
        type="button"
        onClick={cycleSort}
        className={cn(
          'inline-flex items-center gap-1 font-medium',
          ordenavel ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
        )}
      >
        {col.label}
        {isSorted && (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>

      {filtravel && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              title={`Filtrar ${col.label}`}
              className={cn(
                'rounded p-0.5 transition-colors hover:bg-muted',
                filtroAtivo ? 'text-primary' : 'text-muted-foreground/60',
              )}
            >
              <Filter size={12} fill={filtroAtivo ? 'currentColor' : 'none'} />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              className="z-[1002] w-56 rounded-lg border border-border bg-card p-3 shadow-lg outline-none"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  {col.label}
                </span>
                {filtroAtivo && (
                  <button
                    type="button"
                    onClick={() => onFilter('')}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <X size={11} /> Limpar
                  </button>
                )}
              </div>
              {col.tipo === 'badge' || col.enumOptions ? (
                <FilterEnum value={filterValue} options={col.enumOptions ?? []} onChange={onFilter} />
              ) : col.tipo === 'numero' ? (
                <FilterNumberRange value={filterValue} onChange={onFilter} />
              ) : col.tipo === 'bool' ? (
                <FilterBool value={filterValue} onChange={onFilter} />
              ) : (
                <FilterText value={filterValue} onChange={onFilter} />
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  )
}
