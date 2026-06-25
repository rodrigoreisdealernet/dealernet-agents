// Users Admin — gestão de usuários/perfis (issue #6).
// Lista profiles (RLS: admin vê todos), permite criar (Edge Function), editar
// nome/role e inativar/reativar (RPC admin_update_profile). Toda escrita é só
// para admin: a UI esconde os controles para não-admins (RLS/RPC reforçam no DB).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  getProfiles,
  getMyRole,
  createUser,
  updateProfile,
  type ProfileRow,
  type AppRole,
  type CreateUserInput,
} from '@/portal/lib/agentsApi'
import { Badge, ScreenShell, RowActions, RowActionButton, type Tone } from './ui'
import { Pencil, Power, PowerOff } from 'lucide-react'

const ROLES: AppRole[] = ['admin', 'branch_manager', 'field_operator', 'read_only']

type CreateForm = CreateUserInput
type EditForm = { id: string; display_name: string; role: AppRole | string; is_active: boolean }

const EMPTY_CREATE: CreateForm = {
  email: '',
  password: '',
  display_name: '',
  role: 'read_only',
  tenant: '',
}

function roleTone(r: string): Tone {
  if (r === 'admin') return 'danger'
  if (r === 'branch_manager') return 'info'
  if (r === 'field_operator') return 'warning'
  return 'neutral'
}

export default function UsersAdmin() {
  const t = useTranslations('screens.usersAdmin')
  const common = useTranslations('common')
  const [rows, setRows] = useState<ProfileRow[]>([])
  const [role, setRole] = useState<string>('read_only')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [createForm, setCreateForm] = useState<CreateForm | null>(null)
  const [editForm, setEditForm] = useState<EditForm | null>(null)
  const [saving, setSaving] = useState(false)

  const isAdmin = role === 'admin'

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([getProfiles(), getMyRole()])
      .then(([r, myRole]) => {
        setRows(r)
        setRole(myRole)
        setError(null)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const counts = useMemo(() => {
    const total = rows.length
    const ativos = rows.filter((r) => r.is_active).length
    return { total, ativos, inativos: total - ativos }
  }, [rows])

  const submitCreate = async () => {
    if (!createForm) return
    if (!createForm.email.trim() || !createForm.password) {
      setError(t('emailPasswordRequired'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await createUser({
        email: createForm.email.trim(),
        password: createForm.password,
        display_name: createForm.display_name.trim() || createForm.email.trim(),
        role: createForm.role,
        tenant: createForm.tenant?.trim() || undefined,
      })
      setCreateForm(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const submitEdit = async () => {
    if (!editForm) return
    setSaving(true)
    setError(null)
    try {
      await updateProfile(editForm.id, {
        display_name: editForm.display_name.trim() || null,
        role: editForm.role,
        is_active: editForm.is_active,
      })
      setEditForm(null)
      load()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  // Toggle is_active preservando nome/role atuais (RPC exige todos os campos).
  const toggleActive = async (row: ProfileRow) => {
    const next = !row.is_active
    if (!window.confirm(`${next ? common('reactivate') : common('inactivate')} ${row.display_name ?? row.id}?`)) return
    setError(null)
    try {
      await updateProfile(row.id, {
        display_name: row.display_name,
        role: row.role,
        is_active: next,
      })
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

      {!isAdmin && !loading && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('readOnlyNotice')}
        </p>
      )}

      <div className="grid grid-cols-3 gap-4">
        <Stat label={common('total')} value={counts.total} />
        <Stat label={common('activePlural')} value={counts.ativos} />
        <Stat label={common('inactivePlural')} value={counts.inativos} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setCreateForm({ ...EMPTY_CREATE })}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('newUser')}
          </button>
        )}
      </div>

      {isAdmin && createForm && (
        <CreateUserForm
          form={createForm}
          saving={saving}
          onChange={setCreateForm}
          onCancel={() => setCreateForm(null)}
          onSubmit={submitCreate}
          t={t}
          common={common}
          roleLabel={roleLabel}
        />
      )}

      {isAdmin && editForm && (
        <EditUserForm
          form={editForm}
          saving={saving}
          onChange={setEditForm}
          onCancel={() => setEditForm(null)}
          onSubmit={submitEdit}
          t={t}
          common={common}
          roleLabel={roleLabel}
        />
      )}

      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">{common('name')}</th>
              <th className="px-3 py-2">{t('role')}</th>
              <th className="px-3 py-2">{t('tenant')}</th>
              <th className="px-3 py-2">{common('active')}</th>
              {isAdmin && <th className="px-3 py-2 text-right">{common('actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.display_name ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">{r.id}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={roleTone(r.role)}>{roleLabel(r.role)}</Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{r.tenant}</td>
                <td className="px-3 py-2">
                  <Badge tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? common('active') : common('inactive')}</Badge>
                </td>
                {isAdmin && (
                  <td className="px-3 py-2 text-right">
                    <RowActions>
                      <RowActionButton
                        icon={<Pencil size={14} />}
                        label={common('edit')}
                        onClick={() =>
                          setEditForm({
                            id: r.id,
                            display_name: r.display_name ?? '',
                            role: r.role,
                            is_active: r.is_active,
                          })
                        }
                      />
                      <RowActionButton
                        tone={r.is_active ? 'danger' : 'default'}
                        icon={r.is_active ? <PowerOff size={14} /> : <Power size={14} />}
                        label={r.is_active ? common('inactivate') : common('reactivate')}
                        onClick={() => toggleActive(r)}
                      />
                    </RowActions>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('noUsers')}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="px-3 py-6 text-center text-sm text-muted-foreground">
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary'

function CreateUserForm({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
  t,
  common,
  roleLabel,
}: {
  form: CreateForm
  saving: boolean
  onChange: (f: CreateForm) => void
  onCancel: () => void
  onSubmit: () => void
  t: (key: string) => string
  common: (key: string) => string
  roleLabel: (role: string) => string
}) {
  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) => onChange({ ...form, [k]: v })
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('newUser')}</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">
          E-mail
          <input
            type="email"
            className={inputCls}
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('password')}
          <input
            type="password"
            className={inputCls}
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          {common('name')}
          <input
            className={inputCls}
            value={form.display_name}
            onChange={(e) => set('display_name', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Role
          <select className={inputCls} value={form.role} onChange={(e) => set('role', e.target.value as AppRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          {t('tenantOptional')}
          <input
            className={inputCls}
            value={form.tenant ?? ''}
            onChange={(e) => set('tenant', e.target.value)}
            placeholder={t('inheritsAdmin')}
          />
        </label>
      </div>
      <FormActions saving={saving} onCancel={onCancel} onSubmit={onSubmit} common={common} />
    </div>
  )
}

function EditUserForm({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
  t,
  common,
  roleLabel,
}: {
  form: EditForm
  saving: boolean
  onChange: (f: EditForm) => void
  onCancel: () => void
  onSubmit: () => void
  t: (key: string) => string
  common: (key: string) => string
  roleLabel: (role: string) => string
}) {
  const set = <K extends keyof EditForm>(k: K, v: EditForm[K]) => onChange({ ...form, [k]: v })
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('editUser')}</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">
          {common('name')}
          <input
            className={inputCls}
            value={form.display_name}
            onChange={(e) => set('display_name', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Role
          <select className={inputCls} value={form.role} onChange={(e) => set('role', e.target.value as AppRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => set('is_active', e.target.checked)}
          />
          {common('active')}
        </label>
      </div>
      <FormActions saving={saving} onCancel={onCancel} onSubmit={onSubmit} common={common} />
    </div>
  )
}

function FormActions({
  saving,
  onCancel,
  onSubmit,
  common,
}: {
  saving: boolean
  onCancel: () => void
  onSubmit: () => void
  common: (key: string) => string
}) {
  return (
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
  )
}
  const roleLabel = (appRole: string) => {
    const labels: Record<string, string> = {
      admin: t('roleAdmin'),
      branch_manager: t('roleManager'),
      field_operator: t('roleOperator'),
      read_only: t('roleReadOnly'),
    }
    return labels[appRole] ?? appRole
  }
