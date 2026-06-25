// Filtro booleano: toggle de 3 estados (todos / sim / não) — client-side por spec §3.

const ESTADOS = [
  { v: '', label: 'Todos' },
  { v: 'eq:true', label: 'Sim' },
  { v: 'eq:false', label: 'Não' },
]

export default function FilterBool({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex gap-1">
      {ESTADOS.map((e) => (
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
