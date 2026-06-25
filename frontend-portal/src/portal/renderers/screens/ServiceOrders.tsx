// Ordens de Serviço / Oficina — segunda entidade do domínio concessionária (issue #7).
// Lista OS correntes de v_dia_service_order_current e permite criar/editar/cancelar
// via as RPCs endurecidas create_service_order / update_service_order / delete_service_order.
// Leitura direta (RLS authenticated); escrita só pela RPC (admin/branch_manager).
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getServiceOrders,
  createServiceOrder,
  updateServiceOrder,
  deleteServiceOrder,
  type ServiceOrderRow,
  type ServiceOrderInput,
  type ServiceOrderStatus,
} from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell, RowActions, RowActionButton, type Tone } from './ui'
import { Pencil, XCircle } from 'lucide-react'
import { formatBRL, formatBRLKpi, formatDateTime } from './format'

type FormState = ServiceOrderInput & { entity_id?: string }

const STATUSES: ServiceOrderStatus[] = ['aberta', 'em_andamento', 'concluida', 'cancelada']

const EMPTY_FORM: FormState = {
  order_number: '',
  customer: '',
  vehicle: '',
  description: '',
  status: 'aberta',
  opened_at: '',
  closed_at: '',
  revenue: null,
  technician: '',
}

function statusTone(s: string | null | undefined): Tone {
  switch ((s ?? '').toLowerCase()) {
    case 'concluida':
      return 'success'
    case 'em_andamento':
      return 'info'
    case 'cancelada':
      return 'danger'
    default:
      return 'neutral'
  }
}

function num(v: string): number | null {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) ? null : n
}

export default function ServiceOrders() {
  const [rows, setRows] = useState<ServiceOrderRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getServiceOrders()
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
    const abertas = rows.filter((r) => r.status === 'aberta' || r.status === 'em_andamento').length
    const concluidas = rows.filter((r) => r.status === 'concluida').length
    const receita = rows.reduce((s, r) => s + (r.revenue ?? 0), 0)
    return { total, abertas, concluidas, receita }
  }, [rows])

  const submit = async () => {
    if (!form) return
    if (!form.customer.trim() || !form.description.trim()) {
      setError('Cliente e descrição são obrigatórios.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: ServiceOrderInput = {
        order_number: form.order_number?.trim() || null,
        customer: form.customer.trim(),
        vehicle: form.vehicle?.trim() || null,
        description: form.description.trim(),
        status: form.status ?? 'aberta',
        opened_at: form.opened_at || null,
        closed_at: form.closed_at || null,
        revenue: form.revenue ?? null,
        technician: form.technician?.trim() || null,
      }
      if (form.entity_id) await updateServiceOrder(form.entity_id, payload)
      else await createServiceOrder(payload)
      setForm(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: ServiceOrderRow) => {
    if (!window.confirm(`Cancelar a OS ${row.order_number ?? row.name ?? ''}? O histórico é preservado.`)) return
    setError(null)
    try {
      await deleteServiceOrder(row.entity_id)
      load()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <ScreenShell
      title="Ordens de Serviço"
      subtitle="Oficina — registre, acompanhe e finalize ordens de serviço; tempo de atendimento calculado para as concluídas."
      legend="Valores em R$"
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Total" value={kpis.total} />
        <KpiCard label="Em aberto" value={kpis.abertas} />
        <KpiCard label="Concluídas" value={kpis.concluidas} />
        <KpiCard label="Receita acum." value={formatBRLKpi(kpis.receita)} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Ordens correntes</h2>
        <button
          type="button"
          onClick={() => setForm({ ...EMPTY_FORM })}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Nova OS
        </button>
      </div>

      {form && (
        <ServiceOrderForm
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
              <th className="px-3 py-2">OS</th>
              <th className="px-3 py-2">Cliente / Veículo</th>
              <th className="px-3 py-2">Aberta em</th>
              <th className="px-3 py-2 text-right">Receita</th>
              <th className="px-3 py-2 text-right">Tempo (h)</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entity_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.order_number ?? r.name ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">{r.description ?? '—'}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.customer ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">{r.vehicle ?? '—'}</div>
                </td>
                <td className="px-3 py-2">{formatDateTime(r.opened_at)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.revenue)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.turnaround_hours ?? '—'}</td>
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
                          order_number: r.order_number ?? '',
                          customer: r.customer ?? '',
                          vehicle: r.vehicle ?? '',
                          description: r.description ?? '',
                          status: (r.status as ServiceOrderStatus) ?? 'aberta',
                          opened_at: r.opened_at ? r.opened_at.slice(0, 16) : '',
                          closed_at: r.closed_at ? r.closed_at.slice(0, 16) : '',
                          revenue: r.revenue,
                          technician: r.technician ?? '',
                        })
                      }
                    />
                    <RowActionButton
                      tone="danger"
                      icon={<XCircle size={14} />}
                      label="Cancelar"
                      onClick={() => remove(r)}
                    />
                  </RowActions>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nenhuma ordem de serviço.
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

function ServiceOrderForm({
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
        {form.entity_id ? 'Editar OS' : 'Nova OS'}
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">
          Número da OS
          <input
            className={inputCls}
            value={form.order_number ?? ''}
            onChange={(e) => set('order_number', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Cliente
          <input className={inputCls} value={form.customer} onChange={(e) => set('customer', e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          Veículo / Placa
          <input
            className={inputCls}
            value={form.vehicle ?? ''}
            onChange={(e) => set('vehicle', e.target.value)}
          />
        </label>
        <label className="col-span-2 text-xs text-muted-foreground md:col-span-3">
          Descrição
          <input
            className={inputCls}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Status
          <select
            className={inputCls}
            value={form.status ?? 'aberta'}
            onChange={(e) => set('status', e.target.value as ServiceOrderStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Aberta em
          <input
            type="datetime-local"
            className={inputCls}
            value={form.opened_at ?? ''}
            onChange={(e) => set('opened_at', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Fechada em
          <input
            type="datetime-local"
            className={inputCls}
            value={form.closed_at ?? ''}
            onChange={(e) => set('closed_at', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Receita (R$)
          <input
            type="number"
            className={inputCls}
            value={form.revenue ?? ''}
            onChange={(e) => set('revenue', num(e.target.value))}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Técnico
          <input
            className={inputCls}
            value={form.technician ?? ''}
            onChange={(e) => set('technician', e.target.value)}
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
