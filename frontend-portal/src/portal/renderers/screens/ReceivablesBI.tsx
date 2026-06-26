// Contas a Receber — Fast BI (agente collections-prioritizer). Lê getReceivables
// (view v_dia_receivable_current, status=aberto) — a MESMA fonte que o agente de
// cobrança prioriza no worker — e deriva tudo no cliente (KPIs, faixas de atraso,
// ranking por cliente e títulos críticos). ChartCard é presentacional: recebe
// `data` já agregado. Read-only: nenhuma escrita parte desta tela.
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import { getReceivables, type ReceivableRow } from '@/portal/lib/agentsApi'
import { ChartCard } from './ChartCard'
import { formatBRL, formatBRLKpi, formatDate } from './format'
import { Badge, KpiCard, ScreenShell, type Tone } from './ui'

// Faixas de atraso (aging). 'a vencer' = sem dias de atraso (due_date no futuro,
// days_overdue=0 na view). As demais agrupam os títulos já vencidos.
const AGING_BUCKETS = ['a_vencer', '1_30', '31_60', '61_90', '90_mais'] as const
type AgingBucket = (typeof AGING_BUCKETS)[number]

function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'a_vencer'
  if (daysOverdue <= 30) return '1_30'
  if (daysOverdue <= 60) return '31_60'
  if (daysOverdue <= 90) return '61_90'
  return '90_mais'
}

// Espelha _severity_for_days do backend (ops_collections.py): >90 critical,
// 31-90 high, 1-30 medium, 0 low. Mantém o portal alinhado ao agente.
function overdueTone(daysOverdue: number): Tone {
  if (daysOverdue > 90) return 'danger'
  if (daysOverdue >= 31) return 'warning'
  if (daysOverdue >= 1) return 'info'
  return 'neutral'
}

interface CustomerRollup {
  customerId: string
  customerName: string
  exposure: number
  overdueExposure: number
  maxDaysOverdue: number
  count: number
}

export default function ReceivablesBI() {
  const t = useTranslations('screens.receivablesBI')
  const common = useTranslations('common')
  const [rows, setRows] = useState<ReceivableRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getReceivables()
      .then((data) => setRows(data))
      .catch((e) => setError(String(e)))
  }, [])

  const kpis = useMemo(() => {
    let openTotal = 0
    let overdueTotal = 0
    let maxDaysOverdue = 0
    const customers = new Set<string>()
    for (const r of rows) {
      const balance = r.balance ?? 0
      const days = r.days_overdue ?? 0
      openTotal += balance
      if (days > 0) overdueTotal += balance
      if (days > maxDaysOverdue) maxDaysOverdue = days
      if (r.customer_id) customers.add(r.customer_id)
    }
    const avgTicket = rows.length > 0 ? openTotal / rows.length : 0
    return {
      openTotal,
      overdueTotal,
      customers: customers.size,
      titles: rows.length,
      maxDaysOverdue,
      avgTicket,
    }
  }, [rows])

  // Gráfico 1 — exposição por faixa de atraso (ordem estável das faixas).
  const agingData = useMemo(() => {
    const totals = new Map<AgingBucket, number>()
    for (const r of rows) {
      const bucket = agingBucket(r.days_overdue ?? 0)
      totals.set(bucket, (totals.get(bucket) ?? 0) + (r.balance ?? 0))
    }
    return AGING_BUCKETS.map((bucket) => ({
      bucket: t(`aging_${bucket}`),
      exposure: totals.get(bucket) ?? 0,
    }))
  }, [rows, t])

  // Rollup por cliente — soma exposição e exposição vencida, guarda o pior atraso.
  const customerRollup = useMemo<CustomerRollup[]>(() => {
    const byCustomer = new Map<string, CustomerRollup>()
    for (const r of rows) {
      const customerId = r.customer_id ?? r.entity_id
      const balance = r.balance ?? 0
      const days = r.days_overdue ?? 0
      const existing =
        byCustomer.get(customerId) ??
        {
          customerId,
          customerName: r.customer_name ?? t('customerMissing'),
          exposure: 0,
          overdueExposure: 0,
          maxDaysOverdue: 0,
          count: 0,
        }
      existing.exposure += balance
      if (days > 0) existing.overdueExposure += balance
      existing.maxDaysOverdue = Math.max(existing.maxDaysOverdue, days)
      existing.count += 1
      byCustomer.set(customerId, existing)
    }
    return [...byCustomer.values()].sort(
      (a, b) => b.overdueExposure - a.overdueExposure || b.exposure - a.exposure,
    )
  }, [rows, t])

  // Gráfico 2 — top clientes por exposição vencida (apenas com saldo vencido).
  const topOverdueCustomers = useMemo(
    () =>
      customerRollup
        .filter((c) => c.overdueExposure > 0)
        .slice(0, 8)
        .map((c) => ({ customer: c.customerName, exposure: c.overdueExposure })),
    [customerRollup],
  )

  // Lista — títulos vencidos mais críticos (desc por dias de atraso, depois saldo).
  const criticalTitles = useMemo(
    () =>
      rows
        .filter((r) => (r.days_overdue ?? 0) > 0)
        .sort(
          (a, b) =>
            (b.days_overdue ?? 0) - (a.days_overdue ?? 0) ||
            (b.balance ?? 0) - (a.balance ?? 0),
        )
        .slice(0, 8),
    [rows],
  )

  return (
    <ScreenShell title={t('title')} subtitle={t('subtitle')} legend={common('valuesInBRL')}>
      {error && (
        <p className="text-sm text-destructive">
          {common('error')}: {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label={t('openTotal')} value={formatBRLKpi(kpis.openTotal)} />
        <KpiCard label={t('overdueTotal')} value={formatBRLKpi(kpis.overdueTotal)} accent="danger" />
        <KpiCard label={t('customers')} value={kpis.customers} />
        <KpiCard label={t('titles')} value={kpis.titles} />
        <KpiCard label={t('maxDaysOverdue')} value={kpis.maxDaysOverdue} hint={t('maxDaysOverdueHint')} />
        <KpiCard label={t('avgTicket')} value={formatBRLKpi(kpis.avgTicket)} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ChartCard
          title={t('exposureByAging')}
          type="bar"
          data={agingData}
          xKey="bucket"
          series={[{ key: 'exposure', label: t('exposure') }]}
          valueFormat="currency"
          emptyMessage={t('noReceivables')}
        />
        <ChartCard
          title={t('topOverdueCustomers')}
          type="bar"
          data={topOverdueCustomers}
          xKey="customer"
          series={[{ key: 'exposure', label: t('overdueExposure') }]}
          valueFormat="currency"
          emptyMessage={t('noOverdue')}
        />
      </div>

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="text-sm font-semibold text-foreground">{t('criticalTitles')}</div>
        {criticalTitles.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('noOverdue')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {criticalTitles.map((r) => (
              <li key={r.entity_id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {r.document_number ?? '—'} · {r.customer_name ?? t('customerMissing')}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {formatBRL(r.balance)} · {t('dueOn')} {formatDate(r.due_date)}
                    {r.collector_name ? ` · ${t('collector')}: ${r.collector_name}` : ''}
                  </div>
                </div>
                <Badge tone={overdueTone(r.days_overdue ?? 0)}>
                  {t('daysOverdue', { days: r.days_overdue ?? 0 })}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </ScreenShell>
  )
}
