// Filtro de coluna enum/status: multi-select (op `in` com CSV) — spec §3.

import * as Checkbox from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import type { EnumOption } from '../types'

export default function FilterEnum({
  value,
  options,
  onChange,
}: {
  /** "in:a,b" ou '' */
  value: string
  options: EnumOption[]
  onChange: (v: string) => void
}) {
  const selecionados = value.startsWith('in:')
    ? value.slice(3).split(',').filter(Boolean)
    : []

  function toggle(v: string) {
    const next = selecionados.includes(v)
      ? selecionados.filter((x) => x !== v)
      : [...selecionados, v]
    onChange(next.length ? `in:${next.join(',')}` : '')
  }

  return (
    <div className="space-y-1.5">
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox.Root
            checked={selecionados.includes(o.value)}
            onCheckedChange={() => toggle(o.value)}
            className="flex h-4 w-4 items-center justify-center rounded border border-input bg-background data-[state=checked]:border-primary data-[state=checked]:bg-primary"
          >
            <Checkbox.Indicator>
              <Check size={12} className="text-primary-foreground" />
            </Checkbox.Indicator>
          </Checkbox.Root>
          {o.label}
        </label>
      ))}
    </div>
  )
}
