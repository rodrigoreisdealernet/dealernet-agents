// Fast BI de Estoque de Veículos — dashboard read-only de idade do estoque + floor plan.
// Lê v_dia_owner_kpis, v_dia_inventory_summary e v_dia_vehicle_current via agentsApi.
// Padrão da ExecutivePack: useEffect + Promise.all + grid de KpiCard + ScreenShell.
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  getInventorySummary,
  getOwnerKpis,
  getVehicles,
  type InventorySummaryRow,
  type OwnerKpis,
  type VehicleRow,
} from '@/portal/lib/agentsApi'
import { ChartCard } from './ChartCard'
import { formatBRL, formatBRLKpi } from './format'
import { KpiCard, ScreenShell } from './ui'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'
export const I18N_PT_VEHICLE_INVENTORY_BI_REFERENCE = ['Carregando…', 'Nenhum veículo em estoque.']

const AGE_BANDS = ['0-30', '31-60', '61-90', '90+']

export default function VehicleInventoryBI() {
  const t = useTranslations('screens.vehicleInventoryBI')
  const common = useTranslations('common')
  const [kpis, setKpis] = useState<OwnerKpis | null>(null)
  const [summary, setSummary] = useState<InventorySummaryRow[]>([])
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getOwnerKpis().catch(() => null),
      getInventorySummary().catch(() => [] as InventorySummaryRow[]),
      getVehicles().catch(() => [] as VehicleRow[]),
    ])
      .then(([k, s, v]) => {
        setKpis(k)
        setSummary(s)
        setVehicles(v)
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
  }, [])

  const agedVehiclesCount = useMemo(
    () =>
      summary
        .filter((r) => r.age_band === '90+')
        .reduce((total, r) => total + (r.vehicles_count ?? 0), 0),
    [summary],
  )

  const ageBandChart = useMemo<Array<Record<string, unknown>>>(() => {
    if (summary.length === 0) return []
    const byBand = new Map<string, { floor_plan_cost: number; inventory_value: number }>()
    for (const band of AGE_BANDS) byBand.set(band, { floor_plan_cost: 0, inventory_value: 0 })
    for (const row of summary) {
      const bucket = byBand.get(row.age_band) ?? { floor_plan_cost: 0, inventory_value: 0 }
      bucket.floor_plan_cost += row.floor_plan_cost ?? 0
      bucket.inventory_value += row.inventory_value ?? 0
      byBand.set(row.age_band, bucket)
    }
    return AGE_BANDS.map((age_band) => {
      const bucket = byBand.get(age_band) ?? { floor_plan_cost: 0, inventory_value: 0 }
      return { age_band, ...bucket }
    })
  }, [summary])

  const brandStoreChart = useMemo<Array<Record<string, unknown>>>(() => {
    const byBrandStore = new Map<
      string,
      { brand_store: string; floor_plan_cost: number; inventory_value: number }
    >()
    for (const row of summary) {
      const brand = row.brand ?? t('noBrand')
      const store = row.store ?? t('noStore')
      const key = `${brand} — ${store}`
      const bucket = byBrandStore.get(key) ?? {
        brand_store: key,
        floor_plan_cost: 0,
        inventory_value: 0,
      }
      bucket.floor_plan_cost += row.floor_plan_cost ?? 0
      bucket.inventory_value += row.inventory_value ?? 0
      byBrandStore.set(key, bucket)
    }
    return Array.from(byBrandStore.values()).sort(
      (a, b) => b.floor_plan_cost - a.floor_plan_cost,
    )
  }, [summary, t])

  const oldestVehicles = useMemo(
    () =>
      vehicles
        .filter((v) => v.status === 'em_estoque')
        .slice()
        .sort((a, b) => (b.floor_plan_cost ?? 0) - (a.floor_plan_cost ?? 0)),
    [vehicles],
  )

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}
      {loading && 'Carregando…' && <p className="text-sm text-muted-foreground">{common('loading')}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label={t('inventoryValue')} value={formatBRLKpi(kpis?.inventory_vehicle_value ?? 0)} />
        <KpiCard label={t('floorPlanTotal')} value={formatBRLKpi(kpis?.floor_plan_total ?? 0)} />
        <KpiCard label={t('avgStockDays')} value={Math.round(kpis?.avg_days_in_stock ?? 0)} />
        <KpiCard label={t('aged90')} value={agedVehiclesCount} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title={t('floorPlanByAge')}
          type="bar"
          data={ageBandChart}
          xKey="age_band"
          series={[
            { key: 'floor_plan_cost', label: t('floorPlan'), format: 'currency' },
            { key: 'inventory_value', label: t('inventoryValue'), format: 'currency' },
          ]}
          valueFormat="currency"
          emptyMessage={t('noAgeStockData')}
        />
        <ChartCard
          title={t('floorPlanByBrandStore')}
          type="bar"
          data={brandStoreChart}
          xKey="brand_store"
          series={[
            { key: 'floor_plan_cost', label: t('floorPlan'), format: 'currency' },
            { key: 'inventory_value', label: t('inventoryValue'), format: 'currency' },
          ]}
          valueFormat="currency"
          emptyMessage={t('noBrandStoreData')}
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
                    {formatBRL(vehicle.floor_plan_cost ?? 0)}
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
