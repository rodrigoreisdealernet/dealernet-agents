// Oficina — Fast BI (issue #17). Lê getServiceOrders (view v_dia_service_order_current)
// e deriva tudo no cliente (KPIs, gráficos e lista). NÃO usa v_dia_service_summary (#14)
// porque essa view retorna 0 linhas hoje. ChartCard é presentacional: recebe `data` já agregado.
import { useEffect, useMemo, useState } from 'react'
import { getServiceOrders, type ServiceOrderRow } from '@/portal/lib/agentsApi'
import { ChartCard } from './ChartCard'
import { formatBRL, formatDateTime } from './format'
import { Badge, KpiCard, ScreenShell, type Tone } from './ui'

// Rótulos pt-BR para os status de OS (a view entrega o status em pt-BR já).
const STATUS_LABELS: Record<string, string> = {
  aberta: 'Aberta',
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
}

// Ordem estável dos status para o gráfico/contagens.
const STATUS_ORDER = ['aberta', 'em_andamento', 'concluida', 'cancelada'] as const

// statusTone de ui.tsx mapeia status de findings (approved/rejected/...); aqui as OS têm
// status próprios, então usamos um helper local dedicado.
function serviceStatusTone(status: string): Tone {
  switch (status) {
    case 'aberta':
      return 'warning'
    case 'em_andamento':
      return 'info'
    case 'concluida':
      return 'success'
    case 'cancelada':
      return 'danger'
    default:
      return 'neutral'
  }
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

// Mês de referência da OS: closed_at quando existe, senão opened_at (OS aberta ainda não fechou,
// mas continua relevante para volume/faturamento do período corrente).
function referenceDate(row: ServiceOrderRow): Date | null {
  const raw = row.closed_at ?? row.opened_at
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

function isSameMonth(d: Date, ref: Date): boolean {
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth()
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function ServiceDashboard() {
  const [rows, setRows] = useState<ServiceOrderRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getServiceOrders()
      .then((data) => setRows(data))
      .catch((e) => setError(String(e)))
  }, [])

  const kpis = useMemo(() => {
    const now = new Date()
    const open = rows.filter((r) => r.status === 'aberta').length
    const inProgress = rows.filter((r) => r.status === 'em_andamento').length

    // Concluídas/faturamento do mês: usa referenceDate (closed_at, fallback opened_at).
    let closedThisMonth = 0
    let revenueThisMonth = 0
    for (const r of rows) {
      const ref = referenceDate(r)
      if (!ref || !isSameMonth(ref, now)) continue
      if (r.status === 'concluida') closedThisMonth += 1
      // OS canceladas não entram no faturamento, mesmo que tenham receita preenchida.
      if (r.status === 'cancelada') continue
      revenueThisMonth += r.revenue ?? 0
    }

    // Turnaround médio sobre as OS com valor finito.
    const turnarounds = rows
      .map((r) => r.turnaround_hours)
      .filter((h): h is number => typeof h === 'number' && Number.isFinite(h))
    const avgTurnaround =
      turnarounds.length > 0
        ? Math.round(turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length)
        : null

    return { open, inProgress, closedThisMonth, revenueThisMonth, avgTurnaround }
  }, [rows])

  // Gráfico 1 — OS por status (apenas status presentes nos dados).
  const statusData = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
    return STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({
      status: statusLabel(s),
      count: counts.get(s) ?? 0,
    }))
  }, [rows])

  // Gráfico 2 — faturamento por mês (period 'YYYY-MM'), ordenado cronologicamente.
  const revenueData = useMemo(() => {
    const byMonth = new Map<string, number>()
    for (const r of rows) {
      const ref = referenceDate(r)
      if (!ref) continue
      // OS canceladas não compõem o faturamento da série temporal.
      if (r.status === 'cancelada') continue
      const key = monthKey(ref)
      byMonth.set(key, (byMonth.get(key) ?? 0) + (r.revenue ?? 0))
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, revenue]) => ({ period, revenue }))
  }, [rows])

  // Lista — OS abertas mais antigas (asc por opened_at), top 8.
  const oldestOpen = useMemo(
    () =>
      rows
        .filter((r) => r.status === 'aberta')
        .sort((a, b) => {
          const ta = a.opened_at ? new Date(a.opened_at).getTime() : Infinity
          const tb = b.opened_at ? new Date(b.opened_at).getTime() : Infinity
          return ta - tb
        })
        .slice(0, 8),
    [rows],
  )

  return (
    <ScreenShell
      title="Oficina — Fast BI"
      subtitle="Volume, faturamento e turnaround das ordens de serviço."
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label="OS abertas" value={kpis.open} />
        <KpiCard label="Em andamento" value={kpis.inProgress} />
        <KpiCard label="Concluídas no mês" value={kpis.closedThisMonth} />
        <KpiCard label="Faturamento do mês" value={formatBRL(kpis.revenueThisMonth)} />
        <KpiCard
          label="Turnaround médio (h)"
          value={kpis.avgTurnaround ?? '—'}
          hint="média das OS com turnaround registrado"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ChartCard
          title="OS por status"
          type="pie"
          data={statusData}
          xKey="status"
          series={[{ key: 'count', label: 'OS' }]}
          valueFormat="number"
          emptyMessage="Nenhuma OS encontrada."
        />
        <ChartCard
          title="Faturamento da oficina no tempo"
          type="line"
          data={revenueData}
          xKey="period"
          series={[{ key: 'revenue', label: 'Faturamento' }]}
          valueFormat="currency"
          emptyMessage="Sem faturamento registrado."
        />
      </div>

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="text-sm font-semibold text-foreground">OS abertas mais antigas</div>
        {oldestOpen.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nenhuma OS aberta no momento.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {oldestOpen.map((r) => (
              <li key={r.entity_id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {r.order_number ?? '—'} · {r.customer ?? 'Cliente não informado'}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.vehicle ?? '—'} · aberta em {formatDateTime(r.opened_at)}
                  </div>
                </div>
                <Badge tone={serviceStatusTone(r.status)}>{statusLabel(r.status)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </ScreenShell>
  )
}
