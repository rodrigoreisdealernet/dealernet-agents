// Filtro de coluna texto: operador + valor com debounce 300ms (spec §3).

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'

export default function FilterText({
  value,
  onChange,
}: {
  /** "op:valor" ou '' */
  value: string
  onChange: (v: string) => void
}) {
  const t = useTranslations('common.grid')
  const ops = [
    { value: 'contains', label: t('contains') },
    { value: 'startsWith', label: t('startsWith') },
    { value: 'eq', label: t('equals') },
  ]
  const sep = value.indexOf(':')
  const [op, setOp] = useState(sep > 0 ? value.slice(0, sep) : 'contains')
  const [texto, setTexto] = useState(sep > 0 ? value.slice(sep + 1) : '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  function emit(nextOp: string, nextTexto: string) {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      onChange(nextTexto.trim() ? `${nextOp}:${nextTexto.trim()}` : '')
    }, 300)
  }

  return (
    <div className="space-y-2">
      <select
        value={op}
        onChange={(e) => {
          setOp(e.target.value)
          emit(e.target.value, texto)
        }}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
      >
        {ops.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        autoFocus
        value={texto}
        onChange={(e) => {
          setTexto(e.target.value)
          emit(op, e.target.value)
        }}
        placeholder={t('filterPlaceholder')}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
      />
    </div>
  )
}
