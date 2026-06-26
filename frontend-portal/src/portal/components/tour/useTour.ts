// Onboarding tour do portal — store leve (sem lib). Controla passo atual + a flag
// "já viu" persistida. Dispara no 1º login; rever pelo menu do usuário.

import { create } from 'zustand'

const SEEN_KEY = 'dealernet-portal-tour-v1'

export interface TourStep {
  /** seletor do anchor: [data-tour="..."] */
  target: string
  key: string
  /** lado preferido do balão em relação ao alvo. */
  placement?: 'right' | 'left' | 'top' | 'bottom'
}

// Passos cobrindo: navegação base, modos/janelas, contexto/tema, DAI.
export const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="menu"]',
    key: 'menu',
    placement: 'right',
  },
  {
    target: '[data-tour="busca"]',
    key: 'search',
    placement: 'right',
  },
  {
    target: '[data-tour="modo"]',
    key: 'mode',
    placement: 'bottom',
  },
  {
    target: '[data-tour="workspaces"]',
    key: 'workspaces',
    placement: 'top',
  },
  {
    target: '[data-tour="favoritos"]',
    key: 'favorites',
    placement: 'top',
  },
  {
    target: '[data-tour="empresa"]',
    key: 'company',
    placement: 'bottom',
  },
  {
    target: '[data-tour="tema"]',
    key: 'theme',
    placement: 'bottom',
  },
  {
    target: '[data-tour="usuario"]',
    key: 'account',
    placement: 'bottom',
  },
  {
    target: '[data-tour="dai"]',
    key: 'dai',
    placement: 'left',
  },
]

interface TourState {
  active: boolean
  step: number
  start: () => void
  next: () => void
  prev: () => void
  stop: (markSeen?: boolean) => void
  /** dispara o tour só se o usuário ainda não viu (1º login). */
  maybeAutoStart: () => void
}

export const useTour = create<TourState>((set, get) => ({
  active: false,
  step: 0,
  start: () => set({ active: true, step: 0 }),
  next: () => {
    const n = get().step + 1
    if (n >= TOUR_STEPS.length) get().stop(true)
    else set({ step: n })
  },
  prev: () => set({ step: Math.max(0, get().step - 1) }),
  stop: (markSeen = true) => {
    if (markSeen) {
      try {
        localStorage.setItem(SEEN_KEY, '1')
      } catch {
        /* ignore */
      }
    }
    set({ active: false, step: 0 })
  },
  maybeAutoStart: () => {
    let seen = false
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1'
    } catch {
      /* ignore */
    }
    if (!seen) set({ active: true, step: 0 })
  },
}))
