// Filtro de coluna numérica: faixa min–max (client-side por spec §3).

export default function FilterNumberRange({
  value,
  onChange,
}: {
  /** "between:min,max" | "gt:n" | "lt:n" ou '' */
  value: string
  onChange: (v: string) => void
}) {
  let min = ''
  let max = ''
  if (value.startsWith('between:')) {
    const [a, b] = value.slice(8).split(',')
    min = a ?? ''
    max = b ?? ''
  } else if (value.startsWith('gt:')) min = value.slice(3)
  else if (value.startsWith('lt:')) max = value.slice(3)

  function emit(nextMin: string, nextMax: string) {
    if (nextMin !== '' && nextMax !== '') onChange(`between:${nextMin},${nextMax}`)
    else if (nextMin !== '') onChange(`gt:${nextMin}`)
    else if (nextMax !== '') onChange(`lt:${nextMax}`)
    else onChange('')
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={min}
        onChange={(e) => emit(e.target.value, max)}
        placeholder="Mín"
        className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
      />
      <span className="text-xs text-muted-foreground">–</span>
      <input
        type="number"
        value={max}
        onChange={(e) => emit(min, e.target.value)}
        placeholder="Máx"
        className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
      />
    </div>
  )
}
