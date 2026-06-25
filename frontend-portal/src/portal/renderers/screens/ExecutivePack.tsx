// Executive / Owner Pack — KPIs do dono + receita recuperável (conecta a IA ao bolso).
// Lê v_home_dashboard_kpis + ops_finding_kpis.
import { useEffect, useState } from 'react'
import { getFindingKpis, getHomeKpis, type FindingKpis, type HomeKpis } from '@/portal/lib/agentsApi'
import { KpiCard, ScreenShell } from './ui'
import { formatBRL, formatPct } from './format'

export default function ExecutivePack() {
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
      title="Executive Pack — Painel do Dono"
      subtitle="Os números do negócio + o dinheiro que a IA encontrou para recuperar."
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard
          label="Receita do período"
          value={formatBRL(home?.period_revenue)}
          hint={
            revDelta != null
              ? `${revDelta >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(revDelta))}% vs anterior`
              : undefined
          }
        />
        <KpiCard
          label="Recuperável (IA)"
          value={formatBRL(kpis?.recoverable_delta)}
          hint={`${kpis?.pending_count ?? 0} pendentes de aprovação`}
        />
        <KpiCard label="Aprovados no ciclo" value={kpis?.approved_this_cycle ?? '—'} />
        <KpiCard label="Ativos alugados" value={home?.assets_on_rent ?? '—'} />
        <KpiCard label="Utilização da frota" value={formatPct(home?.fleet_utilization_pct)} />
        <KpiCard label="Retornos atrasados" value={home?.overdue_returns_count ?? '—'} />
      </div>
    </ScreenShell>
  )
}
