// Morning Queue — fila de findings priorizada por Δ R$ (molde InboxView).
// Usa a DataTable corporativa (modo client) sobre ops_findings_view. "Revisar" abre
// o finding-detail. Aceita params.agentKey p/ pré-filtrar quando aberta do Dashboard.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import DataTable from '@/portal/components/datatable/DataTable'
import type { CrudListApi, DnColumn } from '@/portal/components/datatable/types'
import { gridStorage } from '@/portal/lib/gridStateApi'
import { usePortalStore } from '@/portal/store/portalStore'
import { getFindings } from '@/portal/lib/agentsApi'
import { useFindingLabels } from '@/portal/lib/findingLabels'
import type { ScreenProps } from './types'

interface FindingRowVM {
  codigo: number
  ativo: boolean
  id: string
  severidade: string
  agente: string
  tipo: string
  cliente: string
  delta: number
  confianca: number
  status: string
}

export default function FindingsQueue({ params }: ScreenProps) {
  const t = useTranslations('screens.findingsQueue')
  const { agentLabel, findingTypeLabel } = useFindingLabels()
  const agentKey = params?.agentKey as string | undefined
  const openWindow = usePortalStore((s) => s.openWindow)
  const [reloadKey, setReloadKey] = useState(0)
  const colunas = useMemo<DnColumn<FindingRowVM>[]>(
    () => [
      {
        key: 'severidade',
        label: t('severity'),
        tipo: 'badge',
        enumOptions: [
          { value: 'critical', label: t('critical') },
          { value: 'high', label: t('high') },
          { value: 'medium', label: t('medium') },
          { value: 'low', label: t('low') },
        ],
      },
      { key: 'agente', label: t('agent'), tipo: 'texto' },
      { key: 'tipo', label: t('type'), tipo: 'texto' },
      { key: 'cliente', label: t('customerContract'), tipo: 'texto' },
      { key: 'delta', label: t('delta'), tipo: 'numero' },
      { key: 'confianca', label: t('confidence'), tipo: 'numero' },
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

  // Estável: evita recriar columnDefs no DataTable a cada poll (10s) — sem isso a
  // tabela remonta as linhas e pode engolir o clique no "Revisar".
  const renderAcoes = useCallback(
    (f: FindingRowVM) => (
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
    ),
    [openWindow, t],
  )

  // Polling "vivo" a cada 10s (recarrega a tabela).
  useEffect(() => {
    const t = window.setInterval(() => setReloadKey((k) => k + 1), 10000)
    return () => window.clearInterval(t)
  }, [])

  const api = useMemo<CrudListApi<FindingRowVM>>(
    () => ({
      async list() {
        const rows = await getFindings({ agentKey, status: 'pending_approval' })
        return {
          // sem `total` => DataTable entra em modo client (filtra/ordena/pagina local).
          data: rows.map((f, i) => ({
            codigo: i + 1,
            ativo: true,
            id: f.id,
            severidade: f.severity,
            agente: agentLabel(f.agent_key),
            tipo: findingTypeLabel(f.finding_type),
            cliente: f.customer_name ?? f.contract_label ?? '—',
            delta: f.delta ?? 0,
            confianca: Math.round((f.confidence ?? 0) * 100),
            status: f.status,
          })),
        }
      },
    }),
    [agentKey, agentLabel, findingTypeLabel],
  )

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('subtitle')}
          {agentKey ? ` · ${t('agentLower')} ${agentKey}` : ''}. {t('reviewHint')}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <DataTable<FindingRowVM>
          colunas={colunas}
          api={api}
          storage={gridStorage}
          screenKey="ai-findings"
          reloadKey={reloadKey}
          renderAcoes={renderAcoes}
        />
      </div>
    </div>
  )
}
