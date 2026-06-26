// Primitivos visuais leves das telas de ops (o Portal DMS não tem Card/Badge React;
// estiliza por tokens Tailwind — ver cheat-sheet do design system). Usa cn() do shell.
import { TrendingDown, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatBRLKpi } from './format'

export type KpiAccent = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

// Realce de borda esquerda + leve tinta de fundo por accent. `neutral` mantém o
// card "limpo" (sem borda colorida) — preserva a aparência das chamadas legadas.
const KPI_ACCENTS: Record<KpiAccent, string> = {
  neutral: '',
  success: 'border-l-4 border-l-success bg-success/5',
  warning: 'border-l-4 border-l-warning bg-warning/5',
  danger: 'border-l-4 border-l-destructive bg-destructive/5',
  info: 'border-l-4 border-l-primary bg-primary/5',
}

export function KpiCard({
  label,
  value,
  hint,
  accent = 'neutral',
  trend,
  sparkline,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  /** Realce semântico opcional (borda esquerda + tinta). Default 'neutral' = sem realce. */
  accent?: KpiAccent
  /** Badge de tendência opcional (ex.: <TrendBadge …/>), exibido ao lado do label. */
  trend?: ReactNode
  /** Sparkline opcional (ex.: <Sparkline …/>), ancorado no rodapé do card. */
  sparkline?: ReactNode
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-5', KPI_ACCENTS[accent])}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        {trend != null && <div className="shrink-0">{trend}</div>}
      </div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint != null && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      {sparkline != null && <div className="mt-3">{sparkline}</div>}
    </div>
  )
}

export type TrendFormat = 'pct' | 'currency' | 'number'

// Badge de tendência: ▲/▼ + valor, colorido por sinal (success ganho, danger
// perda, muted neutro/nulo). `delta` em pct já vem em pontos percentuais
// (ex.: 12 => "12%"); currency/number formatam o valor absoluto.
export function TrendBadge({
  delta,
  format = 'pct',
}: {
  delta: number | null | undefined
  format?: TrendFormat
}) {
  const valid = typeof delta === 'number' && Number.isFinite(delta)
  const gain = valid && delta > 0
  const loss = valid && delta < 0
  const tone = gain ? 'text-success' : loss ? 'text-destructive' : 'text-muted-foreground'
  const Icon = loss ? TrendingDown : TrendingUp
  const abs = valid ? Math.abs(delta) : 0
  const text =
    !valid
      ? '—'
      : format === 'currency'
        ? formatBRLKpi(abs)
        : format === 'number'
          ? Math.round(abs).toLocaleString('pt-BR')
          : `${Math.round(abs)}%`
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium tabular-nums', tone)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {text}
    </span>
  )
}

// Sparkline: polyline SVG puro (sem recharts), normalizado à caixa. Pequeno o
// suficiente p/ caber dentro de um KpiCard. Renderiza nada com <2 pontos.
const SPARK_TONES: Record<'success' | 'danger' | 'primary', string> = {
  success: 'var(--success)',
  danger: 'var(--danger)',
  primary: 'var(--primary)',
}

export function Sparkline({
  data,
  tone = 'primary',
  width = 120,
  height = 32,
}: {
  data: number[]
  tone?: 'success' | 'danger' | 'primary'
  width?: number
  height?: number
}) {
  const nums = (data ?? []).filter((n) => typeof n === 'number' && Number.isFinite(n))
  if (nums.length < 2) return null
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min || 1
  const pad = 2
  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const points = nums
    .map((n, i) => {
      const x = pad + (i / (nums.length - 1)) * innerW
      const y = pad + (1 - (n - min) / span) * innerH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke={SPARK_TONES[tone]}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ProgressBar: barra horizontal 0..100. Auto-tom: <60 success, 60–85 warning,
// >85 danger (override via `tone`). Trilho bg-muted, transição via motion token.
const PROGRESS_FILL: Record<'success' | 'warning' | 'danger', string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
}

export function ProgressBar({
  value,
  tone,
}: {
  /** 0..100. */
  value: number | null | undefined
  tone?: 'success' | 'warning' | 'danger'
}) {
  const v = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  const autoTone: 'success' | 'warning' | 'danger' = v > 85 ? 'danger' : v >= 60 ? 'warning' : 'success'
  const fill = PROGRESS_FILL[tone ?? autoTone]
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full transition-all', fill)}
        style={{ width: `${v}%`, transitionDuration: 'var(--motion-duration, 200ms)' }}
      />
    </div>
  )
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const TONES: Record<Tone, string> = {
  // Usa só utilitários garantidos pela bridge de tokens do Portal DMS.
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-primary/10 text-primary',
  success: 'bg-muted text-success',
  warning: 'bg-muted text-warning',
  danger: 'bg-destructive/10 text-destructive',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', TONES[tone])}>
      {children}
    </span>
  )
}

export function severityTone(s: string | null | undefined): Tone {
  const k = (s ?? '').toLowerCase()
  if (k === 'critical' || k === 'critica' || k === 'high' || k === 'alta') return 'danger'
  if (k === 'medium' || k === 'media') return 'warning'
  return 'info'
}

export function statusTone(s: string | null | undefined): Tone {
  const k = (s ?? '').toLowerCase()
  if (k === 'approved' || k === 'aprovado') return 'success'
  if (k === 'rejected' || k === 'rejeitado') return 'danger'
  if (k === 'pending_approval' || k === 'pendente') return 'warning'
  return 'neutral'
}

// Botão de ação de linha (tabelas dos CRUDs). Substitui os antigos links
// sublinhados por botões reais: borda + ícone + rótulo, acessíveis por teclado
// (type="button" + focus ring). `tone="danger"` para ações destrutivas
// (Remover/Inativar/Cancelar); `tone="default"` para Editar.
export function RowActionButton({
  onClick,
  icon,
  label,
  tone = 'default',
}: {
  onClick: () => void
  icon: ReactNode
  label: string
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        tone === 'danger'
          ? 'border-border text-destructive hover:bg-destructive/10'
          : 'border-border text-foreground hover:bg-muted',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

// Agrupa os botões de ação de uma linha (alinhados à direita, com gap).
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-2">{children}</div>
}

export function ScreenShell({
  title,
  subtitle,
  legend,
  children,
}: {
  title: string
  subtitle?: string
  /** Nota de denominação dos KPI cards (issue #54), ex.: "Valores em R$". */
  legend?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full flex-col gap-5 overflow-auto p-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        {legend && <p className="text-xs font-medium text-muted-foreground">{legend}</p>}
      </header>
      {children}
    </div>
  )
}
