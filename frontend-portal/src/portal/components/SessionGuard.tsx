// Guarda de sessão: timeout por inatividade configurável (config.tempoSessao).
// - Reseta a contagem em qualquer atividade do usuário.
// - Avisa aos ~20% finais com opção "Continuar conectado".
// - Ao expirar: mostra a tela "Sessão expirada"; "Entrar novamente" faz logout
//   (limpa a sessão) e o App volta sozinho para o Login.

import { useState, useEffect } from 'react'
import { Clock, LogOut } from 'lucide-react'
import { usePortalStore } from '@/portal/store/portalStore'
import { useAuth } from '@/hooks/use-auth'
import { useIdleTimeout, formatRemaining } from '@/hooks/use-idle-timeout'
import { SESSION_EXPIRED_EVENT } from '@/portal/lib/sessionEvents'

export function SessionGuard() {
  const config = usePortalStore((s) => s.config)
  const { logout } = useAuth()
  const [warnOpen, setWarnOpen] = useState(false)
  const [expired, setExpired] = useState(false)
  // Motivo da expiração: inatividade (timer) ou sessão do backend caída (API 401).
  const [motivo, setMotivo] = useState<string>('')

  const minutes = config?.tempoSessao ?? 10

  // Sessão do BACKEND inválida (detectada por uma chamada de API) → mesma tela de
  // expiração, com aviso e logout. Cobre o caso "Não foi possível gerar a sessão".
  useEffect(() => {
    const onExpired = (e: Event) => {
      const det = (e as CustomEvent).detail as { motivo?: string } | undefined
      setMotivo(det?.motivo || 'Sua sessão foi encerrada.')
      setWarnOpen(false)
      setExpired(true)
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [])

  const { remaining, reset } = useIdleTimeout({
    minutes,
    warnAt: 0.2,
    // POC: timeout de inatividade DESATIVADO para não derrubar a sessão durante a demo.
    enabled: false,
    onWarn: () => setWarnOpen(true),
    onExpire: () => {
      setWarnOpen(false)
      setMotivo(`Sua sessão foi encerrada por inatividade (${minutes} min).`)
      setExpired(true)
      // No real: window.location.href = config.endpoints.logout
    },
  })

  const continuar = () => {
    setWarnOpen(false)
    reset()
  }

  if (expired) {
    return (
      <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-background/95 backdrop-blur">
        <div className="flex max-w-sm flex-col items-center gap-4 rounded-xl border bg-card p-8 text-center shadow-2xl">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <LogOut className="text-muted-foreground" size={26} />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Sessão expirada</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {motivo || `Sua sessão foi encerrada por inatividade (${minutes} min).`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              // Encerra a sessão (limpa auth + chama logout do backend) e
              // volta ao Login — não recarrega a app ainda autenticada.
              void logout()
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Entrar novamente
          </button>
        </div>
      </div>
    )
  }

  if (!warnOpen) return null

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40">
      <div className="flex w-[360px] max-w-[90vw] flex-col gap-4 rounded-xl border bg-card p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Clock className="text-amber-500" size={20} />
          </div>
          <div>
            <h2 className="font-semibold">Sua sessão vai expirar</h2>
            <p className="text-sm text-muted-foreground">
              Por inatividade, em <span className="font-mono font-medium">{formatRemaining(remaining)}</span>.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setWarnOpen(false)
              setExpired(true)
            }}
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-secondary"
          >
            Sair agora
          </button>
          <button
            type="button"
            onClick={continuar}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Continuar conectado
          </button>
        </div>
      </div>
    </div>
  )
}
