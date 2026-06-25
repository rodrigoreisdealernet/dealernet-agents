// Vendas (VN/VU) — Fast BI (issue #16). KPIs do mês + gráficos de vendas.
// Lê SOMENTE as views agregadas v_dia_sales_summary / v_dia_sales_trend.
// A linha VN×VU é montada agregando o summary por period_month × condition
// (a trend não tem coluna condition). Sem escrita: dashboard read-only.
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  getSalesSummary,
  getSalesTrend,
  type SalesSummaryRow,
  type SalesTrendRow,
} from '@/portal/lib/agentsApi'
import { ChartCard } from './ChartCard'
import { KpiCard, ScreenShell } from './ui'
import { formatBRLKpi } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'
export const I18N_PT_SALES_DASHBOARD_REFERENCE = ['Unidades VN', 'Unidades VU', 'Unidades total', 'Dias p/ vender', 'Receita VN', 'Receita VU', 'Receita total', 'Margem média', 'Novos (VN)', 'Usados (VU)']

const ALL = '__all__'

function isVN(condition: string): boolean {
  return condition === 'novo'
}

function distinct(values: Array<string | null>): string[] {
  const set = new Set<string>()
  for (const v of values) if (v) set.add(v)
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'))
}

export default function SalesDashboard() {
  const t = useTranslations('screens.salesDashboard')
  const common = useTranslations('common')
  const [summary, setSummary] = useState<SalesSummaryRow[]>([])
  const [, setTrend] = useState<SalesTrendRow[]>([])
  const [brand, setBrand] = useState<string>(ALL)
  const [store, setStore] = useState<string>(ALL)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([getSalesSummary(), getSalesTrend()])
      .then(([s, t]) => {
        setSummary(s)
        setTrend(t)
      })
      .catch((e) => setError(String(e)))
  }, [])

  // Listas de opções dos seletores (valores distintos do summary).
  const brandOptions = useMemo(() => distinct(summary.map((r) => r.brand)), [summary])
  const storeOptions = useMemo(() => distinct(summary.map((r) => r.store)), [summary])

  // Linhas filtradas por marca/loja (a opção "todas" não filtra).
  const filtered = useMemo(
    () =>
      summary.filter(
        (r) =>
          (brand === ALL || r.brand === brand) && (store === ALL || r.store === store),
      ),
    [summary, brand, store],
  )

  // "Mês atual" = último period_month presente nos dados filtrados (seeds-friendly).
  const currentMonth = useMemo(() => {
    let max: string | null = null
    for (const r of filtered) if (!max || r.period_month > max) max = r.period_month
    return max
  }, [filtered])

  // KPIs do mês atual (VN/VU/total): unidades, receita, margem média e dias p/ vender.
  const kpis = useMemo(() => {
    const rows = filtered.filter((r) => r.period_month === currentMonth)
    let vnUnits = 0
    let vuUnits = 0
    let vnRevenue = 0
    let vuRevenue = 0
    let totalMargin = 0
    let daysWeighted = 0
    for (const r of rows) {
      if (isVN(r.condition)) {
        vnUnits += r.units_sold
        vnRevenue += r.revenue
      } else {
        vuUnits += r.units_sold
        vuRevenue += r.revenue
      }
      totalMargin += r.margin
      daysWeighted += r.avg_days_to_sell * r.units_sold
    }
    const totalUnits = vnUnits + vuUnits
    return {
      vnUnits,
      vuUnits,
      totalUnits,
      vnRevenue,
      vuRevenue,
      totalRevenue: vnRevenue + vuRevenue,
      avgMargin: totalUnits > 0 ? totalMargin / totalUnits : 0,
      avgDaysToSell: totalUnits > 0 ? daysWeighted / totalUnits : 0,
    }
  }, [filtered, currentMonth])

  // Linha VN×VU ao longo do tempo: agrega o summary por period_month × condition.
  const trendData = useMemo<Array<Record<string, unknown>>>(() => {
    const byMonth = new Map<string, { novo: number; usado: number }>()
    for (const r of filtered) {
      const bucket = byMonth.get(r.period_month) ?? { novo: 0, usado: 0 }
      if (isVN(r.condition)) bucket.novo += r.units_sold
      else bucket.usado += r.units_sold
      byMonth.set(r.period_month, bucket)
    }
    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({ period, novo: v.novo, usado: v.usado }))
  }, [filtered])

  // Barras por marca (unidades vendidas, todos os meses do recorte).
  const byBrandData = useMemo<Array<Record<string, unknown>>>(() => {
    const byBrand = new Map<string, number>()
    for (const r of filtered) {
      const key = r.brand ?? 'Sem marca'
      byBrand.set(key, (byBrand.get(key) ?? 0) + r.units_sold)
    }
    return Array.from(byBrand.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([brandName, units]) => ({ brand: brandName, units }))
  }, [filtered])

  // Pizza do mix novos × usados (unidades, todos os meses do recorte).
  const mixData = useMemo<Array<Record<string, unknown>>>(() => {
    let novo = 0
    let usado = 0
    for (const r of filtered) {
      if (isVN(r.condition)) novo += r.units_sold
      else usado += r.units_sold
    }
    return [
      { label: t('newVehicles'), units: novo },
      { label: t('usedVehicles'), units: usado },
    ]
  }, [filtered])

  const selectClass = 'rounded-md border border-border bg-card px-3 py-1.5 text-sm'

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('brand')}
          <select
            className={selectClass}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
          >
            <option value={ALL}>{t('all')}</option>
            {brandOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('store')}
          <select
            className={selectClass}
            value={store}
            onChange={(e) => setStore(e.target.value)}
          >
            <option value={ALL}>{t('allStores')}</option>
            {storeOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label={t('vnUnits')} value={kpis.vnUnits} />
        <KpiCard label={t('vuUnits')} value={kpis.vuUnits} />
        <KpiCard label={t('totalUnits')} value={kpis.totalUnits} />
        <KpiCard label={t('daysToSell')} value={Math.round(kpis.avgDaysToSell)} />
        <KpiCard label={t('vnRevenue')} value={formatBRLKpi(kpis.vnRevenue)} />
        <KpiCard label={t('vuRevenue')} value={formatBRLKpi(kpis.vuRevenue)} />
        <KpiCard label={t('totalRevenue')} value={formatBRLKpi(kpis.totalRevenue)} />
        <KpiCard label={t('avgMargin')} value={formatBRLKpi(kpis.avgMargin)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title={t('salesOverTime')}
          type="line"
          data={trendData}
          xKey="period"
          series={[
            { key: 'novo', label: t('newVehicles') },
            { key: 'usado', label: t('usedVehicles') },
          ]}
          valueFormat="number"
        />
        <ChartCard
          title={t('salesByBrand')}
          type="bar"
          data={byBrandData}
          xKey="brand"
          series={[{ key: 'units', label: t('units') }]}
          valueFormat="number"
        />
        <ChartCard
          title={t('mixTitle')}
          type="pie"
          data={mixData}
          xKey="label"
          series={[{ key: 'units', label: t('units') }]}
          valueFormat="number"
        />
      </div>
    </ScreenShell>
  )
}
