// Toolbar do grid: busca global (atalho /), seletor de colunas e limpar filtros (spec §1).

import { forwardRef } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, Columns3, FilterX, Search } from 'lucide-react'
import type { DnColumn } from './types'

interface ToolbarProps<T> {
  busca: string
  onBusca: (v: string) => void
  colunas: DnColumn<T>[]
  hidden: string[]
  onToggleColumn: (key: string) => void
  temFiltros: boolean
  onLimparFiltros: () => void
}

function ToolbarInner<T>(
  { busca, onBusca, colunas, hidden, onToggleColumn, temFiltros, onLimparFiltros }: ToolbarProps<T>,
  searchRef: React.ForwardedRef<HTMLInputElement>,
) {
  return (
    <div className="flex items-center gap-2 px-5 py-3">
      <div className="relative min-w-0 flex-1">
        <Search
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={searchRef}
          value={busca}
          onChange={(e) => onBusca(e.target.value)}
          placeholder="Buscar…  ( / )"
          className="w-full rounded-lg border border-input bg-background py-2 pl-8 pr-3 text-sm outline-none focus:border-primary"
        />
      </div>

      {temFiltros && (
        <button
          type="button"
          onClick={onLimparFiltros}
          className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FilterX size={15} /> Limpar filtros
        </button>
      )}

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            title="Colunas visíveis"
            className="inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Columns3 size={15} /> Colunas
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-[1002] min-w-44 rounded-lg border border-border bg-card p-1.5 shadow-lg"
          >
            {colunas.map((c) => {
              const visivel = !hidden.includes(c.key)
              return (
                <DropdownMenu.CheckboxItem
                  key={c.key}
                  checked={visivel}
                  onCheckedChange={() => onToggleColumn(c.key)}
                  onSelect={(e) => e.preventDefault()}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted"
                >
                  <span className="flex h-4 w-4 items-center justify-center">
                    {visivel && <Check size={13} className="text-primary" />}
                  </span>
                  {c.label}
                </DropdownMenu.CheckboxItem>
              )
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}

// forwardRef com generic: cast preserva a assinatura
const Toolbar = forwardRef(ToolbarInner) as <T>(
  props: ToolbarProps<T> & { ref?: React.ForwardedRef<HTMLInputElement> },
) => ReturnType<typeof ToolbarInner>

export default Toolbar
