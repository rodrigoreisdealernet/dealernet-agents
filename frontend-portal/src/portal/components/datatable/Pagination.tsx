// Paginação do grid: navegação + tamanho de página + contagem "x–y de total".

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useTranslations } from 'use-intl'

const SIZES = [25, 50, 100, 200]

export default function Pagination({
  page,
  size,
  total,
  onPage,
  onSize,
}: {
  page: number
  size: number
  total: number
  onPage: (p: number) => void
  onSize: (s: number) => void
}) {
  const t = useTranslations('common.grid')
  const pages = Math.max(1, Math.ceil(total / size))
  const ini = total === 0 ? 0 : (page - 1) * size + 1
  const fim = Math.min(page * size, total)

  const btn =
    'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

  return (
    <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="tabular-nums">
          {ini}–{fim} {t('of')} {total.toLocaleString('pt-BR')}
        </span>
        <select
          value={size}
          onChange={(e) => onSize(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus:border-primary"
        >
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s} / {t('pageAbbr')}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(1)} title={t('first')}>
          <ChevronsLeft size={16} />
        </button>
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)} title={t('previous')}>
          <ChevronLeft size={16} />
        </button>
        <span className="px-2 tabular-nums text-muted-foreground">
          {page} / {pages}
        </span>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)} title={t('next')}>
          <ChevronRight size={16} />
        </button>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(pages)} title={t('last')}>
          <ChevronsRight size={16} />
        </button>
      </div>
    </div>
  )
}
