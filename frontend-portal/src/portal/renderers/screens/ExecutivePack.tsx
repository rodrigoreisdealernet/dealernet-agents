// Executive / Owner Pack — KPIs do dono + receita recuperável (conecta a IA ao bolso).
// Lê v_home_dashboard_kpis + ops_finding_kpis.
import { useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import { getFindingKpis, getHomeKpis, type FindingKpis, type HomeKpis } from '@/portal/lib/agentsApi'
import { KpiCard, ScreenShell } from './ui'
import { formatBRLKpi, formatPct } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

export default function ExecutivePack() {
  const t = useTranslations('screens.executivePack')
  const common = useTranslations('common')
  const [home, setHome] = useState<HomeKpis | null>(null)
  const [kpis, setKpis] = useState<FindingKpis | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([getHomeKpis().catch(() => null), getFindingKpis().catch(() => null)])
      .then(([h, k]) => {
        setHome(h)
        setKpis(k)
      })
      .catch((e) => setError(String(e)))
  }, [])

  const revDelta =
    home && home.prior_period_revenue
      ? ((home.period_revenue - home.prior_period_revenue) / home.prior_period_revenue) * 100
      : null

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard
          label={t('periodRevenue')}
          value={formatBRLKpi(home?.period_revenue)}
          hint={
            revDelta != null
              ? `${revDelta >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(revDelta))}% ${t('vsPrevious')}`
              : undefined
          }
        />
        <KpiCard
          label={t('recoverableAi')}
          value={formatBRLKpi(kpis?.recoverable_delta)}
          hint={`${kpis?.pending_count ?? 0} ${t('pendingApproval')}`}
        />
        <KpiCard label={t('approvedCycle')} value={kpis?.approved_this_cycle ?? '—'} />
        <KpiCard label={t('activeDeals')} value={home?.assets_on_rent ?? '—'} />
        <KpiCard label={t('capacityUse')} value={formatPct(home?.fleet_utilization_pct)} />
        <KpiCard label={t('overdueActions')} value={home?.overdue_returns_count ?? '—'} />
      </div>
    </ScreenShell>
  )
}
