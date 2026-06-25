// Users Admin — gestão de usuários/perfis (issue #6).
// Lista profiles (RLS: admin vê todos), permite criar (Edge Function), editar
// nome/role e inativar/reativar (RPC admin_update_profile). Toda escrita é só
// para admin: a UI esconde os controles para não-admins (RLS/RPC reforçam no DB).
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getProfiles,
  getMyRole,
  createUser,
  updateProfile,
  type ProfileRow,
  type AppRole,
  type CreateUserInput,
} from '@/portal/lib/agentsApi'
import { Badge, ScreenShell, type Tone } from './ui'

const ROLES: AppRole[] = ['admin', 'branch_manager', 'field_operator', 'read_only']

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador',
  branch_manager: 'Gerente',
  field_operator: 'Operador',
  read_only: 'Somente leitura',
}

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
      setError('E-mail e senha são obrigatórios.')
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
    if (!window.confirm(`${next ? 'Reativar' : 'Inativar'} ${row.display_name ?? row.id}?`)) return
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
      title="Usuários"
      subtitle="Gestão de usuários e perfis (papel + ativação). Criação e edição restritas a administradores."
    >
      {error && <p className="text-sm text-destructive">Erro: {error}</p>}

      {!isAdmin && !loading && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Você está em modo somente leitura. Apenas administradores podem criar, editar ou inativar usuários.
        </p>
      )}

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Total" value={counts.total} />
        <Stat label="Ativos" value={counts.ativos} />
        <Stat label="Inativos" value={counts.inativos} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Usuários</h2>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setCreateForm({ ...EMPTY_CREATE })}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Novo usuário
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
        />
      )}

      {isAdmin && editForm && (
        <EditUserForm
          form={editForm}
          saving={saving}
          onChange={setEditForm}
          onCancel={() => setEditForm(null)}
          onSubmit={submitEdit}
        />
      )}

      <div className="overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2">Nome</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2">Ativo</th>
              {isAdmin && <th className="px-3 py-2 text-right">Ações</th>}
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
                  <Badge tone={roleTone(r.role)}>{ROLE_LABEL[r.role] ?? r.role}</Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{r.tenant}</td>
                <td className="px-3 py-2">
                  <Badge tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'Ativo' : 'Inativo'}</Badge>
                </td>
                {isAdmin && (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        setEditForm({
                          id: r.id,
                          display_name: r.display_name ?? '',
                          role: r.role,
                          is_active: r.is_active,
                        })
                      }
                      className="mr-2 text-xs font-medium text-primary hover:underline"
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleActive(r)}
                      className="text-xs font-medium text-destructive hover:underline"
                    >
                      {r.is_active ? 'Inativar' : 'Reativar'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nenhum usuário visível.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="px-3 py-6 text-center text-sm text-muted-foreground">
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
}: {
  form: CreateForm
  saving: boolean
  onChange: (f: CreateForm) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) => onChange({ ...form, [k]: v })
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">Novo usuário</h3>
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
          Senha
          <input
            type="password"
            className={inputCls}
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Nome
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
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Tenant (opcional)
          <input
            className={inputCls}
            value={form.tenant ?? ''}
            onChange={(e) => set('tenant', e.target.value)}
            placeholder="herda do admin"
          />
        </label>
      </div>
      <FormActions saving={saving} onCancel={onCancel} onSubmit={onSubmit} />
    </div>
  )
}

function EditUserForm({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: EditForm
  saving: boolean
  onChange: (f: EditForm) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const set = <K extends keyof EditForm>(k: K, v: EditForm[K]) => onChange({ ...form, [k]: v })
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">Editar usuário</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">
          Nome
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
                {ROLE_LABEL[r]}
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
          Ativo
        </label>
      </div>
      <FormActions saving={saving} onCancel={onCancel} onSubmit={onSubmit} />
    </div>
  )
}

function FormActions({
  saving,
  onCancel,
  onSubmit,
}: {
  saving: boolean
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
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
  )
}
