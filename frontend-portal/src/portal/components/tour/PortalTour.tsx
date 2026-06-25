// Onboarding tour — overlay com "spotlight" recortado no elemento-alvo + balão.
// Componente próprio (sem lib), no Design System do portal. Ver useTour.ts.

import { useEffect, useLayoutEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { useTour, TOUR_STEPS } from '@/portal/components/tour/useTour'

interface Rect { top: number; left: number; width: number; height: number }

const PAD = 6 // respiro do recorte ao redor do alvo

export function PortalTour() {
  const active = useTour((s) => s.active)
  const step = useTour((s) => s.step)
  const next = useTour((s) => s.next)
  const prev = useTour((s) => s.prev)
  const stop = useTour((s) => s.stop)

  const [rect, setRect] = useState<Rect | null>(null)
  const current = TOUR_STEPS[step]

  // Localiza o alvo e mede sua posição (recalcula em troca de passo / resize / scroll).
  useLayoutEffect(() => {
    if (!active || !current) return
    const measure = () => {
      const el = document.querySelector(current.target) as HTMLElement | null
      if (!el) {
        setRect(null)
        return
      }
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [active, current, step])

  // Esc fecha; setas navegam.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop(true)
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, next, prev, stop])

  if (!active || !current) return null

  const last = step === TOUR_STEPS.length - 1
  const balloon = balloonPosition(rect, current.placement)

  return (
    <div className="fixed inset-0 z-[10000]">
      {/* Overlay escuro com recorte (spotlight) via box-shadow gigante no buraco. */}
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-lg transition-all duration-300"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.65)',
            outline: '2px solid var(--primary)',
            outlineOffset: 2,
          }}
        />
      ) : (
        // alvo não encontrado nesta resolução: escurece tudo (tour ainda navega)
        <div className="absolute inset-0 bg-slate-900/65" />
      )}
      {/* Camada clicável p/ fechar ao clicar fora do balão. */}
      <div className="absolute inset-0" onClick={() => stop(true)} />

      {/* Balão */}
      <div
        role="dialog"
        aria-label={current.title}
        onClick={(e) => e.stopPropagation()}
        className="absolute w-[300px] max-w-[90vw] rounded-xl border bg-card p-4 text-card-foreground shadow-2xl"
        style={balloon}
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles size={15} />
          </span>
          <h3 className="flex-1 text-sm font-semibold">{current.title}</h3>
          <button
            type="button"
            onClick={() => stop(true)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Fechar tour"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{current.body}</p>

        <div className="mt-4 flex items-center justify-between">
          {/* progresso */}
          <div className="flex items-center gap-1">
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                className={[
                  'h-1.5 rounded-full transition-all',
                  i === step ? 'w-4 bg-primary' : 'w-1.5 bg-border',
                ].join(' ')}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => stop(true)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Pular
            </button>
            {step > 0 && (
              <button
                type="button"
                onClick={prev}
                className="rounded-md border px-2.5 py-1 text-xs hover:bg-secondary"
              >
                Voltar
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              {last ? 'Concluir' : 'Próximo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Calcula a posição do balão ao lado do alvo, com fallback centralizado.
function balloonPosition(rect: Rect | null, placement?: string): React.CSSProperties {
  if (!rect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  }
  const gap = 14
  const W = 300
  const H = 180
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top = rect.top
  let left = rect.left

  switch (placement) {
    case 'right':
      left = rect.left + rect.width + gap
      top = rect.top
      break
    case 'left':
      left = rect.left - W - gap
      top = rect.top
      break
    case 'top':
      left = rect.left
      top = rect.top - H - gap
      break
    case 'bottom':
    default:
      left = rect.left
      top = rect.top + rect.height + gap
      break
  }
  // mantém dentro da viewport
  left = Math.min(Math.max(8, left), vw - W - 8)
  top = Math.min(Math.max(8, top), vh - H - 8)
  return { top, left }
}
