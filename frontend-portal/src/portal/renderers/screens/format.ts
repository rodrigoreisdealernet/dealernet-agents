// Formatadores das telas de ops (pt-BR). delta/valores em R$ (narrativa da POC);
// confidence é probabilidade 0..1.

export function formatBRL(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function formatPct(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  // confidence vem 0..1; demais percentuais (utilização) já vêm 0..100.
  const pct = v <= 1 ? v * 100 : v
  return `${Math.round(pct)}%`
}

export function formatDateTime(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR')
}
