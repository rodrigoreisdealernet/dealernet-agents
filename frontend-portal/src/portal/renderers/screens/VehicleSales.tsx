// Vehicle Sales — visão de veículos vendidos (issue #130).
// Lista correntes de v_dia_vehicle_current filtrando status = 'vendido'.
// Tela read-only: marcar um veículo como vendido continua sendo feito na edição
// de Estoque de Veículos (não há RPC de "registrar venda" aqui).
// Leitura direta (RLS authenticated); sem INSERT/UPDATE.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import { getVehicles, type VehicleRow } from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell } from './ui'
import { formatBRLKpi } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

export default function VehicleSales() {
  const t = useTranslations('screens.vehicleSales')
  const common = useTranslations('common')
  const [rows, setRows] = useState<VehicleRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    getVehicles()
      .then((r) => {
        // issue #130 — Vendas mostra apenas veículos vendidos.
        setRows(r.filter((v) => v.status === 'vendido'))
        setError(null)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const kpis = useMemo(() => {
    const total = rows.length
    const revenue = rows.reduce((s, r) => s + (r.sale_price ?? 0), 0)
    return { total, revenue }
  }, [rows])

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-2">
        <KpiCard label={t('unitsSold')} value={kpis.total} />
        <KpiCard label={t('revenue')} value={formatBRLKpi(kpis.revenue)} />
      </div>

      <h2 className="text-sm font-semibold text-foreground">{t('soldVehicles')}</h2>

      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">{t('vehicle')}</th>
              <th className="px-3 py-2">{t('condition')}</th>
              <th className="px-3 py-2 text-right">{t('salePrice')}</th>
              <th className="px-3 py-2">{t('purchaseDate')}</th>
              <th className="px-3 py-2">{common('status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entity_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.name ?? `${r.brand} ${r.model}`}</div>
                  <div className="text-xs text-muted-foreground">{r.store ?? '—'}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={r.condition === 'novo' ? 'info' : 'neutral'}>{r.condition}</Badge>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRLKpi(r.sale_price)}</td>
                <td className="px-3 py-2">{r.purchase_date ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge tone="success">{r.status}</Badge>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('noSales')}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {common('loading')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ScreenShell>
  )
}
