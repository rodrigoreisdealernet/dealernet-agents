// Fast BI de Peças (issue #18) — dashboard read-only do estoque + vendas de peças.
// Lê v_dia_owner_kpis (valor de estoque + nº de peças críticas), v_dia_parts_summary
// (inventário por estado + vendas por mês) e v_dia_parts_critical (lista crítica).
// Padrão da ExecutivePack: useEffect + Promise.all + grid de KpiCard + ScreenShell.
import { useEffect, useMemo, useState } from 'react'
import {
  getCriticalParts,
  getDiaOwnerKpis,
  getPartsSummary,
  type DiaOwnerKpis,
  type PartRow,
  type PartsSummaryRow,
  type PartStockStatus,
} from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell, type Tone } from './ui'
import { formatBRL } from './format'
import { ChartCard } from './ChartCard'

// Mesmo mapeamento de estado de estoque da tela de cadastro (PartsInventory.tsx).
const STOCK_LABEL: Record<string, string> = {
  zerado: 'zerado',
  critico: 'crítico',
  baixo: 'baixo',
  ok: 'ok',
}

function stockTone(s: PartStockStatus | null | undefined): Tone {
  switch ((s ?? '').toLowerCase()) {
    case 'zerado':
      return 'danger'
    case 'critico':
      return 'danger'
    case 'baixo':
      return 'warning'
    default:
      return 'success'
  }
}

export default function PartsBI() {
  const [kpis, setKpis] = useState<DiaOwnerKpis | null>(null)
  const [summary, setSummary] = useState<PartsSummaryRow[]>([])
  const [critical, setCritical] = useState<PartRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      getDiaOwnerKpis().catch(() => null),
      getPartsSummary().catch(() => [] as PartsSummaryRow[]),
      getCriticalParts().catch(() => [] as PartRow[]),
    ])
      .then(([k, s, c]) => {
        setKpis(k)
        setSummary(s)
        setCritical(c)
      })
      .catch((e) => setError(String(e)))
  }, [])

  // Separa as linhas do UNION: inventário (period_month nulo) x vendas (period_month set).
  const inventoryRows = useMemo(
    () => summary.filter((r) => r.period_month == null),
    [summary],
  )
  const salesRows = useMemo(
    () => summary.filter((r) => r.period_month != null),
    [summary],
  )

  // Vendas do mês corrente: soma das linhas de venda cujo period_month bate com o
  // prefixo ano-mês de hoje (ex.: '2026-06'). period_month é date; comparamos texto.
  const monthSales = useMemo(() => {
    const now = new Date()
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const rows = salesRows.filter((r) => (r.period_month ?? '').slice(0, 7) === prefix)
    const units = rows.reduce((s, r) => s + (r.units_sold ?? 0), 0)
    const revenue = rows.reduce((s, r) => s + (r.revenue ?? 0), 0)
    return { units, revenue }
  }, [salesRows])

  // Dados do gráfico de inventário por estado de estoque (valor em R$).
  const inventoryChart = useMemo(
    () =>
      inventoryRows.map((r) => ({
        stock_status: STOCK_LABEL[(r.stock_status ?? '').toLowerCase()] ?? r.stock_status ?? '—',
        inventory_value: r.inventory_value ?? 0,
      })),
    [inventoryRows],
  )

  // Dados do gráfico de vendas ao longo do tempo (ordenado por mês).
  const salesChart = useMemo(
    () =>
      salesRows
        .slice()
        .sort((a, b) => (a.period_month ?? '').localeCompare(b.period_month ?? ''))
        .map((r) => ({
          period_month: (r.period_month ?? '').slice(0, 7),
          units_sold: r.units_sold ?? 0,
          revenue: r.revenue ?? 0,
        })),
    [salesRows],
  )

  return (
    <ScreenShell
      title="Peças (Fast BI)"
      subtitle="Valor de estoque, peças críticas e vendas de peças — visão somente leitura."
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Valor em estoque" value={formatBRL(kpis?.parts_inventory_value ?? 0)} />
        <KpiCard label="Peças críticas/zeradas" value={kpis?.parts_critical_count ?? 0} />
        <KpiCard label="Vendidas no mês" value={monthSales.units} />
        <KpiCard label="Receita no mês" value={formatBRL(monthSales.revenue)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Estoque por estado"
          type="bar"
          data={inventoryChart}
          xKey="stock_status"
          series={[{ key: 'inventory_value', label: 'Valor em estoque', format: 'currency' }]}
          valueFormat="currency"
          emptyMessage="Sem dados de estoque para exibir."
        />
        <ChartCard
          title="Vendas de peças ao longo do tempo"
          type="line"
          data={salesChart}
          xKey="period_month"
          series={[
            { key: 'units_sold', label: 'Unidades' },
            { key: 'revenue', label: 'Receita', format: 'currency' },
          ]}
          emptyMessage="Sem dados de vendas para exibir."
        />
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">Peças críticas</h2>
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Peça</th>
                <th className="px-3 py-2 text-right">Qtd. estoque</th>
                <th className="px-3 py-2">Estoque</th>
              </tr>
            </thead>
            <tbody>
              {critical.map((r) => (
                <tr key={r.entity_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{r.part_number ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">{r.description ?? '—'}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.quantity_in_stock ?? '—'}</td>
                  <td className="px-3 py-2">
                    <Badge tone={stockTone(r.stock_status)}>
                      {STOCK_LABEL[r.stock_status] ?? r.stock_status}
                    </Badge>
                  </td>
                </tr>
              ))}
              {critical.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Nenhuma peça crítica.
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
