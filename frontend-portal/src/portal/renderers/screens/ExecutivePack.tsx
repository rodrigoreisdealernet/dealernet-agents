// Executive / Owner Pack — KPIs do dono + receita recuperável (conecta a IA ao bolso).
// "Dar vida" (issue #78): hero KPIs com tendência/sparkline, gráficos 90d, achados
// da IA com drill, faixa de risco e quebra por agente. Sem backend novo — só as
// funções já existentes em agentsApi. Carrega uma vez no mount.
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useTranslations } from 'use-intl'
import {
  getAgentStatus,
  getFindings,
  getFindingKpis,
  getHomeKpis,
  getOwnerBriefByBrand,
  getOwnerKpis,
  getSalesTrend,
  type AgentStatus,
  type FindingKpis,
  type FindingRow,
  type HomeKpis,
  type OwnerBriefBrandRow,
  type OwnerKpis,
  type SalesTrendRow,
} from '@/portal/lib/agentsApi'
import { usePortalStore } from '@/portal/store/portalStore'
import {
  Badge,
  KpiCard,
  ProgressBar,
  ScreenShell,
  Sparkline,
  TrendBadge,
  severityTone,
  statusTone,
} from './ui'
import { ChartCard } from './ChartCard'
import { formatBRLKpi, formatPct } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

// Fade + translate-y dos cards na montagem. Respeita prefers-reduced-motion via
// CSS base do shell (framer-motion honra a media query no nível do documento).
const fadeUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
}

export default function ExecutivePack() {
  const t = useTranslations('screens.executivePack')
  const common = useTranslations('common')
  const openWindow = usePortalStore((s) => s.openWindow)
  const [home, setHome] = useState<HomeKpis | null>(null)
  const [kpis, setKpis] = useState<FindingKpis | null>(null)
  const [salesTrend, setSalesTrend] = useState<SalesTrendRow[]>([])
  const [byBrand, setByBrand] = useState<OwnerBriefBrandRow[]>([])
  const [ownerKpis, setOwnerKpis] = useState<OwnerKpis | null>(null)
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getHomeKpis().catch(() => null),
      getFindingKpis().catch(() => null),
      getSalesTrend().catch(() => [] as SalesTrendRow[]),
      getOwnerBriefByBrand().catch(() => [] as OwnerBriefBrandRow[]),
      getOwnerKpis().catch(() => null),
      getFindings({ limit: 6 }).catch(() => [] as FindingRow[]),
      getAgentStatus().catch(() => [] as AgentStatus[]),
    ])
      .then(([h, k, s, b, ok, f, a]) => {
        setHome(h)
        setKpis(k)
        setSalesTrend(s)
        setByBrand(b)
        setOwnerKpis(ok)
        setFindings(f)
        setAgents(a)
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
  }, [])

  const revDelta =
    home && home.prior_period_revenue
      ? ((home.period_revenue - home.prior_period_revenue) / home.prior_period_revenue) * 100
      : null

  const revenueSeries = salesTrend.map((p) => p.revenue)

  // Risco do floor plan: fp_*_at_risk SÃO somáveis por marca (gotcha da spec —
  // NÃO somar campos group-wide como pecas_value/at_value).
  const fpUnitsAtRisk = byBrand.reduce((sum, b) => sum + (b.fp_units_at_risk ?? 0), 0)
  const fpValueAtRisk = byBrand.reduce((sum, b) => sum + (b.fp_value_at_risk ?? 0), 0)
  const criticalParts = ownerKpis?.parts_critical_count ?? 0
  const hasRisk = fpValueAtRisk > 0 || fpUnitsAtRisk > 0 || criticalParts > 0

  const findingLabel = (f: FindingRow) =>
    f.customer_name ?? f.contract_label ?? f.line_item_label ?? f.finding_type

  const openFinding = (f: FindingRow) =>
    openWindow({
      kind: 'component',
      componentKey: 'finding-detail',
      title: findingLabel(f),
      params: { findingId: f.id },
    })

  const openAgentQueue = (agentKey: string) =>
    openWindow({
      kind: 'component',
      componentKey: 'findings-queue',
      title: `${t('byAgentTitle')} — ${agentKey}`,
      params: { agentKey },
    })

  return (
    <ScreenShell title={t('title')} subtitle={t('subtitle')} legend={common('valuesInBRL')}>
      {error && (
        <p className="text-sm text-destructive">
          {common('error')}: {error}
        </p>
      )}
      {loading && !home && <p className="text-sm text-muted-foreground">{common('loading')}</p>}

      {/* A — Hero KPIs */}
      <motion.div
        className="grid grid-cols-2 gap-4 md:grid-cols-3"
        variants={fadeUp}
        initial="initial"
        animate="animate"
      >
        <KpiCard
          label={t('periodRevenue')}
          value={formatBRLKpi(home?.period_revenue)}
          accent="info"
          trend={revDelta != null ? <TrendBadge delta={revDelta} format="pct" /> : undefined}
          sparkline={
            revenueSeries.length > 1 ? (
              <Sparkline data={revenueSeries} tone={revDelta != null && revDelta < 0 ? 'danger' : 'success'} />
            ) : undefined
          }
        />
        <KpiCard
          label={t('recoverableAi')}
          value={formatBRLKpi(kpis?.recoverable_delta)}
          accent="success"
          hint={`${kpis?.pending_count ?? 0} ${t('pendingApproval')}`}
        />
        <KpiCard label={t('approvedCycle')} value={kpis?.approved_this_cycle ?? '—'} />
        <KpiCard label={t('activeDeals')} value={home?.assets_on_rent ?? '—'} />
        <KpiCard
          label={t('capacityUse')}
          value={formatPct(home?.fleet_utilization_pct)}
          sparkline={<ProgressBar value={home?.fleet_utilization_pct ?? 0} />}
        />
        <KpiCard
          label={t('overdueActions')}
          value={home?.overdue_returns_count ?? '—'}
          accent={(home?.overdue_returns_count ?? 0) > 0 ? 'danger' : 'neutral'}
        />
      </motion.div>

      {/* B — Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title={t('revenueTrendTitle')}
          type="line"
          data={salesTrend as unknown as Array<Record<string, unknown>>}
          xKey="sale_date"
          series={[
            { key: 'revenue', label: t('revenue'), format: 'currency' },
            { key: 'units_sold', label: t('units'), format: 'number' },
          ]}
          valueFormat="number"
          emptyMessage={common('noData')}
        />
        <ChartCard
          title={t('resultByBrandTitle')}
          type="bar"
          data={byBrand as unknown as Array<Record<string, unknown>>}
          xKey="brand_name"
          series={[{ key: 'resultado', label: t('result'), format: 'currency' }]}
          valueFormat="currency"
          emptyMessage={common('noData')}
        />
      </div>

      {/* C — O que a IA encontrou */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="text-sm font-semibold text-foreground">{t('aiFoundTitle')}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('aiFoundSubtitle')}</p>
        <div className="mt-4 space-y-2">
          {findings.map((f) => (
            <motion.button
              key={f.id}
              type="button"
              onClick={() => openFinding(f)}
              whileHover={{ y: -2 }}
              className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                <Badge tone={statusTone(f.status)}>{f.status}</Badge>
                <span className="truncate text-sm text-foreground">{findingLabel(f)}</span>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                Δ {formatBRLKpi(f.delta)}
              </span>
            </motion.button>
          ))}
          {findings.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">{t('noFindings')}</p>
          )}
        </div>
      </div>

      {/* D — Faixa de risco (só quando há risco) */}
      {hasRisk && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5">
          <div className="text-sm font-semibold text-foreground">{t('atRiskTitle')}</div>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('floorPlanAtRisk')}
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                {formatBRLKpi(fpValueAtRisk)}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {fpUnitsAtRisk} {t('units')}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('criticalParts')}
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{criticalParts}</div>
            </div>
          </div>
        </div>
      )}

      {/* Agent breakdown */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="text-sm font-semibold text-foreground">{t('byAgentTitle')}</div>
        <div className="mt-4 space-y-2">
          {agents.map((a) => (
            <motion.button
              key={a.agent_key}
              type="button"
              onClick={() => openAgentQueue(a.agent_key)}
              whileHover={{ y: -2 }}
              className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="truncate text-sm font-medium text-foreground">{a.agent_key}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {a.succeeded_runs}✓/{a.failed_runs}✗ {t('runHealth')}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                {a.pending_findings > 0 && (
                  <Badge tone="warning">
                    {a.pending_findings} {t('pending')}
                  </Badge>
                )}
                <span className="tabular-nums text-foreground">
                  {t('identified')}: {formatBRLKpi(a.identified_delta)}
                </span>
              </div>
            </motion.button>
          ))}
          {agents.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">{common('noData')}</p>
          )}
        </div>
      </div>
    </ScreenShell>
  )
}
