// Skeleton do corpo da tabela (spec §6: loading sem piscar cabeçalho/filtros).

export default function TableSkeleton({ rows = 8, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-b border-border/60">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="h-10 py-2 pr-3">
              <div
                className="h-3.5 animate-pulse rounded bg-muted"
                style={{ width: `${55 + ((r * 7 + c * 13) % 40)}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}
