// Vehicles Inventory — primeira entidade do domínio concessionária (issue #4).
// Lista veículos correntes de v_dia_vehicle_current e permite criar/editar/remover
// via as RPCs endurecidas create_vehicle / update_vehicle / delete_vehicle.
// Leitura direta (RLS authenticated); escrita só pela RPC (admin/branch_manager).
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  type VehicleRow,
  type VehicleInput,
} from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell, RowActions, RowActionButton, type Tone } from './ui'
import { Pencil, Trash2 } from 'lucide-react'
import { formatBRL, formatBRLKpi } from './format'

type FormState = VehicleInput & { entity_id?: string }

const EMPTY_FORM: FormState = {
  condition: 'novo',
  brand: '',
  model: '',
  model_year: new Date().getFullYear(),
  cost: null,
  sale_price: null,
  purchase_date: '',
  status: 'em_estoque',
  store: '',
}

function statusTone(s: string | null | undefined): Tone {
  return (s ?? '').toLowerCase() === 'vendido' ? 'success' : 'info'
}

function num(v: string): number | null {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) ? null : n
}

export default function VehiclesInventory() {
  const [rows, setRows] = useState<VehicleRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getVehicles()
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
    const novos = rows.filter((r) => r.condition === 'novo').length
    const usados = rows.filter((r) => r.condition === 'usado').length
    const floorPlan = rows.reduce((s, r) => s + (r.floor_plan_cost ?? 0), 0)
    return { total, novos, usados, floorPlan }
  }, [rows])

  const submit = async () => {
    if (!form) return
    if (!form.brand.trim() || !form.model.trim()) {
      setError('Marca e modelo são obrigatórios.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: VehicleInput = {
        condition: form.condition,
        brand: form.brand.trim(),
        model: form.model.trim(),
        model_year: form.model_year ?? null,
        cost: form.cost ?? null,
        sale_price: form.sale_price ?? null,
        purchase_date: form.purchase_date || null,
        status: form.status ?? 'em_estoque',
        store: form.store?.trim() || null,
      }
      if (form.entity_id) await updateVehicle(form.entity_id, payload)
      else await createVehicle(payload)
      setForm(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: VehicleRow) => {
    if (!window.confirm(`Remover (baixar) ${row.name ?? row.brand}? O histórico é preservado.`)) return
    setError(null)
    try {
      await deleteVehicle(row.entity_id)
      load()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <ScreenShell
      title="Estoque de Veículos"
      subtitle="Inventário de veículos novos e usados — custo de floor plan calculado pela idade em estoque."
      legend="Valores em R$"
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Total" value={kpis.total} />
        <KpiCard label="Novos" value={kpis.novos} />
        <KpiCard label="Usados" value={kpis.usados} />
        <KpiCard label="Floor plan acum." value={formatBRLKpi(kpis.floorPlan)} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Veículos correntes</h2>
        <button
          type="button"
          onClick={() => setForm({ ...EMPTY_FORM })}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Novo veículo
        </button>
      </div>

      {form && (
        <VehicleForm
          form={form}
          saving={saving}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onSubmit={submit}
        />
      )}

      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">Veículo</th>
              <th className="px-3 py-2">Condição</th>
              <th className="px-3 py-2 text-right">Preço</th>
              <th className="px-3 py-2 text-right">Dias estoque</th>
              <th className="px-3 py-2 text-right">Floor plan</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entity_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.name ?? `${r.brand} ${r.model}`}</div>
                  <div className="text-xs text-muted-foreground">{r.store ?? '—'}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={r.condition === 'novo' ? 'info' : 'neutral'}>{r.condition}</Badge>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.sale_price)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.days_in_stock ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.floor_plan_cost)}</td>
                <td className="px-3 py-2">
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <RowActions>
                    <RowActionButton
                      icon={<Pencil size={14} />}
                      label="Editar"
                      onClick={() =>
                        setForm({
                          entity_id: r.entity_id,
                          condition: (r.condition as 'novo' | 'usado') ?? 'novo',
                          brand: r.brand ?? '',
                          model: r.model ?? '',
                          model_year: r.model_year,
                          cost: r.cost,
                          sale_price: r.sale_price,
                          purchase_date: r.purchase_date ?? '',
                          status: (r.status as 'em_estoque' | 'vendido') ?? 'em_estoque',
                          store: r.store ?? '',
                        })
                      }
                    />
                    <RowActionButton
                      tone="danger"
                      icon={<Trash2 size={14} />}
                      label="Remover"
                      onClick={() => remove(r)}
                    />
                  </RowActions>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nenhum veículo no estoque.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Carregando…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ScreenShell>
  )
}

function VehicleForm({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: FormState
  saving: boolean
  onChange: (f: FormState) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => onChange({ ...form, [k]: v })
  const inputCls =
    'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary'

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        {form.entity_id ? 'Editar veículo' : 'Novo veículo'}
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">
          Condição
          <select
            className={inputCls}
            value={form.condition}
            onChange={(e) => set('condition', e.target.value as 'novo' | 'usado')}
          >
            <option value="novo">novo</option>
            <option value="usado">usado</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Marca
          <input className={inputCls} value={form.brand} onChange={(e) => set('brand', e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          Modelo
          <input className={inputCls} value={form.model} onChange={(e) => set('model', e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          Ano
          <input
            type="number"
            className={inputCls}
            value={form.model_year ?? ''}
            onChange={(e) => set('model_year', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Custo (R$)
          <input
            type="number"
            className={inputCls}
            value={form.cost ?? ''}
            onChange={(e) => set('cost', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Preço de venda (R$)
          <input
            type="number"
            className={inputCls}
            value={form.sale_price ?? ''}
            onChange={(e) => set('sale_price', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Data de compra
          <input
            type="date"
            className={inputCls}
            value={form.purchase_date ?? ''}
            onChange={(e) => set('purchase_date', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Status
          <select
            className={inputCls}
            value={form.status ?? 'em_estoque'}
            onChange={(e) => set('status', e.target.value as 'em_estoque' | 'vendido')}
          >
            <option value="em_estoque">em_estoque</option>
            <option value="vendido">vendido</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Loja
          <input className={inputCls} value={form.store ?? ''} onChange={(e) => set('store', e.target.value)} />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </div>
  )
}
