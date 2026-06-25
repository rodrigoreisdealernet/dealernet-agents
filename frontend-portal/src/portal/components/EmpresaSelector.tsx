// Seletor de empresa no header (move do rodapé do portal antigo).
// Lista vem de GET /api/v1/portal/empresas, agrupada por `grupo` (GM, DEALERNET),
// como o submenu hierárquico do print do portal legado.

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Building2, Check, ChevronDown } from 'lucide-react'
import { usePortalStore } from '@/portal/store/portalStore'
import type { Empresa } from '@/portal/types'

export function EmpresaSelector() {
  const empresas = usePortalStore((s) => s.empresas)
  const empresaAtualId = usePortalStore((s) => s.empresaAtualId)
  const changeEmpresa = usePortalStore((s) => s.changeEmpresa)

  if (empresas.length === 0) return null

  const atual = empresas.find((e) => e.id === empresaAtualId)

  // Agrupa por `grupo`; empresas sem grupo ficam num bloco "Outras".
  const grupos = new Map<string, Empresa[]>()
  for (const e of empresas) {
    const g = e.grupo ?? 'Outras'
    grupos.set(g, [...(grupos.get(g) ?? []), e])
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex max-w-[280px] items-center gap-2 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-header-foreground outline-none transition-colors hover:bg-white/20 data-[state=open]:bg-white/20">
        <Building2 size={15} className="shrink-0 opacity-80" />
        <span className="truncate font-medium">{atual?.nome ?? 'Selecionar empresa'}</span>
        {atual?.grupo && (
          /* Marca (default) da empresa logada — chip ao lado do nome. */
          <span className="shrink-0 rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            {atual.grupo}
          </span>
        )}
        <ChevronDown size={14} className="shrink-0 opacity-70" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-[9999] min-w-56 rounded-lg border bg-card p-1 shadow-xl"
        >
          {[...grupos.entries()].map(([grupo, lista], i) => (
            <div key={grupo}>
              {i > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
              <DropdownMenu.Label className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                {grupo}
              </DropdownMenu.Label>
              {lista.map((e) => (
                <DropdownMenu.Item
                  key={e.id}
                  onSelect={() => changeEmpresa(e.id)}
                  className="flex cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
                >
                  <span className="flex w-4 justify-center">
                    {e.id === empresaAtualId && <Check size={14} className="text-primary" />}
                  </span>
                  <span className="truncate">{e.nome}</span>
                </DropdownMenu.Item>
              ))}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
