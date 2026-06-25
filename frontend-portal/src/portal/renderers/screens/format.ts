// Formatadores das telas de ops (pt-BR). delta/valores em R$ (narrativa da POC);
// confidence é probabilidade 0..1.

export function formatBRL(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// Formato monetário enxuto para os KPI cards dos dashboards (issue #54): sem o
// símbolo "R$" e sem casas decimais, mantendo o separador de milhar pt-BR
// (ex.: 19301100 -> "19.301.100"). Arredonda para inteiro. Tabelas, tooltips de
// gráfico e valores de detalhe continuam usando formatBRL (com R$ e centavos).
// A denominação em reais fica numa legenda "Valores em R$" por dashboard.
export function formatBRLKpi(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
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
