// ChartCard — widget de gráfico presentacional (recharts) dos primitivos do Portal DMS.
//
// FOUNDATION: este widget é a base dos dashboards de "Fast BI" (issues #15-#18 o
// compõem dentro das próprias telas). Ele é PRESENTACIONAL: recebe `data` já
// resolvido via props e NÃO carrega nada de API/dataSource.
//
// Contrato de props (ChartCardProps):
//   - title:       título visível no topo do card.
//   - type:        'line' | 'bar' | 'pie' — escolhe LineChart/BarChart/PieChart.
//   - data:        Array<Record<string, unknown>> — séries já carregadas.
//   - xKey:        chave de `data` usada como eixo de categorias (e como `name`
//                  das fatias no pie).
//   - series:      Array<{ key; label?; color?; format? }> — uma série desenhada
//                  por item. `key` é o campo numérico em `data`; `label` é o nome
//                  exibido na legenda/tooltip; `color` sobrescreve a paleta padrão;
//                  `format` sobrescreve `valueFormat` para aquela série.
//                  PIE: usa a PRIMEIRA série como valor das fatias.
//   - valueFormat: 'currency' | 'percent' | 'number' (default 'number') —
//                  formatação de eixo/tooltip/rótulos: currency reaproveita
//                  formatBRL, percent reaproveita formatPct, number usa pt-BR.
//   - emptyMessage:texto do estado vazio (default 'Sem dados para exibir').
//   - height:      altura do gráfico em px (default 280).
//
// Tema: usa exclusivamente tokens do DS via var(...) (foreground, muted-foreground,
// border, primary, status). A moldura do card espelha os primitivos de ui.tsx
// (`rounded-lg border border-border bg-card`).

import { useMemo, type ReactNode } from 'react'
import { useTranslations } from 'use-intl'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatBRLKpi, formatPct } from './format'

export type ChartType = 'line' | 'bar' | 'pie'

export type ValueFormat = 'currency' | 'percent' | 'number'

export interface ChartSeries {
  /** Campo numérico de `data` desenhado por esta série. */
  key: string
  /** Nome exibido na legenda/tooltip (default: `key`). */
  label?: string
  /** Cor da série; sobrescreve a paleta padrão alinhada ao tema. */
  color?: string
  /** Formatação específica desta série; sobrescreve `valueFormat`. */
  format?: ValueFormat
}

export interface ChartCardProps {
  title: string
  type: ChartType
  data: Array<Record<string, unknown>>
  xKey: string
  series: ChartSeries[]
  valueFormat?: ValueFormat
  emptyMessage?: string
  height?: number
  /** BAR de série única: pinta cada barra com uma cor distinta (cicla a paleta),
   *  como o pie faz por fatia. Ignorado em line/pie ou com múltiplas séries. */
  colorByPoint?: boolean
}

const DEFAULT_HEIGHT = 280
// Paleta padrão ancorada nos tokens de tema do DS (primary + status). Recharts
// recebe cores como strings CSS, então usamos var(--token); o tema (claro/escuro)
// propaga sozinho. Ciclamos esta paleta quando a série não define `color`.
const DEFAULT_PALETTE = [
  'var(--primary)',
  'var(--success)',
  'var(--warning)',
  'var(--danger)',
  'var(--info)',
]

function formatValue(value: unknown, fmt: ValueFormat): string {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num)) return '—'
  if (fmt === 'currency') return formatBRLKpi(num)
  if (fmt === 'percent') return formatPct(num)
  return num.toLocaleString('pt-BR')
}

function seriesColor(s: ChartSeries, index: number): string {
  return s.color ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]
}

function CardFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <div className="mt-4">{children}</div>
    </div>
  )
}

export function ChartCard({
  title,
  type,
  data,
  xKey,
  series,
  valueFormat = 'number',
  emptyMessage: emptyMessageProp,
  height = DEFAULT_HEIGHT,
  colorByPoint = false,
}: ChartCardProps) {
  const common = useTranslations('common')
  const isEmpty = !data || data.length === 0 || series.length === 0
  const emptyMessage = emptyMessageProp ?? common('noData')

  // Formatador padrão (eixo/tooltip) derivado de `valueFormat`.
  const axisFormatter = useMemo(
    () => (value: unknown) => formatValue(value, valueFormat),
    [valueFormat],
  )

  if (isEmpty) {
    return (
      <CardFrame title={title}>
        <div className="text-sm text-muted-foreground">{emptyMessage}</div>
      </CardFrame>
    )
  }

  // Eixos/grid/tooltip compartilham os tokens do tema via var(...).
  const axisStyle = { fill: 'var(--ink-2)', fontSize: 12 }
  const tooltipStyle = {
    backgroundColor: 'var(--overlay)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--ink)',
    fontSize: 12,
  }

  return (
    <CardFrame title={title}>
      <ResponsiveContainer width="100%" height={height}>
        {type === 'pie' ? (
          <PieChart>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value) => formatValue(value, series[0].format ?? valueFormat)}
            />
            <Legend />
            <Pie
              data={data}
              dataKey={series[0].key}
              nameKey={xKey}
              cx="50%"
              cy="50%"
              outerRadius="80%"
              label
            >
              {data.map((_, index) => (
                <Cell
                  key={`slice-${index}`}
                  fill={DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]}
                />
              ))}
            </Pie>
          </PieChart>
        ) : type === 'bar' ? (
          <BarChart data={data}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} tick={axisStyle} stroke="var(--border)" />
            <YAxis tick={axisStyle} stroke="var(--border)" tickFormatter={axisFormatter} />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: 'var(--surface-2)' }}
              formatter={(value, _name, item) =>
                formatValue(value, seriesFormat(series, item?.dataKey, valueFormat))
              }
            />
            <Legend />
            {series.map((s, index) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label ?? s.key}
                fill={seriesColor(s, index)}
                radius={[2, 2, 0, 0]}
              >
                {colorByPoint && series.length === 1
                  ? data.map((_, i) => (
                      <Cell key={`bar-${i}`} fill={DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]} />
                    ))
                  : null}
              </Bar>
            ))}
          </BarChart>
        ) : (
          <LineChart data={data}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey={xKey} tick={axisStyle} stroke="var(--border)" />
            <YAxis tick={axisStyle} stroke="var(--border)" tickFormatter={axisFormatter} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value, _name, item) =>
                formatValue(value, seriesFormat(series, item?.dataKey, valueFormat))
              }
            />
            <Legend />
            {series.map((s, index) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label ?? s.key}
                stroke={seriesColor(s, index)}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </CardFrame>
  )
}

// Resolve o formato de uma série a partir do dataKey do ponto sob o tooltip,
// caindo para o formato global quando não há override por série.
function seriesFormat(
  series: ChartSeries[],
  dataKey: unknown,
  fallback: ValueFormat,
): ValueFormat {
  if (typeof dataKey !== 'string') return fallback
  const match = series.find((s) => s.key === dataKey)
  return match?.format ?? fallback
}

export default ChartCard
