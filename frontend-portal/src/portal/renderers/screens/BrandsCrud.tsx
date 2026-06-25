// Brands CRUD — entidade mestre do domínio concessionária (issue #5).
// Lista marcas correntes de v_dia_brand_current e permite criar/editar/inativar
// via as RPCs endurecidas create_brand / update_brand / delete_brand.
// Leitura direta (RLS authenticated); escrita só pela RPC (admin/branch_manager).
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getBrands,
  createBrand,
  updateBrand,
  deleteBrand,
  type BrandRow,
  type BrandInput,
} from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell, RowActions, RowActionButton, type Tone } from './ui'
import { Pencil, Trash2 } from 'lucide-react'

type FormState = BrandInput & { entity_id?: string }

const EMPTY_FORM: FormState = {
  name: '',
  segment: 'automoveis',
  status: 'ativo',
}

const SEGMENT_LABEL: Record<string, string> = {
  automoveis: 'Automóveis',
  caminhoes: 'Caminhões',
  motos: 'Motos',
}

function statusTone(s: string | null | undefined): Tone {
  return (s ?? '').toLowerCase() === 'inativo' ? 'neutral' : 'success'
}

export default function BrandsCrud() {
  const [rows, setRows] = useState<BrandRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getBrands()
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
    const ativas = rows.filter((r) => r.status === 'ativo').length
    const segmentos = new Set(rows.map((r) => r.segment).filter(Boolean)).size
    return { total, ativas, segmentos }
  }, [rows])

  const submit = async () => {
    if (!form) return
    if (!form.name.trim()) {
      setError('Nome é obrigatório.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: BrandInput = {
        name: form.name.trim(),
        segment: form.segment,
        status: form.status ?? 'ativo',
      }
      if (form.entity_id) await updateBrand(form.entity_id, payload)
      else await createBrand(payload)
      setForm(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: BrandRow) => {
    if (!window.confirm(`Inativar ${row.name}? O histórico é preservado.`)) return
    setError(null)
    try {
      await deleteBrand(row.entity_id)
      load()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <ScreenShell
      title="Marcas"
      subtitle="Cadastro de marcas — nome, segmento e situação."
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label="Total" value={kpis.total} />
        <KpiCard label="Ativas" value={kpis.ativas} />
        <KpiCard label="Segmentos" value={kpis.segmentos} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Marcas correntes</h2>
        <button
          type="button"
          onClick={() => setForm({ ...EMPTY_FORM })}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Nova marca
        </button>
      </div>

      {form && (
        <BrandForm
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
              <th className="px-3 py-2">Marca</th>
              <th className="px-3 py-2">Segmento</th>
              <th className="px-3 py-2">Situação</th>
              <th className="px-3 py-2 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entity_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.name}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge tone="info">{SEGMENT_LABEL[r.segment] ?? r.segment}</Badge>
                </td>
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
                          name: r.name ?? '',
                          segment: (r.segment as 'automoveis' | 'caminhoes' | 'motos') ?? 'automoveis',
                          status: (r.status as 'ativo' | 'inativo') ?? 'ativo',
                        })
                      }
                    />
                    <RowActionButton
                      tone="danger"
                      icon={<Trash2 size={14} />}
                      label="Inativar"
                      onClick={() => remove(r)}
                    />
                  </RowActions>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nenhuma marca cadastrada.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
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

function BrandForm({
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
        {form.entity_id ? 'Editar marca' : 'Nova marca'}
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">
          Nome
          <input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          Segmento
          <select
            className={inputCls}
            value={form.segment}
            onChange={(e) => set('segment', e.target.value as 'automoveis' | 'caminhoes' | 'motos')}
          >
            <option value="automoveis">Automóveis</option>
            <option value="caminhoes">Caminhões</option>
            <option value="motos">Motos</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Situação
          <select
            className={inputCls}
            value={form.status ?? 'ativo'}
            onChange={(e) => set('status', e.target.value as 'ativo' | 'inativo')}
          >
            <option value="ativo">ativo</option>
            <option value="inativo">inativo</option>
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
