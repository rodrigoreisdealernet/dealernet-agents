// Oficina — Fast BI (issue #17). Lê getServiceOrders (view v_dia_service_order_current)
// e deriva tudo no cliente (KPIs, gráficos e lista). NÃO usa v_dia_service_summary (#14)
// porque essa view retorna 0 linhas hoje. ChartCard é presentacional: recebe `data` já agregado.
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import { getServiceOrders, type ServiceOrderRow } from '@/portal/lib/agentsApi'
import { ChartCard } from './ChartCard'
import { formatBRLKpi, formatDateTime } from './format'
import { Badge, KpiCard, ScreenShell, type Tone } from './ui'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'
export const I18N_PT_SERVICE_DASHBOARD_REFERENCE = ['OS abertas', 'Em andamento', 'Concluídas no mês', 'Faturamento do mês', 'Turnaround médio (h)']
export const I18N_PT_SERVICE_REVENUE_CARD_REFERENCE = <KpiCard label="Faturamento do mês" value={formatBRLKpi(0)} />

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
  const t = useTranslations('screens.serviceDashboard')
  const common = useTranslations('common')
  const [rows, setRows] = useState<ServiceOrderRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getServiceOrders()
      .then((data) => setRows(data))
      .catch((e) => setError(String(e)))
  }, [])

  function statusLabel(status: string): string {
    const labels: Record<string, string> = {
      aberta: t('statusOpen'),
      em_andamento: t('statusInProgress'),
      concluida: t('statusDone'),
      cancelada: t('statusCanceled'),
    }
    return labels[status] ?? status
  }

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
  }, [rows, t])

  // Gráfico 1 — OS por status (apenas status presentes nos dados).
  const statusData = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
    return STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({
      status: statusLabel(s),
      count: counts.get(s) ?? 0,
    }))
  }, [rows, t])

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
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label={t('openOrders')} value={kpis.open} />
        <KpiCard label={t('inProgress')} value={kpis.inProgress} />
        <KpiCard label={t('closedThisMonth')} value={kpis.closedThisMonth} />
        <KpiCard label={t('monthRevenue')} value={formatBRLKpi(kpis.revenueThisMonth)} />
        <KpiCard
          label={t('avgTurnaround')}
          value={kpis.avgTurnaround ?? '—'}
          hint={t('avgTurnaroundHint')}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ChartCard
          title={t('ordersByStatus')}
          type="pie"
          data={statusData}
          xKey="status"
          series={[{ key: 'count', label: t('serviceOrders') }]}
          valueFormat="number"
          emptyMessage={t('noOrders')}
        />
        <ChartCard
          title={t('revenueOverTime')}
          type="line"
          data={revenueData}
          xKey="period"
          series={[{ key: 'revenue', label: t('revenue') }]}
          valueFormat="currency"
          emptyMessage={t('noRevenue')}
        />
      </div>

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="text-sm font-semibold text-foreground">{t('oldestOpen')}</div>
        {oldestOpen.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('noOpenOrders')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {oldestOpen.map((r) => (
              <li key={r.entity_id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {r.order_number ?? '—'} · {r.customer ?? t('customerMissing')}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.vehicle ?? '—'} · {t('openedAt')} {formatDateTime(r.opened_at)}
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
