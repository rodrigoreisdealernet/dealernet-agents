// Visão do Dono (Fast BI, issue #15) — brief matinal do negócio num só lugar.
// Lê v_dia_owner_kpis + v_dia_sales_trend + v_dia_inventory_summary via agentsApi.
import { useEffect, useState } from 'react'
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
import { formatBRL } from './format'

export default function DiaOverview() {
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
      title="Visão do Dono"
      subtitle="Brief matinal do negócio: vendas, oficina, estoque e peças num só lugar."
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}
      {loading && !kpis && <p className="text-sm text-muted-foreground">Carregando…</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard
          label="Vendas do mês"
          value={kpis?.sales_units_month ?? '—'}
          hint={formatBRL(kpis?.sales_revenue_month)}
        />
        <KpiCard label="Margem do mês" value={formatBRL(kpis?.margin_month)} />
        <KpiCard label="OS abertas" value={kpis?.service_orders_open ?? '—'} />
        <KpiCard label="Faturamento de oficina" value={formatBRL(kpis?.service_revenue_month)} />
        <KpiCard label="Estoque de veículos" value={formatBRL(kpis?.inventory_vehicle_value)} />
        <KpiCard label="Floor plan total" value={formatBRL(kpis?.floor_plan_total)} />
        <KpiCard label="Estoque de peças" value={formatBRL(kpis?.parts_inventory_value)} />
        <KpiCard label="Peças críticas" value={kpis?.parts_critical_count ?? '—'} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Tendência de vendas (90 dias)"
          type="line"
          data={salesTrend as unknown as Array<Record<string, unknown>>}
          xKey="sale_date"
          series={[
            { key: 'revenue', label: 'Receita', format: 'currency' },
            { key: 'units_sold', label: 'Unidades', format: 'number' },
          ]}
          valueFormat="number"
          emptyMessage="Sem vendas no período"
        />
        <ChartCard
          title="Estoque por faixa de idade"
          type="bar"
          data={inventory as unknown as Array<Record<string, unknown>>}
          xKey="age_band"
          series={[
            { key: 'vehicles_count', label: 'Veículos' },
            { key: 'inventory_value', label: 'Valor (R$)', format: 'currency' },
          ]}
          valueFormat="number"
          emptyMessage="Sem veículos em estoque"
        />
      </div>
    </ScreenShell>
  )
}
