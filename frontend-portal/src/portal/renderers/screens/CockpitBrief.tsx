// Cockpit Matinal (issue #142) — segunda experiência visual do Resumo Matinal,
// fiel ao protótipo docs/proposals/morning-brief/proposal-b-cockpit.html ("Proposta
// B: O Cockpit"). É uma tela NOVA e paralela: o MorningBrief (#43) permanece
// intocado. Diferente do protótipo (mock), as ações do rail são REAIS — cada
// Aprovar/Dispensar/Aprovar-tudo chama decideFinding → ops-api
// POST /api/ops/findings/decision.
//
// Dados: KPIs + tabela vêm de getOwnerBriefByBrand/Store (dia anterior); o rail vem
// de getFindings({ status: 'pending_approval' }). O "Por quê" de cada card vem de
// getFinding(id).rationale (carregado sob demanda). Sem dados de demonstração
// hard-coded. Padrões reaproveitados: confirmação otimista + rollback do
// MorningBrief.tsx; lote Promise.allSettled do FindingsQueue.tsx; useFindingLabels.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  decideFinding,
  getFinding,
  getFindings,
  getOwnerBriefByBrand,
  getOwnerBriefByStore,
  type FindingRow,
  type OwnerBriefBaseRow,
  type OwnerBriefBrandRow,
  type OwnerBriefStoreRow,
} from '@/portal/lib/agentsApi'
import { useFindingLabels } from '@/portal/lib/findingLabels'
import { usePortalStore } from '@/portal/store/portalStore'
import { cn } from '@/lib/utils'
import { formatBRLKpi, formatPct } from './format'

type Translate = ReturnType<typeof useTranslations>

// Após Confirmar (approve) com sucesso, mantém o estado "Confirmado" (verde) por um
// instante e então remove o card — ação tratada não deve continuar na fila.
const CONFIRM_CLEAR_DELAY_MS = 1000

// Cor do agente no rail (equivalente visual ao mockup: aging=vermelho, coll=âmbar,
// parts=teal, svc=violeta). Fora do mapa, usa a cor de marca (--primary).
const AGENT_COLORS: Record<string, { dot: string; text: string }> = {
  'vehicle-aging-analyst': { dot: 'bg-destructive', text: 'text-destructive' },
  'collections-prioritizer': { dot: 'bg-amber-500', text: 'text-amber-600' },
  'parts-inventory-advisor': { dot: 'bg-teal-500', text: 'text-teal-600' },
  'service-estimate-rescue': { dot: 'bg-violet-500', text: 'text-violet-600' },
}
function agentColor(key: string): { dot: string; text: string } {
  return AGENT_COLORS[key] ?? { dot: 'bg-primary', text: 'text-primary' }
}

// ── Formatação dos setores (valores absolutos; "—" quando sem dado) ──
function fmtUnits(n: number | null | undefined, t: Translate): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n} ${t('unitsAbbr')}` : '—'
}
function fmtMoney(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? formatBRLKpi(n) : '—'
}
function fmtMargin(n: number | null | undefined, t: Translate): string | null {
  return typeof n === 'number' && Number.isFinite(n) ? `${t('margin')} ${formatBRLKpi(n)}` : null
}

interface SectorCell {
  label: string
  value: string
  /** 'on' = FP em risco (vermelho); 'off' = FP zero/neutro (cinza); undefined = normal. */
  fp?: 'on' | 'off'
}

// 5 células de setor (Novos, Usados, Peças, AT, FP) de uma linha da tabela.
function sectorCells(r: OwnerBriefBaseRow, t: Translate): SectorCell[] {
  const atRisk = (r.fp_units_at_risk ?? 0) > 0
  return [
    { label: t('colNew'), value: fmtUnits(r.novos_units, t) },
    { label: t('colUsed'), value: fmtUnits(r.usados_units, t) },
    { label: t('colParts'), value: fmtMoney(r.pecas_value) },
    { label: t('colAt'), value: fmtMoney(r.at_value) },
    {
      label: t('colFp'),
      value: typeof r.fp_units === 'number' ? String(r.fp_units) : '—',
      fp: atRisk ? 'on' : 'off',
    },
  ]
}

// Consolida as marcas no "Grupo Total". Novos/Usados/FP somam por marca. Peças/AT são
// GROUP-WIDE (mesmo valor repetido em cada linha de marca) → tomados UMA vez, nunca
// somados. O resultado por marca já é Novos+Usados; o do grupo soma isso + Peças/AT.
function groupTotal(brands: OwnerBriefBrandRow[]): OwnerBriefBrandRow {
  const sum = (pick: (b: OwnerBriefBrandRow) => number | null) =>
    brands.reduce((acc, b) => acc + (pick(b) ?? 0), 0)
  const anyNonNull = (pick: (b: OwnerBriefBrandRow) => number | null) =>
    brands.some((b) => typeof pick(b) === 'number' && Number.isFinite(pick(b) as number))
  const sumOrNull = (pick: (b: OwnerBriefBrandRow) => number | null) =>
    anyNonNull(pick) ? sum(pick) : null
  const once = (pick: (b: OwnerBriefBrandRow) => number | null) => {
    const v = brands.map(pick).find((x) => typeof x === 'number' && Number.isFinite(x as number))
    return (v ?? null) as number | null
  }
  const pecasOnce = once((b) => b.pecas_value)
  const atOnce = once((b) => b.at_value)
  return {
    brand_name: 'Grupo Total',
    brand_id: null,
    store_count: sum((b) => b.store_count),
    novos_units: sumOrNull((b) => b.novos_units),
    novos_value: sumOrNull((b) => b.novos_value),
    novos_margin: sumOrNull((b) => b.novos_margin),
    usados_units: sumOrNull((b) => b.usados_units),
    usados_value: sumOrNull((b) => b.usados_value),
    usados_margin: sumOrNull((b) => b.usados_margin),
    pecas_value: pecasOnce,
    pecas_margin: once((b) => b.pecas_margin),
    at_value: atOnce,
    at_margin: once((b) => b.at_margin),
    fp_units: sum((b) => b.fp_units),
    fp_value: sum((b) => b.fp_value),
    fp_units_at_risk: sum((b) => b.fp_units_at_risk),
    fp_value_at_risk: sum((b) => b.fp_value_at_risk),
    resultado: sum((b) => b.resultado) + (pecasOnce ?? 0) + (atOnce ?? 0),
  }
}

// Indexa lojas por marca para a expansão da tabela.
function indexStores(stores: OwnerBriefStoreRow[]): Record<string, OwnerBriefStoreRow[]> {
  const out: Record<string, OwnerBriefStoreRow[]> = {}
  for (const s of stores) {
    const k = s.brand_name ?? 'Sem marca'
    ;(out[k] ??= []).push(s)
  }
  return out
}

// ── KPI strip (faixa de 6 KPIs: Grupo Total em destaque + 5 setores) ──
function KpiStrip({ total, brandCount, t }: { total: OwnerBriefBrandRow; brandCount: number; t: Translate }) {
  const atRisk = total.fp_units_at_risk ?? 0
  const kpis: { label: string; value: string; hint?: string | null; risk?: boolean }[] = [
    { label: t('kpiNew'), value: fmtUnits(total.novos_units, t), hint: fmtMoney(total.novos_value) },
    { label: t('kpiUsed'), value: fmtUnits(total.usados_units, t), hint: fmtMoney(total.usados_value) },
    { label: t('kpiParts'), value: fmtMoney(total.pecas_value), hint: fmtMargin(total.pecas_margin, t) },
    { label: t('kpiService'), value: fmtMoney(total.at_value), hint: fmtMargin(total.at_margin, t) },
    {
      label: t('kpiFloorPlan'),
      value: fmtUnits(total.fp_units, t),
      hint: atRisk > 0 ? t('atRisk', { count: atRisk }) : t('ok'),
      risk: atRisk > 0,
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-[1.25fr_repeat(5,1fr)]">
      {/* KPI líder: Grupo Total · resultado (escuro, em destaque) */}
      <div className="rounded-2xl bg-foreground px-4 py-3.5 text-background shadow-sm">
        <div className="text-[11px] font-extrabold uppercase tracking-wide text-background/60">
          {t('kpiGroupResult')}
        </div>
        <div className="mt-1 text-xl font-extrabold tabular-nums lg:text-2xl">{fmtMoney(total.resultado)}</div>
        <div className="mt-0.5 text-xs font-semibold text-background/70">
          {t('kpiGroupSub', { stores: total.store_count ?? 0, brands: brandCount })}
        </div>
      </div>
      {kpis.map((k) => (
        <div key={k.label} className="rounded-2xl border border-border bg-card px-4 py-3.5 shadow-sm">
          <div className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{k.label}</div>
          <div className="mt-1 text-xl font-extrabold tabular-nums text-foreground lg:text-2xl">{k.value}</div>
          {k.hint != null && (
            <div className={cn('mt-0.5 text-xs font-semibold', k.risk ? 'text-destructive' : 'text-muted-foreground')}>
              {k.hint}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Tabela cockpit por marca (linhas de marca expansíveis em lojas) ──
function CockpitTable({
  brands,
  storesByBrand,
  total,
  t,
}: {
  brands: OwnerBriefBrandRow[]
  storesByBrand: Record<string, OwnerBriefStoreRow[]>
  total: OwnerBriefBrandRow
  t: Translate
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const cols = [t('colNew'), t('colUsed'), t('colParts'), t('colAt'), t('colFp')]
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
        <h2 className="text-[15px] font-extrabold text-foreground">{t('tableTitle')}</h2>
        <span className="text-xs text-muted-foreground">{t('tableHint')}</span>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-muted/40 text-[10.5px] font-extrabold uppercase tracking-wide text-muted-foreground">
            <th className="px-3.5 py-2.5 text-left">{t('colBrandStore')}</th>
            <th className="px-3.5 py-2.5 text-right">{t('colResult')}</th>
            {cols.map((c) => (
              <th key={c} className="px-3.5 py-2.5 text-right">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {brands.map((b) => {
            const key = b.brand_name ?? ''
            const isOpen = expanded[key]
            const cells = sectorCells(b, t)
            const stores = storesByBrand[key] ?? []
            const fpAtRisk = b.fp_units_at_risk ?? 0
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}
                  className="cursor-pointer border-t border-border hover:bg-muted/40"
                >
                  <td className="px-3.5 py-2.5 text-left">
                    <span className="inline-flex items-center gap-2 font-extrabold text-foreground">
                      <span
                        className={cn(
                          'inline-block w-2.5 text-[11px] text-muted-foreground transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      >
                        ▶
                      </span>
                      {b.brand_name}
                    </span>
                  </td>
                  <td className="px-3.5 py-2.5 text-right font-extrabold tabular-nums text-foreground">
                    {fmtMoney(b.resultado)}
                  </td>
                  {cells.map((c) =>
                    c.fp === 'on' ? (
                      <td key={c.label} className="px-3.5 py-2.5 text-right font-extrabold tabular-nums text-destructive">
                        {t('fpRisk', { count: fpAtRisk })}
                      </td>
                    ) : (
                      <td key={c.label} className="px-3.5 py-2.5 text-right font-bold tabular-nums text-foreground">
                        {c.value}
                      </td>
                    ),
                  )}
                </tr>
                {isOpen &&
                  stores.map((s) => {
                    const scells = sectorCells(s, t)
                    const sFpAtRisk = s.fp_units_at_risk ?? 0
                    return (
                      <tr key={`${key}-${s.store_name}`} className="border-t border-border bg-muted/30 text-[12.5px]">
                        <td className="py-2.5 pl-9 pr-3.5 text-left text-muted-foreground">📍 {s.store_name}</td>
                        <td className="px-3.5 py-2.5 text-right tabular-nums text-muted-foreground">
                          {fmtMoney(s.resultado)}
                        </td>
                        {scells.map((c) =>
                          c.fp === 'on' ? (
                            <td key={c.label} className="px-3.5 py-2.5 text-right font-extrabold tabular-nums text-destructive">
                              {t('fpRisk', { count: sFpAtRisk })}
                            </td>
                          ) : c.fp === 'off' ? (
                            <td key={c.label} className="px-3.5 py-2.5 text-right tabular-nums text-muted-foreground">
                              {t('ok')}
                            </td>
                          ) : (
                            <td key={c.label} className="px-3.5 py-2.5 text-right tabular-nums text-muted-foreground">
                              {c.value}
                            </td>
                          ),
                        )}
                      </tr>
                    )
                  })}
              </Fragment>
            )
          })}
          {/* Linha Grupo Total (escura) */}
          <tr className="bg-foreground text-background">
            <td className="px-3.5 py-2.5 text-left font-extrabold">{t('groupTotal', { count: total.store_count ?? 0 })}</td>
            <td className="px-3.5 py-2.5 text-right font-extrabold tabular-nums">{fmtMoney(total.resultado)}</td>
            {sectorCells(total, t).map((c) => (
              <td key={c.label} className="px-3.5 py-2.5 text-right font-bold tabular-nums">
                {c.fp === 'on' ? t('fpRisk', { count: total.fp_units_at_risk ?? 0 }) : c.value}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div className="px-4 py-2.5 text-[11.5px] text-muted-foreground">{t('legend')}</div>
    </div>
  )
}

type FindingUiState = 'pending' | 'confirmed' | 'dismissed'

// ── Card de ação no rail ──
function ActionCard({
  f,
  state,
  rationale,
  onConfirm,
  onDismiss,
  t,
}: {
  f: FindingRow
  state: FindingUiState
  rationale: string | null
  onConfirm: (f: FindingRow) => void
  onDismiss: (f: FindingRow) => void
  t: Translate
}) {
  const { agentLabel } = useFindingLabels()
  const color = agentColor(f.agent_key)
  const confirmed = state === 'confirmed'
  const title = f.customer_name ?? f.contract_label ?? f.line_item_label ?? f.finding_type
  const ctx = [f.contract_label, f.line_item_label].filter((x) => x && x !== title).join(' · ')
  const severityKey = (f.severity ?? '').toLowerCase()
  const severity = ['critical', 'high', 'medium', 'low'].includes(severityKey) ? t(severityKey) : f.severity
  const conf = formatPct(f.confidence)
  const confWidth = typeof f.confidence === 'number' && Number.isFinite(f.confidence)
    ? `${Math.round((f.confidence <= 1 ? f.confidence * 100 : f.confidence))}%`
    : '0%'
  return (
    <div
      data-finding-id={f.id}
      className={cn(
        'border-t border-border px-4 py-3.5 first:border-t-0 transition-colors',
        confirmed && 'bg-success/10',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('h-2.5 w-2.5 flex-none rounded-full', color.dot)} />
        <span className={cn('text-[11px] font-extrabold uppercase tracking-wide', color.text)}>
          {agentLabel(f.agent_key)} · {severity}
        </span>
        {typeof f.delta === 'number' && (
          <span className="ml-auto text-sm font-extrabold tabular-nums text-foreground">{formatBRLKpi(f.delta)}</span>
        )}
      </div>
      <h3 className="mt-2 text-sm font-bold leading-snug text-foreground">{title}</h3>
      {ctx && <div className="mt-0.5 text-[12.5px] text-muted-foreground">{ctx}</div>}
      {confirmed ? (
        <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] font-extrabold text-success">
          ✓ {t('confirmedMsg')}
        </div>
      ) : (
        <>
          {rationale && (
            <div className="mt-2 border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
              <b className="text-foreground">{t('why')}</b> {rationale}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2.5">
            <span className="flex items-center gap-1.5 text-[11.5px] font-bold text-muted-foreground">
              <span className="h-1.5 w-10 overflow-hidden rounded-full bg-border">
                <span className="block h-full bg-primary" style={{ width: confWidth }} />
              </span>
              {conf}
            </span>
            <span className="ml-auto flex gap-1.5">
              <button
                type="button"
                onClick={() => onConfirm(f)}
                className="rounded-lg bg-foreground px-3 py-2 text-[12.5px] font-extrabold text-background transition-opacity hover:opacity-90"
              >
                ✓ {t('confirm')}
              </button>
              <button
                type="button"
                onClick={() => onDismiss(f)}
                className="rounded-lg bg-muted px-2.5 py-2 text-[12.5px] font-extrabold text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('dismiss')}
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}

// ── Rail "DIA preparou estas ações" ──
function ActionRail({
  findings,
  states,
  rationales,
  pendingCount,
  onConfirm,
  onDismiss,
  onConfirmAll,
  onSeeQueue,
  t,
}: {
  findings: FindingRow[]
  states: Record<string, FindingUiState>
  rationales: Record<string, string>
  pendingCount: number
  onConfirm: (f: FindingRow) => void
  onDismiss: (f: FindingRow) => void
  onConfirmAll: () => void
  onSeeQueue: () => void
  t: Translate
}) {
  const visible = findings.filter((f) => states[f.id] !== 'dismissed')
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
        <h2 className="text-[15px] font-extrabold text-foreground">{t('railTitle')}</h2>
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-[11px] font-extrabold text-white',
            pendingCount === 0 ? 'bg-success' : 'bg-destructive',
          )}
        >
          {pendingCount}
        </span>
      </div>
      <div className="flex flex-col">
        {visible.length === 0 && (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t('noPendingActions')}</p>
        )}
        {visible.map((f) => (
          <ActionCard
            key={f.id}
            f={f}
            state={states[f.id] ?? 'pending'}
            rationale={rationales[f.id] ?? null}
            onConfirm={onConfirm}
            onDismiss={onDismiss}
            t={t}
          />
        ))}
      </div>
      {visible.length > 0 && (
        <div className="flex gap-2.5 border-t border-border px-4 py-3.5">
          <button
            type="button"
            onClick={onConfirmAll}
            disabled={pendingCount === 0}
            className="flex-1 rounded-lg bg-primary px-3 py-2.5 text-sm font-extrabold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {t('approveAll', { count: pendingCount })}
          </button>
          <button
            type="button"
            onClick={onSeeQueue}
            className="rounded-lg border border-border bg-muted px-3 py-2.5 text-sm font-bold text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('seeQueue')}
          </button>
        </div>
      )}
    </div>
  )
}

export default function CockpitBrief() {
  const t = useTranslations('screens.cockpitBrief')
  const common = useTranslations('common')
  const openWindow = usePortalStore((s) => s.openWindow)

  const [brands, setBrands] = useState<OwnerBriefBrandRow[]>([])
  const [stores, setStores] = useState<OwnerBriefStoreRow[]>([])
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [findingStates, setFindingStates] = useState<Record<string, FindingUiState>>({})
  const [rationales, setRationales] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      getOwnerBriefByBrand().catch(() => []),
      getOwnerBriefByStore().catch(() => []),
      getFindings({ status: 'pending_approval', limit: 20 }).catch(() => []),
    ])
      .then(([b, s, f]) => {
        setBrands(b)
        setStores(s)
        setFindings(f)
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
  }, [])

  // "Por quê" sob demanda: busca o rationale de cada finding pendente (best-effort).
  useEffect(() => {
    let cancelled = false
    Promise.allSettled(findings.map((f) => getFinding(f.id))).then((settled) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      settled.forEach((r) => {
        if (r.status === 'fulfilled' && r.value?.rationale) next[r.value.id] = r.value.rationale
      })
      setRationales(next)
    })
    return () => {
      cancelled = true
    }
  }, [findings])

  const storesByBrand = useMemo(() => indexStores(stores), [stores])
  const total = useMemo(() => groupTotal(brands), [brands])

  const pendingCount = useMemo(
    () => findings.filter((f) => (findingStates[f.id] ?? 'pending') === 'pending').length,
    [findings, findingStates],
  )

  const removeFinding = useCallback((id: string) => {
    setFindings((list) => list.filter((f) => f.id !== id))
    setFindingStates((s) => {
      const next = { ...s }
      delete next[id]
      return next
    })
  }, [])

  const onConfirm = useCallback(
    async (f: FindingRow) => {
      setFindingStates((s) => ({ ...s, [f.id]: 'confirmed' }))
      try {
        await decideFinding({ findingId: f.id, decision: 'approve' })
        window.setTimeout(() => removeFinding(f.id), CONFIRM_CLEAR_DELAY_MS)
      } catch (e) {
        setFindingStates((s) => ({ ...s, [f.id]: 'pending' }))
        setError(`${t('confirmFailed')}: ${String(e)}`)
      }
    },
    [removeFinding, t],
  )

  const onDismiss = useCallback(
    async (f: FindingRow) => {
      setFindingStates((s) => ({ ...s, [f.id]: 'dismissed' }))
      try {
        await decideFinding({ findingId: f.id, decision: 'dismiss' })
        removeFinding(f.id)
      } catch (e) {
        setFindingStates((s) => ({ ...s, [f.id]: 'pending' }))
        setError(`${t('dismissFailed')}: ${String(e)}`)
      }
    },
    [removeFinding, t],
  )

  // Aprovar tudo: lote Promise.allSettled de decideFinding(approve) sobre todos os
  // pendentes (padrão do FindingsQueue.tsx); remove os que confirmaram, mantém os que
  // falharam (e reporta o erro).
  const onConfirmAll = useCallback(async () => {
    const pending = findings.filter((f) => (findingStates[f.id] ?? 'pending') === 'pending')
    if (pending.length === 0) return
    setFindingStates((s) => {
      const next = { ...s }
      pending.forEach((f) => {
        next[f.id] = 'confirmed'
      })
      return next
    })
    const settled = await Promise.allSettled(
      pending.map((f) => decideFinding({ findingId: f.id, decision: 'approve' })),
    )
    const failed: string[] = []
    settled.forEach((r, i) => {
      const f = pending[i]
      if (r.status === 'fulfilled') {
        window.setTimeout(() => removeFinding(f.id), CONFIRM_CLEAR_DELAY_MS)
      } else {
        failed.push(f.id)
      }
    })
    if (failed.length > 0) {
      setFindingStates((s) => {
        const next = { ...s }
        failed.forEach((id) => {
          next[id] = 'pending'
        })
        return next
      })
      setError(t('confirmFailed'))
    }
  }, [findings, findingStates, removeFinding, t])

  const onSeeQueue = useCallback(() => {
    openWindow({ kind: 'component', componentKey: 'findings-queue', title: t('queueTitle') })
  }, [openWindow, t])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{common('loading')}</div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-background">
      {/* topbar escuro (chrome) */}
      <div className="flex items-center gap-3.5 bg-gradient-to-r from-[#13234a] to-[#1c356a] px-5 py-3 text-white shadow">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-white/15 text-sm font-extrabold">D</span>
        <b className="font-extrabold tracking-tight">DIA</b>
        <span className="text-[13px] text-[#aebfde]">› {t('crumb')}</span>
        <div className="ml-auto flex items-center gap-4 text-[13px] text-[#cfdcf3]">
          <span className="inline-flex items-center gap-1.5 font-bold text-[#8ff0c4]">
            <span className="h-2 w-2 rounded-full bg-[#7ef0c0]" />
            {t('agentsActive', { count: 4 })}
          </span>
        </div>
      </div>

      <div className="mx-auto max-w-[1280px] p-4 sm:p-6">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-foreground lg:text-2xl">{t('desktopTitle')}</h1>
            <p className="mt-0.5 text-[13.5px] text-muted-foreground">{common('valuesInBRL')}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-[12.5px] font-bold text-primary">
            🧠 {t('analyzedLine')}
          </span>
        </header>

        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        <div className="mb-4">
          {brands.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noPreviousDayData')}</p>
          ) : (
            <KpiStrip total={total} brandCount={brands.length} t={t} />
          )}
        </div>

        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.55fr_1fr]">
          {brands.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noPreviousDayData')}</p>
          ) : (
            <CockpitTable brands={brands} storesByBrand={storesByBrand} total={total} t={t} />
          )}
          <ActionRail
            findings={findings}
            states={findingStates}
            rationales={rationales}
            pendingCount={pendingCount}
            onConfirm={onConfirm}
            onDismiss={onDismiss}
            onConfirmAll={onConfirmAll}
            onSeeQueue={onSeeQueue}
            t={t}
          />
        </div>
      </div>
    </div>
  )
}
