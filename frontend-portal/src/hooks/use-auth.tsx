import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { signInDemo, signOut as supabaseSignOut, hasSession } from '@/portal/lib/agentsApi'
import { resetSessionExpiredFlag } from '@/portal/lib/sessionEvents'
import type { LoginRequest } from '@/portal/types'

// A sessão real é um cookie HttpOnly (invisível ao JS) emitido pela DHI.
// Aqui guardamos só um flag de UI ("estou logado") + o identificador exibido,
// persistidos para sobreviver a um refresh. (Padrão do DealernetFrontEnd.)

const STORAGE_KEY = 'dealernet-portal-auth'

interface StoredSession {
  usuario: string
  nome: string
}

export class AuthError extends Error {}

interface AuthState {
  session: StoredSession | null
  isAuthenticated: boolean
  login: (payload: LoginRequest) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredSession) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(loadSession)

  // Boot resiliente (POC §4.4): se o flag de UI existe mas não há sessão Supabase
  // (expirou/limpou após refresh), reautentica o usuário demo silenciosamente —
  // senão as views RLS voltam vazias mesmo "logado".
  useEffect(() => {
    if (!session) return
    void (async () => {
      if (!(await hasSession())) {
        await signInDemo().catch(() => undefined)
      }
    })()
  }, [session])

  // POC: ignora as credenciais digitadas e autentica o usuário demo no Supabase
  // (gera um JWT real com role+tenant — necessário p/ as views RLS retornarem dados).
  const login = async (_payload: LoginRequest) => {
    const { data, error } = await signInDemo()
    if (error || !data.session) {
      throw new AuthError(
        'Falha ao iniciar a sessão de demonstração. Verifique se o Supabase local está no ar.',
      )
    }
    const email = data.user?.email ?? 'admin@dia-rental.dev'
    const next: StoredSession = { usuario: email, nome: email }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setSession(next)
    // Rearma o aviso de sessão expirada para futuras expirações desta nova sessão.
    resetSessionExpiredFlag()
  }

  const logout = async () => {
    try {
      await supabaseSignOut()
    } catch {
      // mesmo se o signOut falhar, limpamos o estado local
    }
    localStorage.removeItem(STORAGE_KEY)
    setSession(null)
  }

  return (
    <AuthContext.Provider value={{ session, isAuthenticated: !!session, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>')
  return ctx
}
