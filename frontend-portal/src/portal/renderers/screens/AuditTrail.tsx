// Audit Trail — timeline proposed → approved/rejected → applied. Lê ops_audit_trail_view
// filtrando por entity_id (params.entityId). Prova "auditável, replayable".
import { useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import { getAuditTrail, type AuditEvent } from '@/portal/lib/agentsApi'
import type { ScreenProps } from './types'
import { ScreenShell } from './ui'
import { formatDateTime } from './format'

export default function AuditTrail({ params }: ScreenProps) {
  const t = useTranslations('screens.auditTrail')
  const common = useTranslations('common')
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
      <ScreenShell title={t('title')} subtitle={t('subtitle')}>
        <p className="text-sm text-muted-foreground">
          {t('openFromFinding')}
        </p>
      </ScreenShell>
    )
  }

  return (
    <ScreenShell title={t('title')} subtitle={`${t('entity')} ${entityId}`}>
      {loading && <p className="text-sm text-muted-foreground">{common('loading')}</p>}
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}
      {!loading && !error && events.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('noEvents')}</p>
      )}
      <ol className="relative space-y-4 border-l border-border pl-4">
        {events.map((ev) => (
          <li key={ev.row_id} className="space-y-0.5">
            <div className="text-sm font-medium text-foreground">
              {ev.fact_label ?? ev.fact_key ?? t('event')}
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
