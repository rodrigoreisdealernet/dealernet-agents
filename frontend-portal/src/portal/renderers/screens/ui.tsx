// Primitivos visuais leves das telas de ops (o Portal DMS não tem Card/Badge React;
// estiliza por tokens Tailwind — ver cheat-sheet do design system). Usa cn() do shell.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function KpiCard({
  label,
  value,
  hint,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint != null && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
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
