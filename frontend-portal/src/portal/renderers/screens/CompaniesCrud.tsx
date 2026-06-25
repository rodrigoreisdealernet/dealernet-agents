// Companies CRUD — entidade mestre do domínio concessionária (issue #5).
// Lista empresas correntes de v_dia_company_current e permite criar/editar/inativar
// via as RPCs endurecidas create_company / update_company / delete_company.
// Leitura direta (RLS authenticated); escrita só pela RPC (admin/branch_manager).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  getCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  getBrands,
  type CompanyRow,
  type CompanyInput,
  type BrandRow,
} from '@/portal/lib/agentsApi'
import { KpiCard, Badge, ScreenShell, RowActions, RowActionButton, type Tone } from './ui'
import { Pencil, Trash2 } from 'lucide-react'

type FormState = CompanyInput & { entity_id?: string }

const EMPTY_FORM: FormState = {
  legal_name: '',
  trade_name: '',
  cnpj: '',
  city: '',
  state: '',
  status: 'ativo',
  brand_id: '',
}

function statusTone(s: string | null | undefined): Tone {
  return (s ?? '').toLowerCase() === 'inativo' ? 'neutral' : 'success'
}

export default function CompaniesCrud() {
  const t = useTranslations('screens.companiesCrud')
  const common = useTranslations('common')
  const [rows, setRows] = useState<CompanyRow[]>([])
  const [brands, setBrands] = useState<BrandRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([getCompanies(), getBrands()])
      .then(([r, b]) => {
        setRows(r)
        setBrands(b)
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
    const ativos = rows.filter((r) => r.status === 'ativo').length
    const estados = new Set(rows.map((r) => r.state).filter(Boolean)).size
    return { total, ativos, estados }
  }, [rows])

  const submit = async () => {
    if (!form) return
    if (!form.legal_name.trim() || !form.cnpj.trim()) {
      setError(t('legalNameCnpjRequired'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: CompanyInput = {
        legal_name: form.legal_name.trim(),
        trade_name: form.trade_name?.trim() || null,
        cnpj: form.cnpj.trim(),
        city: form.city?.trim() || null,
        state: form.state?.trim() || null,
        status: form.status ?? 'ativo',
        brand_id: form.brand_id || null,
      }
      if (form.entity_id) await updateCompany(form.entity_id, payload)
      else await createCompany(payload)
      setForm(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: CompanyRow) => {
    if (!window.confirm(t('inactivateConfirm').replace('{name}', row.name ?? row.legal_name ?? '—'))) return
    setError(null)
    try {
      await deleteCompany(row.entity_id)
      load()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <ScreenShell
      title={t('title')}
      subtitle={t('subtitle')}
    >
      {error && <p className="text-sm text-destructive">{common('error')}: {error}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <KpiCard label={common('total')} value={kpis.total} />
        <KpiCard label={t('activeCompanies')} value={kpis.ativos} />
        <KpiCard label={t('states')} value={kpis.estados} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('currentCompanies')}</h2>
        <button
          type="button"
          onClick={() => setForm({ ...EMPTY_FORM })}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('newCompany')}
        </button>
      </div>

      {form && (
        <CompanyForm
          form={form}
          brands={brands}
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
              <th className="px-3 py-2">{t('company')}</th>
              <th className="px-3 py-2">{t('cnpj')}</th>
              <th className="px-3 py-2">{t('cityState')}</th>
              <th className="px-3 py-2">{t('brand')}</th>
              <th className="px-3 py-2">{common('status')}</th>
              <th className="px-3 py-2 text-right">{common('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.entity_id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.trade_name ?? r.name ?? r.legal_name}</div>
                  <div className="text-xs text-muted-foreground">{r.legal_name ?? '—'}</div>
                </td>
                <td className="px-3 py-2 tabular-nums">{r.cnpj ?? '—'}</td>
                <td className="px-3 py-2">{[r.city, r.state].filter(Boolean).join(' / ') || '—'}</td>
                <td className="px-3 py-2">{r.brand_name ?? '—'}</td>
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
                          legal_name: r.legal_name ?? '',
                          trade_name: r.trade_name ?? '',
                          cnpj: r.cnpj ?? '',
                          city: r.city ?? '',
                          state: r.state ?? '',
                          status: (r.status as 'ativo' | 'inativo') ?? 'ativo',
                          brand_id: r.brand_id ?? '',
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
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('noCompanies')}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
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

function CompanyForm({
  form,
  brands,
  saving,
  onChange,
  onCancel,
  onSubmit,
  t,
  common,
}: {
  form: FormState
  brands: BrandRow[]
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
        {form.entity_id ? t('editCompany') : t('newCompany')}
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">
          {t('legalName')}
          <input className={inputCls} value={form.legal_name} onChange={(e) => set('legal_name', e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('tradeName')}
          <input className={inputCls} value={form.trade_name ?? ''} onChange={(e) => set('trade_name', e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          CNPJ
          <input className={inputCls} value={form.cnpj} onChange={(e) => set('cnpj', e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('city')}
          <input className={inputCls} value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('stateUf')}
          <input className={inputCls} value={form.state ?? ''} onChange={(e) => set('state', e.target.value)} />
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
        <label className="text-xs text-muted-foreground">
          {t('brand')}
          <select
            className={inputCls}
            value={form.brand_id ?? ''}
            onChange={(e) => set('brand_id', e.target.value || null)}
          >
            <option value="">{t('noBrandOption')}</option>
            {brands.map((b) => (
              <option key={b.entity_id} value={b.entity_id}>
                {b.name ?? b.entity_id}
              </option>
            ))}
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
