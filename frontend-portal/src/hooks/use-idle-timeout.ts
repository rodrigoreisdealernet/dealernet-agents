// Timeout de sessão por inatividade (idle timeout). Conta regressivo que reinicia
// a CADA atividade do usuário; avisa quando falta pouco; expira ao zerar.
// Equivalente moderno ao startClock/tempoSessao do W5Portal.js (config em minutos).

import { useEffect, useRef, useState } from 'react'

interface Options {
  /** Duração total de inatividade até expirar, em minutos. */
  minutes: number
  /** Fração restante em que dispara o aviso (ex.: 0.2 = aos 20% finais). */
  warnAt?: number
  /** Chamado uma vez ao entrar na janela de aviso. */
  onWarn?: () => void
  /** Chamado ao expirar (zerar). */
  onExpire: () => void
  /** Se false, o timer fica pausado (ex.: já expirado). */
  enabled?: boolean
}

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart'] as const

export function useIdleTimeout({ minutes, warnAt = 0.2, onWarn, onExpire, enabled = true }: Options) {
  const totalMs = Math.max(1, minutes) * 60 * 1000
  const warnMs = totalMs * warnAt

  const [remaining, setRemaining] = useState(totalMs)
  const deadlineRef = useRef(0)
  const warnedRef = useRef(false)
  // Guarda callbacks em refs p/ o efeito não reassinar a cada render.
  const cbRef = useRef({ onWarn, onExpire })
  cbRef.current = { onWarn, onExpire }

  // Reinicia a contagem (chamado por atividade e ao "continuar conectado").
  const reset = () => {
    deadlineRef.current = performance.now() + totalMs
    warnedRef.current = false
    setRemaining(totalMs)
  }

  useEffect(() => {
    if (!enabled) return

    deadlineRef.current = performance.now() + totalMs
    warnedRef.current = false
    setRemaining(totalMs)

    const onActivity = () => {
      // Durante o aviso, NÃO reseta sozinho — o usuário precisa confirmar.
      if (warnedRef.current) return
      deadlineRef.current = performance.now() + totalMs
    }
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }))

    const tick = window.setInterval(() => {
      const left = deadlineRef.current - performance.now()
      setRemaining(Math.max(0, left))

      if (left <= warnMs && !warnedRef.current) {
        warnedRef.current = true
        cbRef.current.onWarn?.()
      }
      if (left <= 0) {
        window.clearInterval(tick)
        cbRef.current.onExpire()
      }
    }, 1000)

    return () => {
      window.clearInterval(tick)
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity))
    }
  }, [enabled, totalMs, warnMs])

  return { remaining, warning: warnedRef.current, reset }
}

/** Formata ms restantes como MM:SS. */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
