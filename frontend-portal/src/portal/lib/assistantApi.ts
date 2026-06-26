// assistantApi.ts — cliente da DIA conversacional ao vivo.
// Fala com a ops-api (POST /api/ops/assistant/chat) reusando o JWT do Supabase
// (mesma sessão/permissão do usuário). O backend (temporal/src/ops_api/app.py)
// roda o loop chat_with_tools (Azure OpenAI) e devolve { reply, actions, suggestions }.
// Espelha o contrato de decideFinding() em agentsApi.ts.

import { getAccessToken } from '@/portal/lib/agentsApi'
import type { AvailableScreen } from '@/portal/components/dai/daiSuggestions'
import type { Locale } from '@/i18n/locale'

const ENV = import.meta.env as unknown as Record<string, string | undefined>
const OPS_API_URL = ENV.VITE_OPS_API_URL || '/api/ops'

export interface AssistantChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AssistantChatContext {
  current_screen?: string | null
  available_screens: AvailableScreen[]
  empresa_id?: string | null
  locale?: Locale
}

/** Ação de navegação proposta pela DIA — executada no front via openWindow. */
export interface AssistantAction {
  type: 'open_screen'
  component_key: string
  title: string
  params?: Record<string, string>
  reason?: string
}

/** Série de um gráfico (espelha ChartSeries do ChartCard). */
export interface AssistantChartSeries {
  key: string
  label?: string
  format?: 'currency' | 'percent' | 'number'
}

/** Gráfico inline proposto pela DIA — renderizado no balão via ChartCard. */
export interface AssistantChart {
  title: string
  type: 'line' | 'bar' | 'pie'
  x_key: string
  series: AssistantChartSeries[]
  data: Array<Record<string, number | string>>
  value_format?: 'currency' | 'percent' | 'number'
}

export interface AssistantReply {
  reply: string
  actions: AssistantAction[]
  charts: AssistantChart[]
  suggestions: string[]
}

export async function chatWithAssistant(
  messages: AssistantChatMessage[],
  context: AssistantChatContext,
): Promise<AssistantReply> {
  const token = await getAccessToken()
  if (!token) throw new Error('Sem sessão — faça login antes de conversar com a DIA.')

  const res = await fetch(`${OPS_API_URL}/assistant/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages, context }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`DIA indisponível (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as Partial<AssistantReply>
  return {
    reply: data.reply ?? '',
    actions: Array.isArray(data.actions) ? data.actions : [],
    charts: Array.isArray(data.charts) ? data.charts : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
  }
}
