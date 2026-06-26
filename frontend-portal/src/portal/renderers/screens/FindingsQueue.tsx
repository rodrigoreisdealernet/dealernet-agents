// Morning Queue — inbox de triagem human-in-the-loop para findings.
// Usa a DataTable corporativa (modo client) sobre ops_findings_view. "Revisar" abre
// o finding-detail. Aceita params.agentKey p/ pré-filtrar quando aberta do Dashboard.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import DataTable from '@/portal/components/datatable/DataTable'
import type { CrudListApi, DnColumn } from '@/portal/components/datatable/types'
import ConfirmDialog from '@/portal/components/ui/ConfirmDialog'
import { gridStorage } from '@/portal/lib/gridStateApi'
import { usePortalStore } from '@/portal/store/portalStore'
import { decideFinding, getFindings, type FindingRow } from '@/portal/lib/agentsApi'
import { useFindingLabels } from '@/portal/lib/findingLabels'
import type { ScreenProps } from './types'
import { formatBRL, formatPct } from './format'

type StatusFilter = 'all' | 'pending_approval' | 'approved' | 'rejected' | 'informational'
type BatchMode = 'approve' | 'reject'

interface FindingRowVM {
  codigo: number
  ativo: boolean
  id: string
  severidade: string
  agente: string
  tipo: string
  cliente: string
  delta: string
  confianca: string
  status: string
}

interface BatchResult {
  id: string
  label: string
  ok: boolean
  message: string
}

const STATUS_RELOAD_OFFSET: Record<StatusFilter, number> = {
  all: 0,
  pending_approval: 1,
  approved: 2,
  rejected: 3,
  informational: 4,
}

function severityKey(value: string | null | undefined): string {
  const k = (value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (k === 'critical' || k === 'critica' || k === 'critico') return 'critical'
  if (k === 'high' || k === 'alta' || k === 'alto') return 'high'
  if (k === 'medium' || k === 'media' || k === 'medio') return 'medium'
  if (k === 'low' || k === 'baixa' || k === 'baixo') return 'low'
  return k || 'low'
}

function severityRank(value: string | null | undefined): number {
  const ranks: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return ranks[severityKey(value)] ?? 4
}

function statusKey(value: string | null | undefined): Exclude<StatusFilter, 'all'> | string {
  const k = (value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (k === 'pending' || k === 'pendente' || k === 'pending_approval') return 'pending_approval'
  if (k === 'approved' || k === 'aprovado') return 'approved'
  if (k === 'rejected' || k === 'rejeitado') return 'rejected'
  if (k === 'informational' || k === 'informative' || k === 'informativo') return 'informational'
  return k
}

function canDecide(status: string): boolean {
  return statusKey(status) === 'pending_approval'
}

function sortFindings(a: FindingRow, b: FindingRow): number {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity)
  if (bySeverity !== 0) return bySeverity
  const byDelta = (b.delta ?? 0) - (a.delta ?? 0)
  if (byDelta !== 0) return byDelta
  return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
}

function rowLabel(f: FindingRowVM): string {
  return `${f.tipo} · ${f.cliente}`
}

export default function FindingsQueue({ params }: ScreenProps) {
  const t = useTranslations('screens.findingsQueue')
  const detailT = useTranslations('screens.findingDetail')
  const common = useTranslations('common')
  const { agentLabel, findingTypeLabel } = useFindingLabels()
  const agentKey = params?.agentKey as string | undefined
  const openWindow = usePortalStore((s) => s.openWindow)
  const [reloadKey, setReloadKey] = useState(0)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending_approval')
  const [selectedItems, setSelectedItems] = useState<Map<string, FindingRowVM>>(() => new Map())
  const [batchMode, setBatchMode] = useState<BatchMode | null>(null)
  const [batchText, setBatchText] = useState('')
  const [dialogErr, setDialogErr] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [batchResults, setBatchResults] = useState<BatchResult[]>([])

  const statusOptions = useMemo(
    () => [
      { value: 'all' as const, label: common('all') },
      { value: 'pending_approval' as const, label: t('pending') },
      { value: 'approved' as const, label: t('approved') },
      { value: 'rejected' as const, label: t('rejected') },
      { value: 'informational' as const, label: t('informational') },
    ],
    [common, t],
  )

  const colunas = useMemo<DnColumn<FindingRowVM>[]>(
    () => [
      {
        key: 'severidade',
        label: t('severity'),
        tipo: 'badge',
        enumOptions: [
          { value: 'critical', label: `🔴 ${t('critical')}` },
          { value: 'high', label: `🟠 ${t('high')}` },
          { value: 'medium', label: `🟡 ${t('medium')}` },
          { value: 'low', label: `🔵 ${t('low')}` },
        ],
      },
      { key: 'agente', label: t('agent'), tipo: 'texto' },
      { key: 'tipo', label: t('type'), tipo: 'texto' },
      { key: 'cliente', label: t('customerContract'), tipo: 'texto' },
      { key: 'delta', label: t('delta'), tipo: 'texto' },
      { key: 'confianca', label: t('confidence'), tipo: 'texto' },
      {
        key: 'status',
        label: t('status'),
        tipo: 'badge',
        enumOptions: [
          { value: 'pending_approval', label: t('pending') },
          { value: 'approved', label: t('approved') },
          { value: 'rejected', label: t('rejected') },
          { value: 'informational', label: t('informational') },
        ],
      },
    ],
    [t],
  )

  const selectedRows = useMemo(() => Array.from(selectedItems.values()), [selectedItems])

  const toggleSelected = useCallback((f: FindingRowVM, checked: boolean) => {
    setSelectedItems((prev) => {
      const next = new Map(prev)
      if (checked) next.set(f.id, f)
      else next.delete(f.id)
      return next
    })
  }, [])

  // Estável: evita recriar columnDefs no DataTable a cada poll (10s) — sem isso a
  // tabela remonta as linhas e pode engolir o clique no "Revisar".
  const renderAcoes = useCallback(
    (f: FindingRowVM) => {
      const selected = selectedItems.has(f.id)
      const disabled = processing || (!selected && !canDecide(f.status))
      return (
        <>
          <label className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={selected}
              disabled={disabled}
              onChange={(e) => toggleSelected(f, e.target.checked)}
              aria-label={t('selectFinding').replace('{label}', rowLabel(f))}
              className="h-4 w-4 rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              openWindow({
                kind: 'component',
                componentKey: 'finding-detail',
                title: t('findingDetailTitle'),
                params: { findingId: f.id },
              })
            }
            className="rounded-md px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
          >
            {t('review')}
          </button>
        </>
      )
    },
    [openWindow, processing, selectedItems, t, toggleSelected],
  )

  // Polling "vivo" a cada 10s (recarrega a tabela sem alterar seleção/filtro).
  useEffect(() => {
    const t = window.setInterval(() => setReloadKey((k) => k + 1), 10000)
    return () => window.clearInterval(t)
  }, [])

  const api = useMemo<CrudListApi<FindingRowVM>>(
    () => ({
      async list() {
        const rows = await getFindings({ agentKey, limit: 1000 })
        const filtered = rows
          .filter((f) => statusFilter === 'all' || statusKey(f.status) === statusFilter)
          .sort(sortFindings)
        return {
          // sem `total` => DataTable entra em modo client (filtra/ordena/pagina local).
          data: filtered.map((f, i) => ({
            codigo: i + 1,
            ativo: true,
            id: f.id,
            severidade: severityKey(f.severity),
            agente: agentLabel(f.agent_key),
            tipo: findingTypeLabel(f.finding_type),
            cliente: f.customer_name ?? f.contract_label ?? f.line_item_label ?? '—',
            delta: formatBRL(f.delta),
            confianca: formatPct(f.confidence),
            status: statusKey(f.status),
          })),
        }
      },
    }),
    [agentKey, agentLabel, findingTypeLabel, statusFilter],
  )

  function openBatchDialog(mode: BatchMode) {
    setBatchMode(mode)
    setBatchText('')
    setDialogErr(null)
  }

  async function confirmBatch() {
    if (!batchMode || selectedRows.length === 0) return
    const text = batchText.trim()
    const mode = batchMode
    const items = selectedRows
    if (mode === 'reject' && !text) {
      setDialogErr(detailT('rejectReasonRequired'))
      return
    }

    setProcessing(true)
    setDialogErr(null)
    setBatchResults([])

    try {
      const settled = await Promise.allSettled(
        items.map((item) =>
          decideFinding({
            findingId: item.id,
            decision: mode,
            note: mode === 'approve' ? text || undefined : undefined,
            reason: mode === 'reject' ? text : undefined,
          }),
        ),
      )
      const successes: string[] = []
      const results = settled.map((result, index): BatchResult => {
        const item = items[index]
        if (result.status === 'fulfilled') {
          successes.push(item.id)
          return {
            id: item.id,
            label: rowLabel(item),
            ok: true,
            message: mode === 'approve' ? detailT('findingApproved') : detailT('findingRejected'),
          }
        }
        return {
          id: item.id,
          label: rowLabel(item),
          ok: false,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
      })

      setBatchResults(results)
      setSelectedItems((prev) => {
        const next = new Map(prev)
        successes.forEach((id) => next.delete(id))
        return next
      })
      setBatchMode(null)
      setBatchText('')
      setReloadKey((k) => k + 1)
    } finally {
      setProcessing(false)
    }
  }

  const selectedCount = selectedItems.size
  const effectiveReloadKey = reloadKey * 10 + STATUS_RELOAD_OFFSET[statusFilter]

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('subtitle')}
          {agentKey ? ` · ${t('agentLower')} ${agentKey}` : ''}. {t('reviewHint')}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <label className="flex items-center gap-2 text-muted-foreground">
          {t('status')}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-md border border-input bg-background px-2 py-1 text-foreground outline-none focus:border-primary"
          >
            {statusOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-xs text-muted-foreground">{t('selectedCount').replace('{count}', String(selectedCount))}</span>
        <button
          type="button"
          disabled={selectedCount === 0 || processing}
          onClick={() => openBatchDialog('approve')}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {detailT('approve')}
        </button>
        <button
          type="button"
          disabled={selectedCount === 0 || processing}
          onClick={() => openBatchDialog('reject')}
          className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {detailT('reject')}
        </button>
      </div>

      {batchResults.length > 0 && (
        <div className="max-h-32 overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
          <ul className="space-y-1">
            {batchResults.map((result) => (
              <li
                key={`${result.id}-${result.ok ? 'ok' : 'err'}`}
                className={result.ok ? 'text-success' : 'text-destructive'}
              >
                {result.ok ? '✓' : '✕'} {result.label}: {result.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <DataTable<FindingRowVM>
          colunas={colunas}
          api={api}
          storage={gridStorage}
          screenKey="ai-findings-inbox"
          reloadKey={effectiveReloadKey}
          renderAcoes={renderAcoes}
        />
      </div>

      <ConfirmDialog
        open={batchMode !== null}
        title={batchMode === 'reject' ? detailT('rejectFinding') : detailT('approveFinding')}
        destructive={batchMode === 'reject'}
        confirmLabel={batchMode === 'reject' ? detailT('reject') : detailT('approve')}
        busy={processing}
        onConfirm={confirmBatch}
        onCancel={() => {
          if (processing) return
          setBatchMode(null)
          setBatchText('')
          setDialogErr(null)
        }}
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {batchMode === 'reject' ? detailT('rejectReasonPrompt') : detailT('noteOptional')}
          </p>
          <textarea
            value={batchText}
            onChange={(e) => {
              setBatchText(e.target.value)
              if (dialogErr) setDialogErr(null)
            }}
            rows={3}
            className="w-full rounded-md border border-input bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={batchMode === 'reject' ? detailT('reasonPlaceholder') : detailT('notePlaceholder')}
          />
          {dialogErr && <p className="text-xs text-destructive">{dialogErr}</p>}
          <p className="text-xs text-muted-foreground">{t('selectedCount').replace('{count}', String(selectedCount))}</p>
        </div>
      </ConfirmDialog>
    </div>
  )
}
