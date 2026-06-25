// Onboarding tour do portal — store leve (sem lib). Controla passo atual + a flag
// "já viu" persistida. Dispara no 1º login; rever pelo menu do usuário.

import { create } from 'zustand'

const SEEN_KEY = 'dealernet-portal-tour-v1'

export interface TourStep {
  /** seletor do anchor: [data-tour="..."] */
  target: string
  title: string
  body: string
  /** lado preferido do balão em relação ao alvo. */
  placement?: 'right' | 'left' | 'top' | 'bottom'
}

// Passos cobrindo: navegação base, modos/janelas, contexto/tema, DAI.
export const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="menu"]',
    title: 'Menu por solução',
    body: 'Suas telas ficam aqui, organizadas por solução do DMS. Só aparece o que você tem permissão de acessar.',
    placement: 'right',
  },
  {
    target: '[data-tour="busca"]',
    title: 'Busca de telas',
    body: 'Digite para encontrar qualquer tela em todos os níveis do menu — sem precisar navegar a árvore.',
    placement: 'right',
  },
  {
    target: '[data-tour="modo"]',
    title: 'Abas ou Janelas',
    body: 'Alterne entre o modo Abas (estilo navegador) e Janelas flutuantes (MDI). Sua preferência fica salva.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="workspaces"]',
    title: 'Workspaces',
    body: 'Salve o conjunto de telas abertas como um workspace e volte a ele depois. Use os botões ao lado para salvar, criar ou excluir.',
    placement: 'top',
  },
  {
    target: '[data-tour="favoritos"]',
    title: 'Favoritos',
    body: 'Marque as telas que você mais usa como favoritas e abra-as com um clique aqui embaixo.',
    placement: 'top',
  },
  {
    target: '[data-tour="empresa"]',
    title: 'Empresa e marca',
    body: 'Troque a empresa em que você está trabalhando — a marca dela aparece ao lado. As telas e as cores do portal passam a refletir o contexto escolhido.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="tema"]',
    title: 'Tema por marca',
    body: 'O portal já vem na cor da marca da sua empresa. Aqui você pode escolher outro tema da marca ou alternar entre claro e escuro — sua preferência fica salva.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="usuario"]',
    title: 'Sua conta',
    body: 'Aqui você altera a senha e sai com segurança do portal.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="dai"]',
    title: 'DAI — Dealernet AI',
    body: 'Seu assistente: peça para abrir telas e navegar por comando. Em breve, também responde sobre seus dados.',
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
