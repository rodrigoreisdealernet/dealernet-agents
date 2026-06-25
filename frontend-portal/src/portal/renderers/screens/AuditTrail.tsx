// Audit Trail — timeline proposed → approved/rejected → applied. Lê ops_audit_trail_view
// filtrando por entity_id (params.entityId). Prova "auditável, replayable".
import { useEffect, useState } from 'react'
import { getAuditTrail, type AuditEvent } from '@/portal/lib/agentsApi'
import type { ScreenProps } from './types'
import { ScreenShell } from './ui'
import { formatDateTime } from './format'

export default function AuditTrail({ params }: ScreenProps) {
  const entityId = params?.entityId as string | undefined
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!entityId) return
    setLoading(true)
    getAuditTrail(entityId)
      .then((e) => {
        setEvents(e)
        setError(null)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [entityId])

  if (!entityId) {
    return (
      <ScreenShell title="Audit Trail" subtitle="Trilha de auditoria de um achado / contrato.">
        <p className="text-sm text-muted-foreground">
          Abra a auditoria a partir de um achado (Finding Detail → “Abrir trilha de auditoria”).
        </p>
      </ScreenShell>
    )
  }

  return (
    <ScreenShell title="Audit Trail" subtitle={`Entidade ${entityId}`}>
      {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}
      {!loading && !error && events.length === 0 && (
        <p className="text-sm text-muted-foreground">Sem eventos para esta entidade.</p>
      )}
      <ol className="relative space-y-4 border-l border-border pl-4">
        {events.map((ev) => (
          <li key={ev.row_id} className="space-y-0.5">
            <div className="text-sm font-medium text-foreground">
              {ev.fact_label ?? ev.fact_key ?? 'evento'}
            </div>
            <div className="text-xs text-muted-foreground">
              {[ev.entity_name ?? ev.entity_type, formatDateTime(ev.observed_at)].filter(Boolean).join(' · ')}
            </div>
          </li>
        ))}
      </ol>
    </ScreenShell>
  )
}
