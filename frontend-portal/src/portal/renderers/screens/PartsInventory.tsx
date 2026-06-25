// Parts Inventory — segunda entidade do domínio concessionária (issue #8).
// Lista peças correntes de v_dia_part_current e permite criar/editar/inativar
// via as RPCs endurecidas create_part / update_part / delete_part.
// Leitura direta (RLS authenticated); escrita só pela RPC (admin/branch_manager).
// Destaca o estado de estoque (zerado/critico/baixo/ok) com badge.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  getParts,
  createPart,
  updatePart,
  deletePart,
  type PartRow,
  type PartInput,
  type PartStockStatus,
} from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell, RowActions, RowActionButton, type Tone } from './ui'
import { Pencil, Trash2 } from 'lucide-react'
import { formatBRL, formatBRLKpi } from './format'
export const I18N_PT_LEGEND_REFERENCE = 'Valores em R$'

type FormState = PartInput & { entity_id?: string }

const EMPTY_FORM: FormState = {
  part_number: '',
  description: '',
  manufacturer: '',
  unit_cost: null,
  unit_price: null,
  quantity_in_stock: null,
  min_stock: null,
  reorder_point: null,
  location: '',
  status: 'ativo',
}

function stockTone(s: PartStockStatus | null | undefined): Tone {
  switch ((s ?? '').toLowerCase()) {
    case 'zerado':
      return 'danger'
    case 'critico':
      return 'danger'
    case 'baixo':
      return 'warning'
    default:
      return 'success'
  }
}

function statusTone(s: string | null | undefined): Tone {
  return (s ?? '').toLowerCase() === 'inativo' ? 'neutral' : 'info'
}

function num(v: string): number | null {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) ? null : n
}

export default function PartsInventory() {
  const t = useTranslations('screens.partsInventory')
  const common = useTranslations('common')
  const [rows, setRows] = useState<PartRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getParts()
      .then((r) => {
        setRows(r)
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
    const criticas = rows.filter((r) => ['zerado', 'critico', 'baixo'].includes(r.stock_status)).length
    const zeradas = rows.filter((r) => r.stock_status === 'zerado').length
    const stockValue = rows.reduce((s, r) => s + (r.stock_value ?? 0), 0)
    return { total, criticas, zeradas, stockValue }
  }, [rows])

  const submit = async () => {
    if (!form) return
    if (!form.part_number.trim() || !form.description.trim()) {
      setError(t('codeDescriptionRequired'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: PartInput = {
        part_number: form.part_number.trim(),
        description: form.description.trim(),
        manufacturer: form.manufacturer?.trim() || null,
        unit_cost: form.unit_cost ?? null,
        unit_price: form.unit_price ?? null,
        quantity_in_stock: form.quantity_in_stock ?? null,
        min_stock: form.min_stock ?? null,
        reorder_point: form.reorder_point ?? null,
        location: form.location?.trim() || null,
        status: form.status ?? 'ativo',
      }
      if (form.entity_id) await updatePart(form.entity_id, payload)
      else await createPart(payload)
      setForm(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: PartRow) => {
    if (!window.confirm(t('inactivateConfirm').replace('{name}', row.part_number ?? row.name ?? '—'))) return
    setError(null)
    try {
      await deletePart(row.entity_id)
      load()
    } catch (e) {
      setError(String(e))
    }
  }

  const stockLabel = (status: string | null | undefined) => {
    const labels: Record<string, string> = {
      zerado: t('stockZero'),
      critico: t('stockCritical'),
      baixo: t('stockLow'),
      ok: t('stockOk'),
    }
    return labels[(status ?? '').toLowerCase()] ?? status ?? '—'
  }

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
      legend={common('valuesInBRL')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label={common('total')} value={kpis.total} />
        <KpiCard label={t('replenishCritical')} value={kpis.criticas} />
        <KpiCard label={t('zeroStock')} value={kpis.zeradas} />
        <KpiCard label={t('inventoryValue')} value={formatBRLKpi(kpis.stockValue)} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('currentParts')}</h2>
        <button
          type="button"
          onClick={() => setForm({ ...EMPTY_FORM })}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('newPart')}
        </button>
      </div>

      {form && (
        <PartForm
          form={form}
          saving={saving}
          onChange={setForm}
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
              <th className="px-3 py-2 text-right">{t('stockQty')}</th>
              <th className="px-3 py-2 text-right">{t('unitPrice')}</th>
              <th className="px-3 py-2 text-right">{t('stockValue')}</th>
              <th className="px-3 py-2">{t('stock')}</th>
              <th className="px-3 py-2">{common('status')}</th>
              <th className="px-3 py-2 text-right">{common('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entity_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.part_number ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.description ?? '—'}
                    {r.manufacturer ? ` · ${r.manufacturer}` : ''}
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.quantity_in_stock ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.unit_price)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.stock_value)}</td>
                <td className="px-3 py-2">
                  <Badge tone={stockTone(r.stock_status)}>{stockLabel(r.stock_status)}</Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <RowActions>
                    <RowActionButton
                      icon={<Pencil size={14} />}
                      label={common('edit')}
                      onClick={() =>
                        setForm({
                          entity_id: r.entity_id,
                          part_number: r.part_number ?? '',
                          description: r.description ?? '',
                          manufacturer: r.manufacturer ?? '',
                          unit_cost: r.unit_cost,
                          unit_price: r.unit_price,
                          quantity_in_stock: r.quantity_in_stock,
                          min_stock: r.min_stock,
                          reorder_point: r.reorder_point,
                          location: r.location ?? '',
                          status: (r.status as 'ativo' | 'inativo') ?? 'ativo',
                        })
                      }
                    />
                    <RowActionButton
                      tone="danger"
                      icon={<Trash2 size={14} />}
                      label={common('inactivate')}
                      onClick={() => remove(r)}
                    />
                  </RowActions>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('noParts')}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
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

function PartForm({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
  t,
  common,
}: {
  form: FormState
  saving: boolean
  onChange: (f: FormState) => void
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
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        {form.entity_id ? t('editPart') : t('newPart')}
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">
          {t('partNumber')}
          <input
            className={inputCls}
            value={form.part_number}
            onChange={(e) => set('part_number', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('description')}
          <input
            className={inputCls}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('manufacturer')}
          <input
            className={inputCls}
            value={form.manufacturer ?? ''}
            onChange={(e) => set('manufacturer', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('unitCostBRL')}
          <input
            type="number"
            className={inputCls}
            value={form.unit_cost ?? ''}
            onChange={(e) => set('unit_cost', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('unitPriceBRL')}
          <input
            type="number"
            className={inputCls}
            value={form.unit_price ?? ''}
            onChange={(e) => set('unit_price', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('stockQty')}
          <input
            type="number"
            className={inputCls}
            value={form.quantity_in_stock ?? ''}
            onChange={(e) => set('quantity_in_stock', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('minStock')}
          <input
            type="number"
            className={inputCls}
            value={form.min_stock ?? ''}
            onChange={(e) => set('min_stock', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('reorderPoint')}
          <input
            type="number"
            className={inputCls}
            value={form.reorder_point ?? ''}
            onChange={(e) => set('reorder_point', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('location')}
          <input
            className={inputCls}
            value={form.location ?? ''}
            onChange={(e) => set('location', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {common('status')}
          <select
            className={inputCls}
            value={form.status ?? 'ativo'}
            onChange={(e) => set('status', e.target.value as 'ativo' | 'inativo')}
          >
            <option value="ativo">{common('active')}</option>
            <option value="inativo">{common('inactive')}</option>
          </select>
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
          {saving ? common('saving') : common('save')}
        </button>
      </div>
    </div>
  )
}
