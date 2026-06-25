// Finding Detail + Approval Card — o momento central (human-in-the-loop).
// Lê ops_findings_view por id; aprova/rejeita via ops-api (decideFinding).
import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import ConfirmDialog from '@/portal/components/ui/ConfirmDialog'
import { usePortalStore } from '@/portal/store/portalStore'
import { decideFinding, getFinding, type FindingDetail as FindingDetailVM } from '@/portal/lib/agentsApi'
import type { ScreenProps } from './types'
import { Badge, severityTone, statusTone } from './ui'
import { formatBRLKpi, formatPct } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

export default function FindingDetail({ params }: ScreenProps) {
  const t = useTranslations('screens.findingDetail')
  const common = useTranslations('common')
  const findingId = params?.findingId as string | undefined
  const openWindow = usePortalStore((s) => s.openWindow)

  const [data, setData] = useState<FindingDetailVM | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [mode, setMode] = useState<null | 'approve' | 'reject'>(null)
  const [text, setText] = useState('')
  const [dialogErr, setDialogErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!findingId) return
    setLoading(true)
    getFinding(findingId)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [findingId])

  useEffect(() => {
    load()
  }, [load])

  function openDialog(next: 'approve' | 'reject') {
    setMode(next)
    setText('')
    setDialogErr(null)
  }

  async function confirm() {
    if (!data || !mode) return
    if (mode === 'reject' && !text.trim()) {
      setDialogErr(t('rejectReasonRequired'))
      return
    }
    setBusy(true)
    setActionErr(null)
    try {
      await decideFinding({
        findingId: data.id,
        decision: mode,
        note: mode === 'approve' ? text || undefined : undefined,
        reason: mode === 'reject' ? text : undefined,
        workflowId: data.workflow_id,
        runId: data.run_id,
      })
      setActionMsg(mode === 'approve' ? t('findingApproved') : t('findingRejected'))
      setMode(null)
      setText('')
      load()
    } catch (e) {
      setActionErr(
        `${e instanceof Error ? e.message : String(e)} — ${t('opsApiRequired')}`,
      )
      setMode(null)
    } finally {
      setBusy(false)
    }
  }

  if (!findingId) return <div className="p-5 text-sm text-destructive">{t('openFromQueue')}</div>
  if (loading && !data) return <div className="p-5 text-sm text-muted-foreground">{common('loading')}</div>
  if (error) return <div className="p-5 text-sm text-destructive">{common('error')}: {error}</div>
  if (!data) return null

  const overBilled = (data.billed_amount ?? 0) > (data.expected_amount ?? 0)

  return (
    <div className="flex h-full flex-col gap-5 overflow-auto p-5">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-foreground">{data.finding_type}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={severityTone(data.severity)}>{data.severity}</Badge>
          <Badge tone={statusTone(data.status)}>{data.status}</Badge>
          <span className="text-sm text-muted-foreground">{t('agent')}: {data.agent_key}</span>
        </div>
        <p className="text-xs font-medium text-muted-foreground">{common('valuesInBRL')}</p>
      </header>

      <div className="flex flex-wrap items-end gap-10">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('impact')}</div>
          <div
            className={`text-3xl font-semibold tabular-nums ${overBilled ? 'text-destructive' : 'text-success'}`}
          >
            {formatBRLKpi(data.delta)}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('confidence')}</div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{formatPct(data.confidence)}</div>
        </div>
      </div>

      <div className="rounded-md border-l-4 border-primary bg-primary/5 p-4">
        <div className="text-sm font-semibold text-foreground">{t('proposedAction')}</div>
        <div className="text-sm text-foreground">{data.proposed_action ?? t('noProposedAction')}</div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('expected')}</div>
          <div className="text-xl font-semibold tabular-nums text-foreground">{formatBRLKpi(data.expected_amount)}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('billed')}</div>
          <div className="text-xl font-semibold tabular-nums text-foreground">{formatBRLKpi(data.billed_amount)}</div>
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-foreground">{t('evidence')}</h2>
        {data.evidence && data.evidence.length > 0 ? (
          <ul className="space-y-1">
            {data.evidence.map((ev, i) => (
              <li key={i} className="rounded border border-border px-3 py-2 text-sm text-foreground">
                <span className="text-success">✓</span>{' '}
                {String(ev.label ?? ev.summary ?? ev.description ?? ev.event_type ?? ev.type ?? `${t('evidence')} ${i + 1}`)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noEvidence')}</p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">{t('agentRationale')}</h2>
        <p className="text-sm italic text-muted-foreground">{data.rationale ?? t('noRationale')}</p>
      </section>

      <section className="space-y-0.5 text-sm text-muted-foreground">
        <div>{t('contract')}: {data.contract_label ?? '—'}</div>
        <div>{t('line')}: {data.line_item_label ?? '—'}</div>
        <div>{t('customer')}: {data.customer_name ?? '—'}</div>
        {data.contract_id && (
          <button
            type="button"
            onClick={() =>
              openWindow({
                kind: 'component',
                componentKey: 'audit-trail',
                title: t('auditTrail'),
                params: { entityId: data.contract_id },
              })
            }
            className="mt-1 text-primary hover:underline"
          >
            {t('openAuditTrail')}
          </button>
        )}
      </section>

      {actionMsg && <div className="rounded-md bg-muted px-3 py-2 text-sm text-success">{actionMsg}</div>}
      {actionErr && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionErr}
        </div>
      )}

      {data.status === 'pending_approval' ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => openDialog('approve')}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('approve')}
          </button>
          <button
            type="button"
            onClick={() => openDialog('reject')}
            className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-destructive/90"
          >
            {t('reject')}
          </button>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">{t('alreadyProcessed').replace('{status}', data.status)}</div>
      )}

      <ConfirmDialog
        open={mode !== null}
        title={mode === 'reject' ? t('rejectFinding') : t('approveFinding')}
        destructive={mode === 'reject'}
        confirmLabel={mode === 'reject' ? t('reject') : t('approve')}
        busy={busy}
        onConfirm={confirm}
        onCancel={() => {
          if (busy) return
          setMode(null)
          setText('')
          setDialogErr(null)
        }}
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {mode === 'reject' ? t('rejectReasonPrompt') : t('noteOptional')}
          </p>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (dialogErr) setDialogErr(null)
            }}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={mode === 'reject' ? t('reasonPlaceholder') : t('notePlaceholder')}
          />
          {dialogErr && <p className="text-xs text-destructive">{dialogErr}</p>}
        </div>
      </ConfirmDialog>
    </div>
  )
}
