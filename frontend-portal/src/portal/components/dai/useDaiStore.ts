// Store local da DIA (assistente conversacional do Portal).
// `send()` chama a ops-api (chatWithAssistant), recebe { reply, actions, suggestions }
// e executa as ações de navegação no front (openWindow). Ver
// docs/planos-aprovados/2026-06-25-dia-conversacional-portal.md.

import { create } from 'zustand'
import { chatWithAssistant, type AssistantChatMessage } from '@/portal/lib/assistantApi'
import { availableScreensFromMenu } from '@/portal/components/dai/daiSuggestions'
import { usePortalStore } from '@/portal/store/portalStore'
import type { Locale } from '@/i18n/locale'

export interface DaiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

interface DaiState {
  open: boolean
  thinking: boolean
  messages: DaiMessage[]
  suggestions: string[]
  setOpen: (v: boolean) => void
  send: (text: string, locale: Locale, fallbackReply: string) => Promise<void>
  ackSuggestion: (openCommand: string, openedMessage: string) => void
  reset: () => void
}

let seq = 0
const nextId = () => `dai-${Date.now()}-${seq++}`

/** Histórico no formato que a ops-api espera (role/content), sem ids. */
function toApiMessages(messages: DaiMessage[]): AssistantChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.text }))
}

export const useDaiStore = create<DaiState>((set, get) => ({
  open: false,
  thinking: false,
  messages: [],
  suggestions: [],
  setOpen: (v) => set({ open: v }),
  reset: () => set({ messages: [], suggestions: [], thinking: false }),
  // Registra no chat que abriu uma tela a partir de uma sugestão (ação de navegação).
  ackSuggestion: (openCommand, openedMessage) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nextId(), role: 'user', text: openCommand },
        { id: nextId(), role: 'assistant', text: openedMessage },
      ],
    })),
  send: async (text, locale, fallbackReply) => {
    const userMsg: DaiMessage = { id: nextId(), role: 'user', text }
    const history = [...get().messages, userMsg]
    set({ messages: history, thinking: true })

    // Contexto da sessão: tela ativa + telas que o usuário pode abrir (allowlist) + empresa.
    const portal = usePortalStore.getState()
    const active = portal.windows.find((w) => w.id === portal.activeWindowId)
    const context = {
      current_screen: active?.componentKey ?? null,
      available_screens: availableScreensFromMenu(portal.menu),
      empresa_id: portal.empresaAtualId,
      locale,
    }

    try {
      const res = await chatWithAssistant(toApiMessages(history), context)
      set((s) => ({
        messages: [...s.messages, { id: nextId(), role: 'assistant', text: res.reply || '…' }],
        suggestions: res.suggestions ?? [],
        thinking: false,
      }))
      // Executa a navegação proposta (allowlist já revalidado no backend).
      for (const action of res.actions) {
        if (action.type !== 'open_screen' || !action.component_key) continue
        usePortalStore.getState().openWindow({
          kind: 'component',
          componentKey: action.component_key,
          title: action.title || action.component_key,
          params: action.params,
        })
      }
    } catch (e) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: nextId(),
            role: 'assistant',
            text: fallbackReply,
          },
        ],
        thinking: false,
      }))
      console.warn('[dia] falha ao conversar', e)
    }
  },
}))
