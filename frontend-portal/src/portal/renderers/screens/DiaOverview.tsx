// Visão do Dono (Fast BI, issue #15) — brief matinal do negócio num só lugar.
// Lê v_dia_owner_kpis + v_dia_sales_trend + v_dia_inventory_summary via agentsApi.
import { useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  getInventorySummary,
  getOwnerKpis,
  getSalesTrend,
  type InventorySummaryRow,
  type OwnerKpis,
  type SalesTrendRow,
} from '@/portal/lib/agentsApi'
import { KpiCard, ScreenShell } from './ui'
import { ChartCard } from './ChartCard'
import { formatBRLKpi } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

export default function DiaOverview() {
  const t = useTranslations('screens.diaOverview')
  const common = useTranslations('common')
  const [kpis, setKpis] = useState<OwnerKpis | null>(null)
  const [salesTrend, setSalesTrend] = useState<SalesTrendRow[]>([])
  const [inventory, setInventory] = useState<InventorySummaryRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getOwnerKpis().catch(() => null),
      getSalesTrend().catch(() => []),
      getInventorySummary().catch(() => []),
    ])
      .then(([k, s, i]) => {
        setKpis(k)
        setSalesTrend(s)
        setInventory(i)
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
  }, [])

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}
      {loading && !kpis && <p className="text-sm text-muted-foreground">{common('loading')}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard
          label={t('monthSales')}
          value={kpis?.sales_units_month ?? '—'}
          hint={formatBRLKpi(kpis?.sales_revenue_month)}
        />
        <KpiCard label={t('monthMargin')} value={formatBRLKpi(kpis?.margin_month)} />
        <KpiCard label={t('openServiceOrders')} value={kpis?.service_orders_open ?? '—'} />
        <KpiCard label={t('serviceRevenue')} value={formatBRLKpi(kpis?.service_revenue_month)} />
        <KpiCard label={t('vehicleInventory')} value={formatBRLKpi(kpis?.inventory_vehicle_value)} />
        <KpiCard label={t('floorPlanTotal')} value={formatBRLKpi(kpis?.floor_plan_total)} />
        <KpiCard label={t('partsInventory')} value={formatBRLKpi(kpis?.parts_inventory_value)} />
        <KpiCard label={t('criticalParts')} value={kpis?.parts_critical_count ?? '—'} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title={t('salesTrendTitle')}
          type="line"
          data={salesTrend as unknown as Array<Record<string, unknown>>}
          xKey="sale_date"
          series={[
            { key: 'revenue', label: t('revenue'), format: 'currency' },
            { key: 'units_sold', label: t('units'), format: 'number' },
          ]}
          valueFormat="number"
          emptyMessage={t('noSales')}
        />
        <ChartCard
          title={t('inventoryAgeTitle')}
          type="bar"
          data={inventory as unknown as Array<Record<string, unknown>>}
          xKey="age_band"
          series={[
            { key: 'vehicles_count', label: t('vehicles') },
            { key: 'inventory_value', label: t('valueBRL'), format: 'currency' },
          ]}
          valueFormat="number"
          emptyMessage={t('noVehicles')}
        />
      </div>
    </ScreenShell>
  )
}
