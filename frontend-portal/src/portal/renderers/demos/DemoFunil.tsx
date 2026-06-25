// Tela nativa de demonstração (kind=component). Mostra que o MDI abre tanto
// iframes legados quanto componentes React reais da stack nova.

const STAGES = [
  { name: 'Novo Lead', count: 42, color: 'bg-blue-500' },
  { name: 'Qualificado', count: 28, color: 'bg-indigo-500' },
  { name: 'Proposta', count: 15, color: 'bg-violet-500' },
  { name: 'Negociação', count: 9, color: 'bg-fuchsia-500' },
  { name: 'Fechado', count: 6, color: 'bg-emerald-500' },
]

export default function DemoFunil() {
  const max = Math.max(...STAGES.map((s) => s.count))
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-5">
      <div>
        <h2 className="text-lg font-semibold">Funil de Vendas</h2>
        <p className="text-sm text-muted-foreground">
          Componente React nativo renderizado dentro de uma janela MDI (sem iframe).
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {STAGES.map((s) => (
          <div key={s.name} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-sm">{s.name}</span>
            <div className="h-7 flex-1 overflow-hidden rounded-md bg-muted">
              <div
                className={`flex h-full items-center justify-end rounded-md px-2 text-xs font-semibold text-white ${s.color}`}
                style={{ width: `${(s.count / max) * 100}%` }}
              >
                {s.count}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
