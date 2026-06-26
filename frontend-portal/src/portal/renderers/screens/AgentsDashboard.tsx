// Agent Dashboard — abridor da demo: a fábrica de agentes + KPIs. Clique num agente
// abre a fila filtrada. Polling 10s. Lê ops_agent_status_view + ops_finding_kpis.
import { useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import { useLocale } from '@/i18n/LocaleProvider'
import { usePortalStore } from '@/portal/store/portalStore'
import { getAgentStatus, getFindingKpis, runAgentNow, type AgentStatus, type FindingKpis } from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell } from './ui'
import { formatBRLKpi, formatDateTime } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

type RunNowState = {
  status: 'running' | 'success' | 'error'
  message?: string
}

export default function AgentsDashboard() {
  const t = useTranslations('screens.agentsDashboard')
  const common = useTranslations('common')
  const { locale } = useLocale()
  const openWindow = usePortalStore((s) => s.openWindow)
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [kpis, setKpis] = useState<FindingKpis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runNowStates, setRunNowStates] = useState<Record<string, RunNowState>>({})

  const openFindingsQueue = (agentKey: string) =>
    openWindow({
      kind: 'component',
      componentKey: 'findings-queue',
      title: `${t('findingsTitle')} — ${agentKey}`,
      params: { agentKey },
    })

  const handleRunNow = async (agentKey: string) => {
    setRunNowStates((s) => ({ ...s, [agentKey]: { status: 'running' } }))
    try {
      await runAgentNow(agentKey, locale)
      setRunNowStates((s) => ({ ...s, [agentKey]: { status: 'success' } }))
    } catch (e) {
      setRunNowStates((s) => ({
        ...s,
        [agentKey]: { status: 'error', message: e instanceof Error ? e.message : String(e) },
      }))
    }
  }

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
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label={t('pending')} value={kpis?.pending_count ?? '—'} />
        <KpiCard label={t('recoverable')} value={formatBRLKpi(kpis?.recoverable_delta)} />
        <KpiCard label={t('approvedCycle')} value={kpis?.approved_this_cycle ?? '—'} />
        <KpiCard label={t('findings24h')} value={kpis?.findings_last_24h ?? '—'} />
      </div>

      <h2 className="mt-2 text-sm font-semibold text-foreground">{t('agents')}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {agents.map((a) => {
          const runNowState = runNowStates[a.agent_key]
          const isRunning = runNowState?.status === 'running'
          return (
            <div
              key={a.agent_key}
              className="rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted"
            >
              <button
                type="button"
                onClick={() => openFindingsQueue(a.agent_key)}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">{a.agent_key}</span>
                  <Badge tone={a.enabled ? 'success' : 'neutral'}>{a.enabled ? common('active') : common('inactive')}</Badge>
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {t('runs')}: {a.total_runs} ({a.succeeded_runs}✓/{a.failed_runs}✗)
                  </span>
                  {a.has_pending_badge && <Badge tone="warning">{a.pending_findings} {t('pendingLower')}</Badge>}
                </div>
                <div className="mt-2 text-sm text-foreground">
                  {t('identified')}:{' '}
                  <span className="font-semibold tabular-nums">{formatBRLKpi(a.identified_delta)}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('lastRun')}: {formatDateTime(a.last_run_finished_at)} · {a.last_run_status ?? '—'}
                </div>
              </button>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!a.enabled || isRunning}
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleRunNow(a.agent_key)
                  }}
                  className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isRunning ? t('running') : t('runNow')}
                </button>
                {runNowState?.status === 'success' && <Badge tone="success">{t('runSuccess')}</Badge>}
                {runNowState?.status === 'error' && (
                  <span className="text-xs text-destructive">{runNowState.message || t('runError')}</span>
                )}
              </div>
            </div>
          )
        })}
        {agents.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">{t('loadingAgents')}</p>
        )}
      </div>
    </ScreenShell>
  )
}
