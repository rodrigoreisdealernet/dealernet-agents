// Part Sales — entidade transacional de venda de peças (issue #10).
// Lista vendas correntes de v_dia_part_sale_current e permite registrar/cancelar
// via as RPCs atômicas create_part_sale / cancel_part_sale, que baixam/estornam
// o estoque da peça na mesma transação.
// Leitura direta (RLS authenticated); escrita só pela RPC (admin/branch_manager).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  getPartSales,
  getParts,
  createPartSale,
  cancelPartSale,
  type PartSaleRow,
  type PartSaleInput,
  type PartRow,
} from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell, RowActions, RowActionButton, type Tone } from './ui'
import { XCircle } from 'lucide-react'
import { formatBRL, formatBRLKpi } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

type FormState = {
  part_id: string
  quantity: string
  unit_price: string
  discount: string
  sale_date: string
  customer: string
  salesperson: string
}

function emptyForm(): FormState {
  return {
    part_id: '',
    quantity: '',
    unit_price: '',
    discount: '',
    sale_date: new Date().toISOString().slice(0, 10),
    customer: '',
    salesperson: '',
  }
}

function num(v: string): number | null {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) ? null : n
}

function statusTone(s: string | null | undefined): Tone {
  return (s ?? '').toLowerCase() === 'cancelada' ? 'neutral' : 'success'
}

export default function PartSales() {
  const t = useTranslations('screens.partSales')
  const common = useTranslations('common')
  const [rows, setRows] = useState<PartSaleRow[]>([])
  const [parts, setParts] = useState<PartRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([getPartSales(), getParts()])
      .then(([sales, p]) => {
        setRows(sales)
        setParts(p)
        setError(null)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const kpis = useMemo(() => {
    const total = rows.length
    const units = rows.reduce((s, r) => s + (r.quantity ?? 0), 0)
    const revenue = rows.reduce((s, r) => s + (r.total ?? 0), 0)
    return { total, units, revenue }
  }, [rows])

  const partById = useMemo(() => {
    const m = new Map<string, PartRow>()
    for (const p of parts) m.set(p.entity_id, p)
    return m
  }, [parts])

  const onSelectPart = (form: FormState, partId: string): FormState => {
    const p = partById.get(partId)
    return {
      ...form,
      part_id: partId,
      unit_price: form.unit_price.trim() === '' && p?.unit_price != null ? String(p.unit_price) : form.unit_price,
    }
  }

  const submit = async () => {
    if (!form) return
    const quantity = num(form.quantity)
    const unitPrice = num(form.unit_price)
    if (!form.part_id) {
      setError(t('selectPart'))
      return
    }
    if (quantity == null || quantity <= 0) {
      setError(t('quantityPositive'))
      return
    }
    if (unitPrice == null || unitPrice < 0) {
      setError(t('unitPriceNonNegative'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: PartSaleInput = {
        part_id: form.part_id,
        quantity,
        unit_price: unitPrice,
        discount: num(form.discount) ?? 0,
        sale_date: form.sale_date || null,
        customer: form.customer.trim() || null,
        salesperson: form.salesperson.trim() || null,
        channel: 'balcao',
      }
      await createPartSale(payload)
      setForm(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const cancel = async (row: PartSaleRow) => {
    if (!window.confirm(t('cancelConfirm').replace('{part}', row.part_number ?? '—'))) return
    setError(null)
    try {
      await cancelPartSale(row.entity_id)
      load()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label={t('sales')} value={kpis.total} />
        <KpiCard label={t('partsSold')} value={kpis.units} />
        <KpiCard label={t('revenue')} value={formatBRLKpi(kpis.revenue)} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('currentSales')}</h2>
        <button
          type="button"
          onClick={() => setForm(emptyForm())}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('registerSale')}
        </button>
      </div>

      {form && (
        <SaleForm
          form={form}
          parts={parts}
          saving={saving}
          onChange={setForm}
          onSelectPart={(id) => setForm(onSelectPart(form, id))}
          onCancel={() => setForm(null)}
          onSubmit={submit}
          t={t}
          common={common}
        />
      )}

      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">{t('part')}</th>
              <th className="px-3 py-2 text-right">{t('quantityShort')}</th>
              <th className="px-3 py-2 text-right">{t('unitPrice')}</th>
              <th className="px-3 py-2 text-right">{t('discount')}</th>
              <th className="px-3 py-2 text-right">{common('total')}</th>
              <th className="px-3 py-2">{t('date')}</th>
              <th className="px-3 py-2">{t('customer')}</th>
              <th className="px-3 py-2">{t('salesperson')}</th>
              <th className="px-3 py-2">{common('status')}</th>
              <th className="px-3 py-2 text-right">{common('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entity_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.part_number ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">{r.description ?? '—'}</div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.quantity ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.unit_price)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.discount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.total)}</td>
                <td className="px-3 py-2">{r.sale_date ?? '—'}</td>
                <td className="px-3 py-2">{r.customer ?? '—'}</td>
                <td className="px-3 py-2">{r.salesperson ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <RowActions>
                    <RowActionButton
                      tone="danger"
                      icon={<XCircle size={14} />}
                      label={common('cancel')}
                      onClick={() => cancel(r)}
                    />
                  </RowActions>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('noSales')}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {common('loading')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ScreenShell>
  )
}

function SaleForm({
  form,
  parts,
  saving,
  onChange,
  onSelectPart,
  onCancel,
  onSubmit,
  t,
  common,
}: {
  form: FormState
  parts: PartRow[]
  saving: boolean
  onChange: (f: FormState) => void
  onSelectPart: (partId: string) => void
  onCancel: () => void
  onSubmit: () => void
  t: (key: string) => string
  common: (key: string) => string
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => onChange({ ...form, [k]: v })
  const inputCls =
    'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary'

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('registerSale')}</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground md:col-span-2">
          {t('part')}
          <select
            className={inputCls}
            value={form.part_id}
            onChange={(e) => onSelectPart(e.target.value)}
          >
            <option value="">{t('selectPartOption')}</option>
            {parts.map((p) => (
              <option key={p.entity_id} value={p.entity_id}>
                {(p.part_number ?? '—') + ' · ' + (p.description ?? '')} ({t('stock')}: {p.quantity_in_stock ?? 0})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          {t('quantity')}
          <input
            type="number"
            className={inputCls}
            value={form.quantity}
            onChange={(e) => set('quantity', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('unitPriceBRL')}
          <input
            type="number"
            className={inputCls}
            value={form.unit_price}
            onChange={(e) => set('unit_price', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('discountBRL')}
          <input
            type="number"
            className={inputCls}
            value={form.discount}
            onChange={(e) => set('discount', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('saleDate')}
          <input
            type="date"
            className={inputCls}
            value={form.sale_date}
            onChange={(e) => set('sale_date', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('customer')}
          <input
            className={inputCls}
            value={form.customer}
            onChange={(e) => set('customer', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('salesperson')}
          <input
            className={inputCls}
            value={form.salesperson}
            onChange={(e) => set('salesperson', e.target.value)}
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {common('cancel')}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? common('saving') : t('register')}
        </button>
      </div>
    </div>
  )
}
