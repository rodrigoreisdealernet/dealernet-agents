// Vendas (VN/VU) — Fast BI (issue #16). KPIs do mês + gráficos de vendas.
// Lê SOMENTE as views agregadas v_dia_sales_summary / v_dia_sales_trend.
// A linha VN×VU é montada agregando o summary por period_month × condition
// (a trend não tem coluna condition). Sem escrita: dashboard read-only.
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import { useLocale } from '@/i18n/LocaleProvider'
import {
  getSalesSummary,
  getSalesTrend,
  type SalesSummaryRow,
  type SalesTrendRow,
} from '@/portal/lib/agentsApi'
import { ChartCard } from './ChartCard'
import { KpiCard, ScreenShell } from './ui'
import { formatBRLKpi, formatMonthLabel } from './format'
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
  const { locale } = useLocale()
  const [summary, setSummary] = useState<SalesSummaryRow[]>([])
  const [, setTrend] = useState<SalesTrendRow[]>([])
  const [brand, setBrand] = useState<string>(ALL)
  const [store, setStore] = useState<string>(ALL)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
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

  // Meses disponíveis no recorte (period_month distintos, ordenados asc).
  const months = useMemo(() => distinct(filtered.map((r) => r.period_month)), [filtered])

  // Mês selecionado: navegável por setas. Default = último mês; se o recorte muda
  // (troca de marca/loja) e o mês some da lista, reposiciona para o último.
  useEffect(() => {
    if (months.length === 0) {
      if (selectedMonth !== null) setSelectedMonth(null)
      return
    }
    if (!selectedMonth || !months.includes(selectedMonth)) {
      setSelectedMonth(months[months.length - 1])
    }
  }, [months, selectedMonth])

  const monthIndex = selectedMonth ? months.indexOf(selectedMonth) : -1
  const hasPrevMonth = monthIndex > 0
  const hasNextMonth = monthIndex >= 0 && monthIndex < months.length - 1
  const goPrevMonth = () => {
    if (hasPrevMonth) setSelectedMonth(months[monthIndex - 1])
  }
  const goNextMonth = () => {
    if (hasNextMonth) setSelectedMonth(months[monthIndex + 1])
  }

  // KPIs do mês selecionado (VN/VU/total): unidades, receita, margem média e dias p/ vender.
  const kpis = useMemo(() => {
    const rows = filtered.filter((r) => r.period_month === selectedMonth)
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
  }, [filtered, selectedMonth])

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

  // Barras por marca (unidades vendidas no mês selecionado).
  const byBrandData = useMemo<Array<Record<string, unknown>>>(() => {
    const byBrand = new Map<string, number>()
    for (const r of filtered) {
      if (r.period_month !== selectedMonth) continue
      const key = r.brand ?? 'Sem marca'
      byBrand.set(key, (byBrand.get(key) ?? 0) + r.units_sold)
    }
    return Array.from(byBrand.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([brandName, units]) => ({ brand: brandName, units }))
  }, [filtered, selectedMonth])

  // Pizza do mix novos × usados (unidades no mês selecionado).
  const mixData = useMemo<Array<Record<string, unknown>>>(() => {
    let novo = 0
    let usado = 0
    for (const r of filtered) {
      if (r.period_month !== selectedMonth) continue
      if (isVN(r.condition)) novo += r.units_sold
      else usado += r.units_sold
    }
    return [
      { label: t('newVehicles'), units: novo },
      { label: t('usedVehicles'), units: usado },
    ]
  }, [filtered, selectedMonth, t])

  const selectClass = 'rounded-md border border-border bg-card px-3 py-1.5 text-sm'
  const monthNavBtn =
    'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'

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

        <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          {t('month')}
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1">
            <button
              type="button"
              className={monthNavBtn}
              onClick={goPrevMonth}
              disabled={!hasPrevMonth}
              aria-label={t('prevMonth')}
            >
              ◄
            </button>
            <span
              className="min-w-[8.5rem] text-center text-sm font-medium text-foreground"
              aria-live="polite"
            >
              {selectedMonth ? formatMonthLabel(selectedMonth, locale) : '—'}
            </span>
            <button
              type="button"
              className={monthNavBtn}
              onClick={goNextMonth}
              disabled={!hasNextMonth}
              aria-label={t('nextMonth')}
            >
              ►
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label={t('vnUnits')} value={kpis.vnUnits} accent="info" />
        <KpiCard label={t('vuUnits')} value={kpis.vuUnits} accent="success" />
        <KpiCard label={t('totalUnits')} value={kpis.totalUnits} accent="neutral" />
        <KpiCard label={t('daysToSell')} value={Math.round(kpis.avgDaysToSell)} accent="warning" />
        <KpiCard label={t('vnRevenue')} value={formatBRLKpi(kpis.vnRevenue)} accent="info" />
        <KpiCard label={t('vuRevenue')} value={formatBRLKpi(kpis.vuRevenue)} accent="success" />
        <KpiCard label={t('totalRevenue')} value={formatBRLKpi(kpis.totalRevenue)} accent="neutral" />
        <KpiCard label={t('avgMargin')} value={formatBRLKpi(kpis.avgMargin)} accent="warning" />
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
          colorByPoint
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
