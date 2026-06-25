// Morning Brief do Dono (issue #43) — a tela que abre quando o agente DIA envia a
// mensagem matinal ao dono. 3 níveis: (1) total por marca com 5 setores + Grupo
// Total, (2) drill para as lojas da marca com destaque de Floor Plan <7d, (3)
// "DIA preparou estas ações" (findings pendentes: Confirmar/Dispensar).
//
// Responsiva: mobile = cards empilhados (protótipo v7 mobile); desktop = cockpit
// tabela + rail de ações (protótipo v7 desktop). Usa useBreakpoint p/ alternar.
//
// Dados do DIA ANTERIOR vêm das views v_dia_owner_brief_by_brand / _by_store
// (getOwnerBriefByBrand/Store). Ações vêm da fila de findings existente
// (getFindings/decideFinding) — não inventamos backend novo. Sem % de meta nesta
// fase (só valores absolutos); setores sem dado renderizam "—".
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  decideFinding,
  getFindings,
  getOwnerBriefByBrand,
  getOwnerBriefByStore,
  type FindingRow,
  type OwnerBriefBaseRow,
  type OwnerBriefBrandRow,
  type OwnerBriefStoreRow,
} from '@/portal/lib/agentsApi'
import { useBreakpoint } from '@/hooks/use-breakpoint'
import { cn } from '@/lib/utils'
import { formatBRL } from './format'

// ── Helpers de formatação dos setores (valores absolutos; "—" quando sem dado) ──
function fmtUnits(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n} un` : '—'
}
function fmtMoney(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? formatBRL(n) : '—'
}
function fmtMargin(n: number | null | undefined): string | null {
  return typeof n === 'number' && Number.isFinite(n) ? `margem ${formatBRL(n)}` : null
}

interface SectorCell {
  label: string
  value: string
  hint?: string | null
  /** 'on' = FP em risco (vermelho); 'off' = FP zero/neutro (cinza); undefined = normal. */
  fp?: 'on' | 'off'
}

// Constrói as 5 células de setor (Novos, Usados, Peças, AT, FP) de uma linha.
function sectorCells(r: OwnerBriefBaseRow): SectorCell[] {
  const atRisk = (r.fp_units_at_risk ?? 0) > 0
  return [
    { label: 'Novos', value: fmtUnits(r.novos_units), hint: fmtMoney(r.novos_value) },
    { label: 'Usados', value: fmtUnits(r.usados_units), hint: fmtMoney(r.usados_value) },
    { label: 'Peças', value: fmtMoney(r.pecas_value), hint: fmtMargin(r.pecas_margin) },
    { label: 'AT', value: fmtMoney(r.at_value), hint: fmtMargin(r.at_margin) },
    {
      label: 'FP',
      value: typeof r.fp_units === 'number' ? String(r.fp_units) : '—',
      hint: atRisk ? `${r.fp_units_at_risk} em risco <7d` : 'ok',
      fp: atRisk ? 'on' : 'off',
    },
  ]
}

// Soma as marcas no card "Grupo Total" (mesma forma de OwnerBriefBrandRow).
function groupTotal(brands: OwnerBriefBrandRow[]): OwnerBriefBrandRow {
  const sum = (pick: (b: OwnerBriefBrandRow) => number | null) =>
    brands.reduce((acc, b) => acc + (pick(b) ?? 0), 0)
  const anyNonNull = (pick: (b: OwnerBriefBrandRow) => number | null) =>
    brands.some((b) => typeof pick(b) === 'number' && Number.isFinite(pick(b) as number))
  const sumOrNull = (pick: (b: OwnerBriefBrandRow) => number | null) =>
    anyNonNull(pick) ? sum(pick) : null
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
    pecas_value: sumOrNull((b) => b.pecas_value),
    pecas_margin: sumOrNull((b) => b.pecas_margin),
    at_value: sumOrNull((b) => b.at_value),
    at_margin: sumOrNull((b) => b.at_margin),
    fp_units: sum((b) => b.fp_units),
    fp_value: sum((b) => b.fp_value),
    fp_units_at_risk: sum((b) => b.fp_units_at_risk),
    fp_value_at_risk: sum((b) => b.fp_value_at_risk),
    resultado: sum((b) => b.resultado),
  }
}

// ── Células de setor (grid de 5) ──
function Cells({ cells }: { cells: SectorCell[] }) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {cells.map((c) => (
        <div key={c.label} className="rounded-md bg-muted/60 px-1 py-1.5 text-center">
          <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{c.label}</div>
          <div
            className={cn(
              'mt-0.5 text-sm font-bold tabular-nums text-foreground',
              c.fp === 'on' && 'text-destructive',
              c.fp === 'off' && 'text-muted-foreground',
            )}
          >
            {c.value}
          </div>
          {c.hint != null && <div className="mt-0.5 text-[9px] text-muted-foreground">{c.hint}</div>}
        </div>
      ))}
    </div>
  )
}

// ── MOBILE: card por marca (toque → drill de lojas) ──
function BrandCard({ b, onOpen }: { b: OwnerBriefBrandRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <div className="mb-2.5 flex items-start justify-between">
        <div>
          <div className="text-sm font-extrabold text-foreground">{b.brand_name}</div>
          <div className="text-xs font-medium text-muted-foreground">
            {b.store_count ?? 0} {b.store_count === 1 ? 'loja' : 'lojas'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-base font-extrabold tabular-nums text-foreground">{fmtMoney(b.resultado)}</div>
          <div className="text-[10px] font-semibold text-muted-foreground">Resultado</div>
        </div>
      </div>
      <Cells cells={sectorCells(b)} />
      <div className="mt-2 text-right text-[11px] text-muted-foreground">ver lojas →</div>
    </button>
  )
}

// ── MOBILE: card "Grupo Total" (escuro, como no protótipo) ──
function GroupTotalCard({ total }: { total: OwnerBriefBrandRow }) {
  const cells = sectorCells(total)
  return (
    <div className="rounded-xl bg-foreground p-3 text-background">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-extrabold">Grupo Total</span>
        <span className="text-base font-extrabold tabular-nums">{fmtMoney(total.resultado)}</span>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {cells.map((c) => (
          <div key={c.label} className="text-center">
            <div className="text-[9px] font-bold uppercase tracking-wide text-background/60">{c.label}</div>
            <div className="mt-0.5 text-sm font-bold tabular-nums text-background/90">{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── MOBILE: drill de lojas de uma marca ──
function StoresDrill({
  brand,
  stores,
  onBack,
}: {
  brand: OwnerBriefBrandRow
  stores: OwnerBriefStoreRow[]
  onBack: () => void
}) {
  const fpUnits = brand.fp_units_at_risk ?? 0
  const atRisk = fpUnits > 0
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-sm text-muted-foreground hover:text-foreground"
      >
        ← Voltar
      </button>
      <div>
        <div className="text-lg font-extrabold text-foreground">{brand.brand_name}</div>
        <div className="text-sm text-muted-foreground">
          {fmtMoney(brand.resultado)} · {brand.store_count ?? 0}{' '}
          {brand.store_count === 1 ? 'loja' : 'lojas'}
        </div>
      </div>
      <div
        className={cn(
          'flex items-center justify-between rounded-lg border px-3.5 py-2.5',
          atRisk ? 'border-destructive/30 bg-destructive/10' : 'border-border bg-muted/40',
        )}
      >
        <span className={cn('text-xs font-bold', atRisk ? 'text-destructive' : 'text-muted-foreground')}>
          Floor Plan &lt;7d
        </span>
        <span
          className={cn('text-sm font-extrabold tabular-nums', atRisk ? 'text-destructive' : 'text-muted-foreground')}
        >
          {fpUnits} un · {fmtMoney(brand.fp_value_at_risk)}
        </span>
      </div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Por loja</div>
      <div className="flex flex-col gap-2.5">
        {stores.length === 0 && (
          <p className="text-sm text-muted-foreground">Sem lojas para esta marca.</p>
        )}
        {stores.map((s) => (
          <div key={s.store_name} className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2.5 flex items-start justify-between">
              <div className="text-sm font-extrabold text-foreground">📍 {s.store_name}</div>
              <div className="text-right">
                <div className="text-base font-extrabold tabular-nums text-foreground">{fmtMoney(s.resultado)}</div>
                <div className="text-[10px] font-semibold text-muted-foreground">Resultado</div>
              </div>
            </div>
            <Cells cells={sectorCells(s)} />
          </div>
        ))}
      </div>
    </div>
  )
}

type FindingUiState = 'pending' | 'confirmed' | 'dismissed'

// ── Seção de ações (findings pendentes) — Confirmar (approve) / Dispensar ──
function ActionsSection({
  findings,
  states,
  onConfirm,
  onDismiss,
  className,
}: {
  findings: FindingRow[]
  states: Record<string, FindingUiState>
  onConfirm: (f: FindingRow) => void
  onDismiss: (f: FindingRow) => void
  className?: string
}) {
  const visible = findings.filter((f) => states[f.id] !== 'dismissed')
  return (
    <div className={className}>
      <div className="mb-0.5 text-sm font-extrabold text-foreground">⚡ DIA preparou estas ações</div>
      <div className="mb-3 text-xs text-muted-foreground">Confirme com um toque</div>
      {visible.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhuma ação pendente no momento.</p>
      )}
      <div className="flex flex-col gap-2.5">
        {visible.map((f) => {
          const state = states[f.id] ?? 'pending'
          const confirmed = state === 'confirmed'
          const label = f.customer_name ?? f.contract_label ?? f.line_item_label ?? f.finding_type
          return (
            <div
              key={f.id}
              className={cn(
                'rounded-xl border p-3.5 transition-colors',
                confirmed ? 'border-success/40 bg-success/10' : 'border-border bg-muted/40',
              )}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  {f.agent_key} · {f.finding_type}
                </span>
              </div>
              <div className="mb-1 text-sm font-bold text-foreground">{label}</div>
              {typeof f.delta === 'number' && (
                <div className="mb-3 text-xs text-muted-foreground">Δ {formatBRL(f.delta)}</div>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={confirmed}
                  onClick={() => onConfirm(f)}
                  className={cn(
                    'flex-1 rounded-lg px-3.5 py-2 text-sm font-bold transition-colors',
                    confirmed
                      ? 'cursor-default bg-success text-white'
                      : 'bg-foreground text-background hover:opacity-90',
                  )}
                >
                  {confirmed ? '✓ Confirmado' : '✓ Confirmar'}
                </button>
                {!confirmed && (
                  <button
                    type="button"
                    onClick={() => onDismiss(f)}
                    className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Dispensar
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── DESKTOP: tabela cockpit (marca expansível → linhas de loja) ──
function CockpitTable({
  brands,
  storesByBrand,
  total,
}: {
  brands: OwnerBriefBrandRow[]
  storesByBrand: Record<string, OwnerBriefStoreRow[]>
  total: OwnerBriefBrandRow
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const cols = ['Novos', 'Usados', 'Peças', 'AT', 'FP']
  const cellText = (c: SectorCell) => c.value
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          <th className="px-3 py-2">Marca / Loja</th>
          <th className="px-3 py-2 text-right">Resultado</th>
          {cols.map((c) => (
            <th key={c} className="px-3 py-2 text-right">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {brands.map((b) => {
          const key = b.brand_name ?? ''
          const isOpen = expanded[key]
          const cells = sectorCells(b)
          const stores = storesByBrand[key] ?? []
          return (
            <Fragment key={key}>
              <tr
                onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}
                className="cursor-pointer border-b border-border/60 hover:bg-muted/40"
              >
                <td className="px-3 py-2.5">
                  <div className="font-extrabold text-foreground">
                    <span className="mr-1.5 inline-block w-3 text-muted-foreground">{isOpen ? '▾' : '▸'}</span>
                    {b.brand_name}
                  </div>
                  <div className="ml-[1.125rem] text-xs text-muted-foreground">
                    {b.store_count ?? 0} {b.store_count === 1 ? 'loja' : 'lojas'}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right font-extrabold tabular-nums text-foreground">
                  {fmtMoney(b.resultado)}
                </td>
                {cells.map((c) => (
                  <td
                    key={c.label}
                    className={cn(
                      'px-3 py-2.5 text-right font-bold tabular-nums',
                      c.fp === 'on' ? 'text-destructive' : c.fp === 'off' ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {cellText(c)}
                  </td>
                ))}
              </tr>
              {isOpen &&
                stores.map((s) => {
                  const scells = sectorCells(s)
                  return (
                    <tr key={`${key}-${s.store_name}`} className="border-b border-border/40 bg-muted/20">
                      <td className="px-3 py-2 pl-8">
                        <div className="text-sm text-foreground">📍 {s.store_name}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">{fmtMoney(s.resultado)}</td>
                      {scells.map((c) => (
                        <td
                          key={c.label}
                          className={cn(
                            'px-3 py-2 text-right tabular-nums',
                            c.fp === 'on'
                              ? 'text-destructive'
                              : c.fp === 'off'
                                ? 'text-muted-foreground'
                                : 'text-foreground',
                          )}
                        >
                          {cellText(c)}
                        </td>
                      ))}
                    </tr>
                  )
                })}
            </Fragment>
          )
        })}
        {/* Linha Grupo Total */}
        <tr className="bg-foreground text-background">
          <td className="px-3 py-2.5 font-extrabold">Grupo Total</td>
          <td className="px-3 py-2.5 text-right font-extrabold tabular-nums">{fmtMoney(total.resultado)}</td>
          {sectorCells(total).map((c) => (
            <td key={c.label} className="px-3 py-2.5 text-right font-bold tabular-nums">
              {c.value}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  )
}

// Indexa lojas por marca para o drill (mobile) / expansão (desktop).
function indexStores(stores: OwnerBriefStoreRow[]): Record<string, OwnerBriefStoreRow[]> {
  const out: Record<string, OwnerBriefStoreRow[]> = {}
  for (const s of stores) {
    const k = s.brand_name ?? 'Sem marca'
    ;(out[k] ??= []).push(s)
  }
  return out
}

function briefDateLabel(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'short' })
}

export default function MorningBrief() {
  const { compact } = useBreakpoint()
  const [brands, setBrands] = useState<OwnerBriefBrandRow[]>([])
  const [stores, setStores] = useState<OwnerBriefStoreRow[]>([])
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [findingStates, setFindingStates] = useState<Record<string, FindingUiState>>({})
  const [openBrand, setOpenBrand] = useState<string | null>(null)
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

  const storesByBrand = useMemo(() => indexStores(stores), [stores])
  const total = useMemo(() => groupTotal(brands), [brands])

  const onConfirm = useCallback(async (f: FindingRow) => {
    setFindingStates((s) => ({ ...s, [f.id]: 'confirmed' }))
    try {
      await decideFinding({ findingId: f.id, decision: 'approve' })
    } catch (e) {
      // Reverte o estado otimista se a decisão falhar.
      setFindingStates((s) => ({ ...s, [f.id]: 'pending' }))
      setError(`Falha ao confirmar: ${String(e)}`)
    }
  }, [])

  const onDismiss = useCallback((f: FindingRow) => {
    // Dispensar = ocultar localmente (não rejeita no backend sem motivo obrigatório).
    setFindingStates((s) => ({ ...s, [f.id]: 'dismissed' }))
  }, [])

  const dateLabel = briefDateLabel()

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Carregando…</div>
    )
  }

  // ── MOBILE: cards empilhados + drill + ações abaixo ──
  if (compact) {
    const drillBrand = openBrand ? brands.find((b) => b.brand_name === openBrand) : null
    return (
      <div className="flex h-full flex-col gap-4 overflow-auto p-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {drillBrand ? (
          <StoresDrill
            brand={drillBrand}
            stores={storesByBrand[drillBrand.brand_name ?? ''] ?? []}
            onBack={() => setOpenBrand(null)}
          />
        ) : (
          <>
            <header>
              <div className="text-[11px] font-extrabold uppercase tracking-widest text-muted-foreground">
                Morning Brief
              </div>
              <div className="mt-0.5 flex items-baseline justify-between">
                <div className="text-xl font-extrabold capitalize text-foreground">Ontem</div>
                <div className="text-xs capitalize text-muted-foreground">{dateLabel}</div>
              </div>
            </header>
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              Por marca · toque para ver lojas
            </div>
            <div className="flex flex-col gap-2.5">
              {brands.length === 0 && (
                <p className="text-sm text-muted-foreground">Sem dados do dia anterior.</p>
              )}
              {brands.map((b) => (
                <BrandCard key={b.brand_name} b={b} onOpen={() => setOpenBrand(b.brand_name)} />
              ))}
            </div>
            {brands.length > 0 && <GroupTotalCard total={total} />}
            <ActionsSection
              findings={findings}
              states={findingStates}
              onConfirm={onConfirm}
              onDismiss={onDismiss}
              className="mt-2"
            />
          </>
        )}
      </div>
    )
  }

  // ── DESKTOP: cockpit (tabela + rail de ações) ──
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-start justify-between border-b border-border px-6 py-4">
        <div>
          <div className="text-[11px] font-extrabold uppercase tracking-widest text-muted-foreground">
            Morning Brief · Portal DIA
          </div>
          <div className="text-xl font-extrabold text-foreground">Resultado por marca e loja · ontem</div>
        </div>
        <div className="text-right text-xs capitalize text-muted-foreground">{dateLabel}</div>
      </header>
      {error && <p className="px-6 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-auto p-6">
          {brands.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem dados do dia anterior.</p>
          ) : (
            <CockpitTable brands={brands} storesByBrand={storesByBrand} total={total} />
          )}
        </div>
        <aside className="w-[340px] flex-shrink-0 overflow-auto border-l border-border bg-muted/20 p-5">
          <ActionsSection
            findings={findings}
            states={findingStates}
            onConfirm={onConfirm}
            onDismiss={onDismiss}
          />
        </aside>
      </div>
    </div>
  )
}
