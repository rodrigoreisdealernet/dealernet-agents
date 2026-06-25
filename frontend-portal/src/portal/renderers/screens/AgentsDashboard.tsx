// Agent Dashboard — abridor da demo: a fábrica de agentes + KPIs. Clique num agente
// abre a fila filtrada. Polling 10s. Lê ops_agent_status_view + ops_finding_kpis.
import { useEffect, useState } from 'react'
import { usePortalStore } from '@/portal/store/portalStore'
import { getAgentStatus, getFindingKpis, type AgentStatus, type FindingKpis } from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell } from './ui'
import { formatBRLKpi, formatDateTime } from './format'

export default function AgentsDashboard() {
  const openWindow = usePortalStore((s) => s.openWindow)
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [kpis, setKpis] = useState<FindingKpis | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      Promise.all([getAgentStatus(), getFindingKpis()])
        .then(([a, k]) => {
          if (!alive) return
          setAgents(a)
          setKpis(k)
          setError(null)
        })
        .catch((e) => alive && setError(String(e)))
    }
    load()
    const t = window.setInterval(load, 10000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  return (
    <ScreenShell
      title="Agent Dashboard"
      subtitle="A fábrica de agentes de IA: o que rodou, o que está pendente e quanto há para recuperar."
      legend="Valores em R$"
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Pendentes" value={kpis?.pending_count ?? '—'} />
        <KpiCard label="Recuperável" value={formatBRLKpi(kpis?.recoverable_delta)} />
        <KpiCard label="Aprovados no ciclo" value={kpis?.approved_this_cycle ?? '—'} />
        <KpiCard label="Findings 24h" value={kpis?.findings_last_24h ?? '—'} />
      </div>

      <h2 className="mt-2 text-sm font-semibold text-foreground">Agentes</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {agents.map((a) => (
          <button
            key={a.agent_key}
            type="button"
            onClick={() =>
              openWindow({
                kind: 'component',
                componentKey: 'findings-queue',
                title: `Findings — ${a.agent_key}`,
                params: { agentKey: a.agent_key },
              })
            }
            className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{a.agent_key}</span>
              <Badge tone={a.enabled ? 'success' : 'neutral'}>{a.enabled ? 'ativo' : 'inativo'}</Badge>
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              <span>
                runs: {a.total_runs} ({a.succeeded_runs}✓/{a.failed_runs}✗)
              </span>
              {a.has_pending_badge && <Badge tone="warning">{a.pending_findings} pendentes</Badge>}
            </div>
            <div className="mt-2 text-sm text-foreground">
              Identificado:{' '}
              <span className="font-semibold tabular-nums">{formatBRLKpi(a.identified_delta)}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Último run: {formatDateTime(a.last_run_finished_at)} · {a.last_run_status ?? '—'}
            </div>
          </button>
        ))}
        {agents.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">Carregando agentes…</p>
        )}
      </div>
    </ScreenShell>
  )
}
