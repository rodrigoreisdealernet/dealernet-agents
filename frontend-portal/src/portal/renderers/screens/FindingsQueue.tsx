// Morning Queue — fila de findings priorizada por Δ R$ (molde InboxView).
// Usa a DataTable corporativa (modo client) sobre ops_findings_view. "Revisar" abre
// o finding-detail. Aceita params.agentKey p/ pré-filtrar quando aberta do Dashboard.
import { useEffect, useMemo, useState } from 'react'
import DataTable from '@/portal/components/datatable/DataTable'
import type { CrudListApi, DnColumn } from '@/portal/components/datatable/types'
import { gridStorage } from '@/portal/lib/gridStateApi'
import { usePortalStore } from '@/portal/store/portalStore'
import { getFindings } from '@/portal/lib/agentsApi'
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

const COLUNAS: DnColumn<FindingRowVM>[] = [
  {
    key: 'severidade',
    label: 'Severidade',
    tipo: 'badge',
    enumOptions: [
      { value: 'critical', label: 'Crítica' },
      { value: 'high', label: 'Alta' },
      { value: 'medium', label: 'Média' },
      { value: 'low', label: 'Baixa' },
    ],
  },
  { key: 'agente', label: 'Agente', tipo: 'texto' },
  { key: 'tipo', label: 'Tipo', tipo: 'texto' },
  { key: 'cliente', label: 'Cliente / Contrato', tipo: 'texto' },
  { key: 'delta', label: 'Δ (R$)', tipo: 'numero' },
  { key: 'confianca', label: 'Confiança %', tipo: 'numero' },
  {
    key: 'status',
    label: 'Status',
    tipo: 'badge',
    enumOptions: [
      { value: 'pending_approval', label: 'Pendente' },
      { value: 'approved', label: 'Aprovado' },
      { value: 'rejected', label: 'Rejeitado' },
      { value: 'informational', label: 'Informativo' },
    ],
  },
]

export default function FindingsQueue({ params }: ScreenProps) {
  const agentKey = params?.agentKey as string | undefined
  const openWindow = usePortalStore((s) => s.openWindow)
  const [reloadKey, setReloadKey] = useState(0)

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
            agente: f.agent_key,
            tipo: f.finding_type,
            cliente: f.customer_name ?? f.contract_label ?? '—',
            delta: f.delta ?? 0,
            confianca: Math.round((f.confidence ?? 0) * 100),
            status: f.status,
          })),
        }
      },
    }),
    [agentKey],
  )

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Morning Queue — Findings</h1>
        <p className="text-sm text-muted-foreground">
          Achados que a IA empurrou para revisão, ordenados por Δ R$
          {agentKey ? ` · agente ${agentKey}` : ''}. Clique em “Revisar” para aprovar/rejeitar.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <DataTable<FindingRowVM>
          colunas={COLUNAS}
          api={api}
          storage={gridStorage}
          screenKey="ai-findings"
          reloadKey={reloadKey}
          renderAcoes={(f) => (
            <button
              type="button"
              onClick={() =>
                openWindow({
                  kind: 'component',
                  componentKey: 'finding-detail',
                  title: 'Detalhe do achado',
                  params: { findingId: f.id },
                })
              }
              className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
            >
              Revisar
            </button>
          )}
        />
      </div>
    </div>
  )
}
