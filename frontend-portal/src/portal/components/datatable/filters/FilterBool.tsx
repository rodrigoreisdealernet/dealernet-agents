// Filtro booleano: toggle de 3 estados (todos / sim / não) — client-side por spec §3.

import { useTranslations } from 'use-intl'

export default function FilterBool({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const t = useTranslations('common')
  const estados = [
    { v: '', label: t('all') },
    { v: 'eq:true', label: t('yes') },
    { v: 'eq:false', label: t('no') },
  ]
  return (
    <div className="flex gap-1">
      {estados.map((e) => (
        <button
          key={e.v || 'all'}
          type="button"
          onClick={() => onChange(e.v)}
          className={
            value === e.v
              ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
              : 'rounded-md border border-input px-2.5 py-1 text-xs hover:bg-muted'
          }
        >
          {e.label}
        </button>
      ))}
    </div>
  )
}
