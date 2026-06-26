// Tela de login do Portal (POC com mock; quando o API_Portal_Auth existir,
// o use-auth troca o mock pela chamada REST — esta tela não muda).
// Autocontida (sem depender de components/ui/*), no visual da marca.
// - Sem campo Empresa: o usuário entra na empresa default (Usuario_EmpresaCodDefault);
//   a troca de empresa fica no header, após logar.
// - Seletor de cor (accent) + claro/escuro disponíveis já no login.
// - "Esqueci minha senha": fluxo placeholder (backend de recuperação ainda não existe).

import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useTranslations } from 'use-intl'
import {
  AlertCircle, ArrowBigUp, ArrowLeft, Check, Eye, EyeOff, Loader2, Lock, Moon, Palette, Sun, User,
} from 'lucide-react'
import { useAuth, AuthError } from '@/hooks/use-auth'
import { useTheme, ACCENTS } from '@/hooks/use-theme'
import { locales } from '@/i18n/locale'
import { useLocale } from '@/i18n/LocaleProvider'

export function Login() {
  const [recovering, setRecovering] = useState(false)
  const t = useTranslations('shell.login')

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      {/* Fundo decorativo na cor da marca */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-[28rem] w-[28rem] rounded-full bg-primary/10 blur-3xl" />
      </div>

      {/* Controles de tema no topo (cor + claro/escuro) */}
      <ThemeControls />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 220, damping: 24 }}
        className="relative w-full max-w-md"
      >
        <div className="rounded-xl border bg-card p-6 shadow-xl">
          {/* Logo dentro do card, acima do formulário (cápsula clara). */}
          <div className="mb-6 flex justify-center">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.1 }}
              className="flex items-center justify-center rounded-2xl bg-white p-2 shadow-md ring-1 ring-black/5"
            >
              <img
                src="/Dealernet_Logo35anos.png"
                alt="Dealernet — 35 anos"
                className="h-20 w-auto max-w-full sm:h-24"
              />
            </motion.div>
          </div>

          {recovering && (
            <p className="mb-4 text-center text-sm text-muted-foreground">
              {t('recoverHint')}
            </p>
          )}

          <AnimatePresence mode="wait">
            {recovering ? (
              <RecoverForm key="recover" onBack={() => setRecovering(false)} />
            ) : (
              <LoginForm key="login" onForgot={() => setRecovering(true)} />
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}

// --- Formulário de login -----------------------------------------------------

function LoginForm({ onForgot }: { onForgot: () => void }) {
  const t = useTranslations('shell.login')
  const { login } = useAuth()
  const [usuario, setUsuario] = useState('')
  const [senha, setSenha] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [capsLock, setCapsLock] = useState(false)

  // Detecta Caps Lock a partir dos eventos de teclado no campo de senha.
  const checkCaps = (e: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState('CapsLock'))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      // Identificador normalizado em MAIÚSCULAS (padrão dos usuários Dealernet).
      await login({ usuario: usuario.trim().toUpperCase(), senha })
    } catch (err) {
      setError(err instanceof AuthError ? err.message : t('connectError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <motion.form
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onSubmit={handleSubmit}
      className="space-y-4"
      noValidate
    >
      <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        {t('pocMode')}
      </div>

      <Field label={t('user')} htmlFor="usuario" icon={<User size={16} />}>
        <input
          id="usuario"
          autoComplete="username"
          placeholder="SEU.LOGIN"
          className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm uppercase outline-none focus:ring-2 focus:ring-ring"
          value={usuario}
          onChange={(e) => setUsuario(e.target.value.toUpperCase())}
          required
          disabled={loading}
          autoFocus
        />
      </Field>

      <Field label={t('password')} htmlFor="senha" icon={<Lock size={16} />}>
        <input
          id="senha"
          type={showPwd ? 'text' : 'password'}
          autoComplete="current-password"
          placeholder="••••••••"
          className="w-full rounded-md border bg-background py-2 px-9 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          onKeyUp={checkCaps}
          onKeyDown={checkCaps}
          onBlur={() => setCapsLock(false)}
          required
          disabled={loading}
        />
        <button
          type="button"
          onClick={() => setShowPwd((v) => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={showPwd ? t('hidePassword') : t('showPassword')}
          tabIndex={-1}
        >
          {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </Field>

      {capsLock && (
        <div className="-mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <ArrowBigUp size={14} />
          <span>{t('capsLock')}</span>
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onForgot}
          className="text-xs font-medium text-primary hover:underline"
        >
          {t('forgotPassword')}
        </button>
      </div>

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-start gap-2 overflow-hidden rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 shrink-0" size={16} />
            <span>{error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="submit"
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {loading ? (
          <>
            <Loader2 className="animate-spin" size={16} /> {t('signingIn')}
          </>
        ) : (
          t('signIn')
        )}
      </button>
    </motion.form>
  )
}

// --- Formulário de recuperação de senha (placeholder) ------------------------

function RecoverForm({ onBack }: { onBack: () => void }) {
  const t = useTranslations('shell.login')
  const [usuario, setUsuario] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    // Placeholder: o backend de recuperação ainda não existe na DHI.
    // Quando existir (ex.: POST /identity/recuperar-senha), chamar aqui.
    await new Promise((r) => setTimeout(r, 600))
    setLoading(false)
    setSent(true)
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      {sent ? (
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Check size={22} />
          </div>
          <p className="text-sm text-muted-foreground">
            {t('recoverSent')}
          </p>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <ArrowLeft size={15} /> {t('backToLogin')}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <Field label={t('user')} htmlFor="rec-usuario" icon={<User size={16} />}>
            <input
              id="rec-usuario"
              autoComplete="username"
              placeholder="seu.login"
              className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              required
              disabled={loading}
              autoFocus
            />
          </Field>

          <button
            type="submit"
            disabled={loading || !usuario.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="animate-spin" size={16} /> {t('sending')}
              </>
            ) : (
              t('recoverPassword')
            )}
          </button>

          <button
            type="button"
            onClick={onBack}
            className="flex w-full items-center justify-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={15} /> {t('backToLogin')}
          </button>
        </form>
      )}
    </motion.div>
  )
}

// --- Controles de tema (cor + claro/escuro) no canto superior direito --------

function ThemeControls() {
  const t = useTranslations('shell')
  const tLocale = useTranslations('locale')
  const { theme, toggleTheme, accent, setAccent } = useTheme()
  const { locale, setLocale } = useLocale()
  return (
    <div className="absolute right-4 top-4 flex items-center gap-1">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          title={t('themeColor')}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary"
        >
          <Palette size={18} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-[9999] w-44 rounded-lg border bg-card p-1 text-card-foreground shadow-xl"
          >
            <DropdownMenu.Label className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
              {t('portalColor')}
            </DropdownMenu.Label>
            {ACCENTS.map((a) => (
              <DropdownMenu.Item
                key={a.id}
                onSelect={() => setAccent(a.id)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
              >
                <span
                  className="h-4 w-4 shrink-0 rounded-full ring-1 ring-black/10"
                  style={{ backgroundColor: `hsl(${a.swatch})` }}
                />
                <span className="flex-1">{a.label}</span>
                {accent === a.id && <Check size={14} className="text-primary" />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          title={t('language')}
          className="flex h-9 items-center gap-1.5 rounded-md px-2 text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary"
        >
          {locale}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-[9999] min-w-44 rounded-lg border bg-card p-1 text-card-foreground shadow-xl"
          >
            {locales.map((option) => (
              <DropdownMenu.Item
                key={option}
                onSelect={() => setLocale(option)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
              >
                <span className="flex-1">{tLocale(option)}</span>
                {locale === option && <Check size={14} className="text-primary" />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <button
        type="button"
        title={t('toggleTheme')}
        onClick={toggleTheme}
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
    </div>
  )
}

// --- helper de campo ---------------------------------------------------------

function Field({
  label,
  htmlFor,
  icon,
  children,
}: {
  label: React.ReactNode
  htmlFor: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          {icon}
        </span>
        {children}
      </div>
    </div>
  )
}
