// Agent Dashboard — abridor da demo: a fábrica de agentes + KPIs. Clique num agente
// abre a fila filtrada. Polling 10s. Lê ops_agent_status_view + ops_finding_kpis.
// Console de observabilidade (issue #95): saúde por agente, priorização e estados
// dedicados de loading/erro/vazio. Presentation-only sobre as views read-only.
import { useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import { useLocale } from '@/i18n/LocaleProvider'
import { usePortalStore } from '@/portal/store/portalStore'
import { getAgentStatus, getFindingKpis, runAgentNow, type AgentStatus, type FindingKpis } from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ProgressBar, ScreenShell, type Tone } from './ui'
import { formatBRLKpi, formatDateTime } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

type RunNowState = {
  status: 'running' | 'success' | 'error'
  message?: string
}

// ── Classificação de saúde (issue #95) ───────────────────────────────────────
// Um único indicador por agente, derivado dos campos já presentes na view.
type AgentHealth = 'failing' | 'attention' | 'healthy' | 'idle' | 'disabled'

function isFailedStatus(status: string | null | undefined): boolean {
  const k = (status ?? '').toLowerCase()
  return k === 'failed' || k === 'error' || k === 'erro' || k === 'falha' || k === 'falhou'
}

export function agentHealth(a: AgentStatus): AgentHealth {
  if (!a.enabled) return 'disabled'
  if (isFailedStatus(a.last_run_status) || a.failed_runs > a.succeeded_runs) return 'failing'
  if (a.pending_findings > 0 || a.has_pending_badge) return 'attention'
  if (a.total_runs === 0 || !a.last_run_status) return 'idle'
  return 'healthy'
}

const HEALTH_TONE: Record<AgentHealth, Tone> = {
  failing: 'danger',
  attention: 'warning',
  healthy: 'success',
  idle: 'neutral',
  disabled: 'neutral',
}

// Prioridade de ordenação: quem precisa de atenção vem primeiro; saudável/ocioso
// e desativado por último. Ordenação observável na lista renderizada.
const HEALTH_PRIORITY: Record<AgentHealth, number> = {
  failing: 0,
  attention: 1,
  healthy: 2,
  idle: 3,
  disabled: 4,
}

export function sortAgentsByPriority(agents: AgentStatus[]): AgentStatus[] {
  return [...agents].sort((a, b) => {
    const pa = HEALTH_PRIORITY[agentHealth(a)]
    const pb = HEALTH_PRIORITY[agentHealth(b)]
    if (pa !== pb) return pa - pb
    return a.agent_key.localeCompare(b.agent_key)
  })
}

function successRate(a: AgentStatus): number | null {
  if (a.total_runs <= 0) return null
  return (a.succeeded_runs / a.total_runs) * 100
}

function successTone(rate: number | null): 'success' | 'warning' | 'danger' {
  if (rate == null) return 'warning'
  if (rate >= 90) return 'success'
  if (rate >= 60) return 'warning'
  return 'danger'
}

// Skeleton de carregamento inicial — placeholder pulsante, não texto puro.
function AgentCardSkeleton() {
  return (
    <div className="animate-pulse rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="h-5 w-16 rounded-full bg-muted" />
      </div>
      <div className="mt-4 h-2 w-full rounded-full bg-muted" />
      <div className="mt-3 h-3 w-40 rounded bg-muted" />
      <div className="mt-3 h-7 w-28 rounded-md bg-muted" />
    </div>
  )
}

export default function AgentsDashboard() {
  const t = useTranslations('screens.agentsDashboard')
  const common = useTranslations('common')
  const { locale } = useLocale()
  const openWindow = usePortalStore((s) => s.openWindow)
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [kpis, setKpis] = useState<FindingKpis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Estado por agente do "Executar agora" — independente do polling, para que o
  // refetch de 10s não derrube feedback nem cliques em andamento.
  const [runNowStates, setRunNowStates] = useState<Record<string, RunNowState>>({})

  const healthLabel: Record<AgentHealth, string> = {
    failing: t('healthFailing'),
    attention: t('healthAttention'),
    healthy: t('healthHealthy'),
    idle: t('healthIdle'),
    disabled: t('healthDisabled'),
  }

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
          // Mantém os dados anteriores até o novo chegar (sem piscar a tela).
          setAgents(a)
          setKpis(k)
          setError(null)
        })
        .catch((e) => alive && setError(String(e)))
        .finally(() => alive && setLoading(false))
    }
    load()
    const timer = window.setInterval(load, 10000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const orderedAgents = sortAgentsByPriority(agents)
  const showSkeleton = loading && agents.length === 0
  const showEmpty = !loading && !error && agents.length === 0
  const showLoadError = !!error && agents.length === 0

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {/* Banner não-bloqueante: erro durante o polling sem apagar os dados já exibidos. */}
      {error && agents.length > 0 && (
        <p className="text-sm text-destructive">{common('error')}: {error}</p>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard
          label={t('pending')}
          value={kpis?.pending_count ?? '—'}
          accent={kpis && kpis.pending_count > 0 ? 'warning' : 'neutral'}
        />
        <KpiCard label={t('recoverable')} value={formatBRLKpi(kpis?.recoverable_delta)} accent="info" />
        <KpiCard label={t('approvedCycle')} value={kpis?.approved_this_cycle ?? '—'} accent="success" />
        <KpiCard label={t('findings24h')} value={kpis?.findings_last_24h ?? '—'} />
      </div>

      <h2 className="mt-2 text-sm font-semibold text-foreground">{t('agents')}</h2>

      {showLoadError && <p className="text-sm text-destructive">{t('loadError')}: {error}</p>}
      {showEmpty && <p className="text-sm text-muted-foreground">{t('noAgents')}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {showSkeleton &&
          Array.from({ length: 4 }).map((_, i) => <AgentCardSkeleton key={`skeleton-${i}`} />)}

        {orderedAgents.map((a) => {
          const runNowState = runNowStates[a.agent_key]
          const isRunning = runNowState?.status === 'running'
          const health = agentHealth(a)
          const rate = successRate(a)
          return (
            <div
              key={a.agent_key}
              className={
                'rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted' +
                (a.enabled ? '' : ' opacity-60')
              }
            >
              <button
                type="button"
                onClick={() => openFindingsQueue(a.agent_key)}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{a.agent_key}</span>
                  <div className="flex items-center gap-2">
                    {!a.enabled && <Badge tone="neutral">{t('healthDisabled')}</Badge>}
                    {a.enabled && <Badge tone={HEALTH_TONE[health]}>{healthLabel[health]}</Badge>}
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t('successRate')}</span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {rate == null ? '—' : `${Math.round(rate)}%`}
                  </span>
                </div>
                <div className="mt-1">
                  <ProgressBar value={rate} tone={successTone(rate)} />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {t('runs')}: {a.total_runs} ({a.succeeded_runs}✓)
                  </span>
                  {a.failed_runs > 0 && (
                    <span className="font-semibold text-destructive tabular-nums">
                      {a.failed_runs} {t('failures')}
                    </span>
                  )}
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
      </div>
    </ScreenShell>
  )
}
