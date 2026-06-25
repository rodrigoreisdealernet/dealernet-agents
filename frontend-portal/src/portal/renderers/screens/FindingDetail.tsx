// Finding Detail + Approval Card — o momento central (human-in-the-loop).
// Lê ops_findings_view por id; aprova/rejeita via ops-api (decideFinding).
import { useCallback, useEffect, useState } from 'react'
import ConfirmDialog from '@/portal/components/ui/ConfirmDialog'
import { usePortalStore } from '@/portal/store/portalStore'
import { decideFinding, getFinding, type FindingDetail as FindingDetailVM } from '@/portal/lib/agentsApi'
import type { ScreenProps } from './types'
import { Badge, severityTone, statusTone } from './ui'
import { formatBRL, formatPct } from './format'

export default function FindingDetail({ params }: ScreenProps) {
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
      setDialogErr('Motivo é obrigatório para rejeitar.')
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
      setActionMsg(mode === 'approve' ? 'Achado aprovado.' : 'Achado rejeitado.')
      setMode(null)
      setText('')
      load()
    } catch (e) {
      setActionErr(
        `${e instanceof Error ? e.message : String(e)} — a disposição real exige a ops-api (FastAPI :8000) + Temporal no ar. A leitura segue válida.`,
      )
      setMode(null)
    } finally {
      setBusy(false)
    }
  }

  if (!findingId) return <div className="p-5 text-sm text-destructive">Abra um achado a partir da fila.</div>
  if (loading && !data) return <div className="p-5 text-sm text-muted-foreground">Carregando…</div>
  if (error) return <div className="p-5 text-sm text-destructive">Erro: {error}</div>
  if (!data) return null

  const overBilled = (data.billed_amount ?? 0) > (data.expected_amount ?? 0)

  return (
    <div className="flex h-full flex-col gap-5 overflow-auto p-5">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-foreground">{data.finding_type}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={severityTone(data.severity)}>{data.severity}</Badge>
          <Badge tone={statusTone(data.status)}>{data.status}</Badge>
          <span className="text-sm text-muted-foreground">Agente: {data.agent_key}</span>
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-10">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Impacto</div>
          <div
            className={`text-3xl font-semibold tabular-nums ${overBilled ? 'text-destructive' : 'text-success'}`}
          >
            {formatBRL(data.delta)}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Confiança</div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{formatPct(data.confidence)}</div>
        </div>
      </div>

      <div className="rounded-md border-l-4 border-primary bg-primary/5 p-4">
        <div className="text-sm font-semibold text-foreground">Ação proposta</div>
        <div className="text-sm text-foreground">{data.proposed_action ?? 'Sem ação proposta.'}</div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Esperado</div>
          <div className="text-xl font-semibold tabular-nums text-foreground">{formatBRL(data.expected_amount)}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Faturado</div>
          <div className="text-xl font-semibold tabular-nums text-foreground">{formatBRL(data.billed_amount)}</div>
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-foreground">Evidência</h2>
        {data.evidence && data.evidence.length > 0 ? (
          <ul className="space-y-1">
            {data.evidence.map((ev, i) => (
              <li key={i} className="rounded border border-border px-3 py-2 text-sm text-foreground">
                <span className="text-success">✓</span>{' '}
                {String(ev.label ?? ev.summary ?? ev.description ?? ev.event_type ?? ev.type ?? `Evidência ${i + 1}`)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Sem evidência fornecida.</p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Rationale do agente</h2>
        <p className="text-sm italic text-muted-foreground">{data.rationale ?? 'Sem rationale.'}</p>
      </section>

      <section className="space-y-0.5 text-sm text-muted-foreground">
        <div>Contrato: {data.contract_label ?? '—'}</div>
        <div>Linha: {data.line_item_label ?? '—'}</div>
        <div>Cliente: {data.customer_name ?? '—'}</div>
        {data.contract_id && (
          <button
            type="button"
            onClick={() =>
              openWindow({
                kind: 'component',
                componentKey: 'audit-trail',
                title: 'Auditoria',
                params: { entityId: data.contract_id },
              })
            }
            className="mt-1 text-primary hover:underline"
          >
            Abrir trilha de auditoria
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
            Aprovar
          </button>
          <button
            type="button"
            onClick={() => openDialog('reject')}
            className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-destructive/90"
          >
            Rejeitar
          </button>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">Achado já {data.status}. Sem ação pendente.</div>
      )}

      <ConfirmDialog
        open={mode !== null}
        title={mode === 'reject' ? 'Rejeitar achado' : 'Aprovar achado'}
        destructive={mode === 'reject'}
        confirmLabel={mode === 'reject' ? 'Rejeitar' : 'Aprovar'}
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
            {mode === 'reject' ? 'Informe o motivo da rejeição (obrigatório).' : 'Observação (opcional).'}
          </p>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (dialogErr) setDialogErr(null)
            }}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={mode === 'reject' ? 'Motivo…' : 'Observação…'}
          />
          {dialogErr && <p className="text-xs text-destructive">{dialogErr}</p>}
        </div>
      </ConfirmDialog>
    </div>
  )
}
