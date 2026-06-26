// Histórico de execuções por agente (issue #128, unidade U5 — observabilidade).
// Lista read-only das últimas N execuções de um agente DIA: início, fim/duração,
// status e nº de achados gerados. Polling 10s consistente com o AgentsDashboard.
// Aberta como janela (kind=component) com params.agentKey vindo do Dashboard.
import { useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import { getAgentRunHistory, type AgentRunHistoryRow } from '@/portal/lib/agentsApi'
import { useFindingLabels } from '@/portal/lib/findingLabels'
import { Badge, ScreenShell, type Tone } from './ui'
import { formatDateTime } from './format'
import type { ScreenProps } from './types'

const HISTORY_LIMIT = 10

function statusKey(status: string | null | undefined): 'succeeded' | 'failed' | 'running' | 'other' {
  const k = (status ?? '').toLowerCase()
  if (k === 'succeeded' || k === 'success' || k === 'completed') return 'succeeded'
  if (k === 'failed' || k === 'error' || k === 'erro' || k === 'falhou') return 'failed'
  if (k === 'running' || k === 'started' || k === 'in_progress') return 'running'
  return 'other'
}

const STATUS_TONE: Record<'succeeded' | 'failed' | 'running' | 'other', Tone> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'info',
  other: 'neutral',
}

// Duração legível derivada de início/fim (a view também expõe `duration`, mas o
// cálculo local evita depender do formato de intervalo do Postgres).
function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(finishedAt)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  const totalSeconds = Math.round((end - start) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export default function AgentRunHistory({ params }: ScreenProps) {
  const t = useTranslations('screens.agentRunHistory')
  const { agentLabel } = useFindingLabels()
  const agentKey = typeof params?.agentKey === 'string' ? params.agentKey : ''

  const [runs, setRuns] = useState<AgentRunHistoryRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const statusLabel: Record<'succeeded' | 'failed' | 'running', string> = {
    succeeded: t('statusSucceeded'),
    failed: t('statusFailed'),
    running: t('statusRunning'),
  }

  useEffect(() => {
    if (!agentKey) {
      setLoading(false)
      return
    }
    let alive = true
    const load = () => {
      getAgentRunHistory(agentKey, HISTORY_LIMIT)
        .then((rows) => {
          if (!alive) return
          setRuns(rows)
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
  }, [agentKey])

  const showLoading = loading && runs.length === 0
  const showError = !!error && runs.length === 0
  const showEmpty = !loading && !error && runs.length === 0

  return (
    <ScreenShell title={t('title')} subtitle={t('subtitle', { agent: agentLabel(agentKey) })}>
      {/* Banner não-bloqueante: erro no polling sem apagar os dados já exibidos. */}
      {error && runs.length > 0 && <p className="text-sm text-destructive">{t('error')}</p>}

      {showLoading && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
      {showError && <p className="text-sm text-destructive">{t('error')}</p>}
      {showEmpty && <p className="text-sm text-muted-foreground">{t('empty')}</p>}

      {runs.length > 0 && (
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('columnStart')}</th>
                <th className="px-3 py-2 font-medium">{t('columnEnd')}</th>
                <th className="px-3 py-2 font-medium">{t('columnDuration')}</th>
                <th className="px-3 py-2 font-medium">{t('columnStatus')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('columnFindings')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const sk = statusKey(run.status)
                const duration = formatDuration(run.started_at, run.finished_at)
                return (
                  <tr key={run.run_id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 tabular-nums text-foreground">{formatDateTime(run.started_at)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {run.finished_at ? formatDateTime(run.finished_at) : t('inProgress')}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{duration ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[sk]}>
                        {sk === 'other' ? run.status : statusLabel[sk]}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">
                      {run.findings_emitted}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </ScreenShell>
  )
}
