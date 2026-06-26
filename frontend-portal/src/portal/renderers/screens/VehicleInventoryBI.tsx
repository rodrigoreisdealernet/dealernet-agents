// Fast BI de Estoque de Veículos — dashboard read-only de idade do estoque + floor plan.
// Lê v_dia_inventory_summary e v_dia_vehicle_current via agentsApi.
// Filtros inline (Marca + Empresa) + seletor de métrica que dirige os dois gráficos.
// KPIs recalculados a partir dos veículos filtrados (status em_estoque).
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  getInventorySummary,
  getVehicles,
  type InventorySummaryRow,
  type VehicleRow,
} from '@/portal/lib/agentsApi'
import { ChartCard } from './ChartCard'
import { formatBRLKpi } from './format'
import { KpiCard, ScreenShell } from './ui'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'
export const I18N_PT_VEHICLE_INVENTORY_BI_REFERENCE = ['Carregando…', 'Nenhum veículo em estoque.']

const AGE_BANDS = ['0-30', '31-60', '61-90', '90+']

const ALL = '__all__'

type Metric = 'inventory_value' | 'floor_plan_cost'

function distinct(values: Array<string | null>): string[] {
  const set = new Set<string>()
  for (const v of values) if (v) set.add(v)
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'))
}

const selectClass = 'rounded-md border border-border bg-card px-3 py-1.5 text-sm'

export default function VehicleInventoryBI() {
  const t = useTranslations('screens.vehicleInventoryBI')
  const common = useTranslations('common')
  const [summary, setSummary] = useState<InventorySummaryRow[]>([])
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [brand, setBrand] = useState<string>(ALL)
  const [empresa, setEmpresa] = useState<string>(ALL)
  const [metric, setMetric] = useState<Metric>('inventory_value')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getInventorySummary().catch(() => [] as InventorySummaryRow[]),
      getVehicles().catch(() => [] as VehicleRow[]),
    ])
      .then(([s, v]) => {
        setSummary(s)
        setVehicles(v)
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
  }, [])

  // Opções dos seletores (valores distintos do summary).
  const brandOptions = useMemo(() => distinct(summary.map((r) => r.brand)), [summary])
  const empresaOptions = useMemo(() => distinct(summary.map((r) => r.store)), [summary])

  // Summary filtrado por marca/empresa (empresa = store neste modelo).
  const filteredSummary = useMemo(
    () =>
      summary.filter(
        (r) =>
          (brand === ALL || r.brand === brand) &&
          (empresa === ALL || r.store === empresa),
      ),
    [summary, brand, empresa],
  )

  // Veículos em estoque, filtrados por marca/empresa. Base dos KPIs e da tabela.
  const filteredVehicles = useMemo(
    () =>
      vehicles.filter(
        (v) =>
          v.status === 'em_estoque' &&
          (brand === ALL || v.brand === brand) &&
          (empresa === ALL || v.store === empresa),
      ),
    [vehicles, brand, empresa],
  )

  // KPIs recalculados a partir dos veículos filtrados.
  const kpis = useMemo(() => {
    let inventoryValue = 0
    let floorPlanTotal = 0
    let daysSum = 0
    let daysCount = 0
    let aged90 = 0
    for (const v of filteredVehicles) {
      inventoryValue += v.cost ?? 0
      floorPlanTotal += v.floor_plan_cost ?? 0
      if (typeof v.days_in_stock === 'number') {
        daysSum += v.days_in_stock
        daysCount += 1
        if (v.days_in_stock > 90) aged90 += 1
      }
    }
    return {
      inventoryValue,
      floorPlanTotal,
      avgDays: daysCount > 0 ? Math.round(daysSum / daysCount) : 0,
      aged90,
    }
  }, [filteredVehicles])

  const metricLabel = metric === 'inventory_value' ? t('metricInventoryValue') : t('metricFloorPlan')

  // Gráfico por faixa de idade (soma a métrica selecionada por faixa).
  const ageBandChart = useMemo<Array<Record<string, unknown>>>(() => {
    if (filteredSummary.length === 0) return []
    const byBand = new Map<string, { inventory_value: number; floor_plan_cost: number }>()
    for (const band of AGE_BANDS) byBand.set(band, { inventory_value: 0, floor_plan_cost: 0 })
    for (const row of filteredSummary) {
      const bucket = byBand.get(row.age_band) ?? { inventory_value: 0, floor_plan_cost: 0 }
      bucket.inventory_value += row.inventory_value ?? 0
      bucket.floor_plan_cost += row.floor_plan_cost ?? 0
      byBand.set(row.age_band, bucket)
    }
    return AGE_BANDS.map((age_band) => {
      const bucket = byBand.get(age_band) ?? { inventory_value: 0, floor_plan_cost: 0 }
      return { age_band, ...bucket }
    })
  }, [filteredSummary])

  // Gráfico por marca (agrupa só por brand, somando a métrica entre lojas/faixas).
  const brandChart = useMemo<Array<Record<string, unknown>>>(() => {
    const byBrand = new Map<string, { brand: string; inventory_value: number; floor_plan_cost: number }>()
    for (const row of filteredSummary) {
      const key = row.brand ?? t('noBrand')
      const bucket = byBrand.get(key) ?? { brand: key, inventory_value: 0, floor_plan_cost: 0 }
      bucket.inventory_value += row.inventory_value ?? 0
      bucket.floor_plan_cost += row.floor_plan_cost ?? 0
      byBrand.set(key, bucket)
    }
    return Array.from(byBrand.values()).sort(
      (a, b) => (b[metric] as number) - (a[metric] as number),
    )
  }, [filteredSummary, metric, t])

  // Tabela: veículos em estoque filtrados, ordenados por floor plan desc.
  const oldestVehicles = useMemo(
    () =>
      filteredVehicles
        .slice()
        .sort((a, b) => (b.floor_plan_cost ?? 0) - (a.floor_plan_cost ?? 0)),
    [filteredVehicles],
  )

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}
      {loading && <p className="text-sm text-muted-foreground">{common('loading')}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('brand')}
          <select className={selectClass} value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value={ALL}>{t('all')}</option>
            {brandOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('company')}
          <select className={selectClass} value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value={ALL}>{t('allCompanies')}</option>
            {empresaOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t('metric')}
          <select
            className={selectClass}
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
          >
            <option value="inventory_value">{t('metricInventoryValue')}</option>
            <option value="floor_plan_cost">{t('metricFloorPlan')}</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label={t('inventoryValue')} value={formatBRLKpi(kpis.inventoryValue)} />
        <KpiCard label={t('floorPlanTotal')} value={formatBRLKpi(kpis.floorPlanTotal)} />
        <KpiCard label={t('avgStockDays')} value={kpis.avgDays} />
        <KpiCard label={t('aged90')} value={kpis.aged90} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title={t('metricByAge', { metric: metricLabel })}
          type="bar"
          data={ageBandChart}
          xKey="age_band"
          series={[{ key: metric, label: metricLabel, format: 'currency' }]}
          valueFormat="currency"
          colorByPoint
          emptyMessage={t('noAgeStockData')}
        />
        <ChartCard
          title={t('metricByBrand', { metric: metricLabel })}
          type="bar"
          data={brandChart}
          xKey="brand"
          series={[{ key: metric, label: metricLabel, format: 'currency' }]}
          valueFormat="currency"
          colorByPoint
          emptyMessage={t('noBrandData')}
        />
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">{t('criticalVehicles')}</h2>
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">{t('vehicle')}</th>
                <th className="px-3 py-2 text-right">{t('daysInStock')}</th>
                <th className="px-3 py-2 text-right">{t('floorPlan')}</th>
                <th className="px-3 py-2">{t('store')}</th>
              </tr>
            </thead>
            <tbody>
              {oldestVehicles.map((vehicle) => (
                <tr
                  key={vehicle.entity_id}
                  className="border-b border-border last:border-0 hover:bg-muted/30"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">
                      {[vehicle.brand, vehicle.model, vehicle.model_year].filter(Boolean).join(' ') || '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {vehicle.days_in_stock ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatBRLKpi(vehicle.floor_plan_cost ?? 0)}
                  </td>
                  <td className="px-3 py-2">{vehicle.store ?? '—'}</td>
                </tr>
              ))}
              {oldestVehicles.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {t('noVehiclesInStock')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </ScreenShell>
  )
}
