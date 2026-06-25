// Store local do DAI (ESBOÇO / mock). Quando o BFF/GEAI entrar, `send()` chama a API real
// e troca-se `fakeReply()` pela resposta do modelo (+ tool calls de navegação).

import { create } from 'zustand'

export interface DaiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

interface DaiState {
  open: boolean
  thinking: boolean
  messages: DaiMessage[]
  setOpen: (v: boolean) => void
  send: (text: string) => void
  ackSuggestion: (tela: string) => void
  reset: () => void
}

let seq = 0
const nextId = () => `dai-${Date.now()}-${seq++}`

// Respostas SIMULADAS só para o esboço visual (sem IA real).
function fakeReply(prompt: string): string {
  const p = prompt.toLowerCase()
  if (p.includes('funil')) return 'Pronto — abri o Funil de Vendas pra você. 📊 (simulado)'
  if (p.includes('lead')) return 'O cadastro de Leads fica em CRM › Cadastros › Leads. Quer que eu abra? (simulado)'
  if (p.includes('tema') || p.includes('cor')) return 'Tema alterado. 🎨 (simulado)'
  if (p.includes('favorit')) return 'Você tem 3 telas favoritas. Quer que eu liste? (simulado)'
  return 'Entendi! Assim que o GEAI estiver conectado, eu executo isso de verdade. (esboço — sem IA real)'
}

export const useDaiStore = create<DaiState>((set, get) => ({
  open: false,
  thinking: false,
  messages: [],
  setOpen: (v) => set({ open: v }),
  reset: () => set({ messages: [], thinking: false }),
  // Registra no chat que abriu uma tela a partir de uma sugestão (ação de navegação).
  ackSuggestion: (tela) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nextId(), role: 'user', text: `Abrir ${tela}` },
        { id: nextId(), role: 'assistant', text: `Pronto — abri "${tela}" pra você. ✅` },
      ],
    })),
  send: (text) => {
    set((s) => ({ messages: [...s.messages, { id: nextId(), role: 'user', text }], thinking: true }))
    // Simula latência do modelo.
    window.setTimeout(() => {
      const reply = fakeReply(text)
      set((s) => ({
        messages: [...s.messages, { id: nextId(), role: 'assistant', text: reply }],
        thinking: false,
      }))
    }, 900)
    void get
  },
}))
