// DIA — Dealernet Intelligence Agents · Assistente do Portal.
// Botão flutuante (launcher) + painel lateral de conversa. Segue o Design System do portal
// (tokens OKLCH, navy, accent --primary). Ver docs/assistente-ia-arquitetura.md.
//
// Launcher animado, painel deslizante, mensagens (user/assistente), chips de sugestão,
// estado "pensando" (typing), input com envio. As respostas vêm da ops-api ao vivo
// (useDaiStore → chatWithAssistant): a DIA responde dados de BI e navega pelas telas.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles,
  X,
  SendHorizontal,
  Bot,
  User,
  RotateCcw,
  Wand2,
  AppWindow,
  type LucideIcon,
} from 'lucide-react'
import { useDaiStore } from '@/portal/components/dai/useDaiStore'
import { usePortalStore } from '@/portal/store/portalStore'
import { daiSuggestionsFromMenu, type DaiSuggestion } from '@/portal/components/dai/daiSuggestions'

export function DaiAssistant() {
  const open = useDaiStore((s) => s.open)
  const setOpen = useDaiStore((s) => s.setOpen)

  return (
    <>
      <DaiLauncher open={open} onClick={() => setOpen(!open)} />
      <DaiPanel open={open} onClose={() => setOpen(false)} />
    </>
  )
}

// ── Launcher: botão flutuante no canto inferior direito ────────────────────────
function DaiLauncher({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="DIA — Dealernet Intelligence Agents"
      aria-label="Abrir assistente DIA"
      data-tour="dai"
      className={[
        // bottom-16: acima do rodapé/paginação das janelas MDI (botão não cobre os
        // controles ‹ › de página, que ficam no canto inferior direito do conteúdo).
        'group fixed bottom-16 right-5 z-[9990] flex h-14 w-14 items-center justify-center',
        'rounded-full text-white shadow-lg transition-all duration-300',
        'bg-gradient-to-br from-primary to-primary/70 hover:scale-105 hover:shadow-xl',
        'ring-2 ring-white/30',
        open ? 'scale-90 opacity-0 pointer-events-none' : 'scale-100 opacity-100',
      ].join(' ')}
    >
      <Sparkles size={24} className="transition-transform group-hover:rotate-12" />
      <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/70 opacity-75" />
        <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-accent ring-2 ring-white" />
      </span>
    </button>
  )
}

// ── Painel lateral de conversa ─────────────────────────────────────────────────
function DaiPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const messages = useDaiStore((s) => s.messages)
  const thinking = useDaiStore((s) => s.thinking)
  const send = useDaiStore((s) => s.send)
  const reset = useDaiStore((s) => s.reset)

  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking])

  // Sugestões DERIVADAS DO MENU do usuário (configurável por permissão, não hardcoded).
  const menu = usePortalStore((s) => s.menu)
  const openWindow = usePortalStore((s) => s.openWindow)
  const ackSuggestion = useDaiStore((s) => s.ackSuggestion)
  const suggestions = useMemo(() => daiSuggestionsFromMenu(menu, { max: 4 }), [menu])

  const submit = () => {
    const t = draft.trim()
    if (!t || thinking) return
    setDraft('')
    void send(t)
  }

  // Clicar numa sugestão ABRE a tela na hora + registra no chat (ação de navegação).
  const pickSuggestion = (s: DaiSuggestion) => {
    openWindow(s.spec)
    ackSuggestion(s.text)
  }

  return (
    <aside
      className={[
        'fixed bottom-0 right-0 top-0 z-[9991] flex w-[400px] max-w-[92vw] flex-col',
        'border-l bg-card shadow-2xl transition-transform duration-300 ease-out',
        open ? 'translate-x-0' : 'translate-x-full',
      ].join(' ')}
      aria-hidden={!open}
    >
      {/* Header */}
      <header className="flex items-center gap-3 border-b bg-gradient-to-r from-primary to-primary/80 px-4 py-3 text-white">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/25">
          <Sparkles size={18} />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-1.5 font-semibold leading-tight">
            DIA
            <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
              beta
            </span>
          </div>
          <div className="text-xs text-white/75">Dealernet Intelligence Agents · assistente do portal</div>
        </div>
        <button
          type="button"
          onClick={reset}
          title="Nova conversa"
          className="flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white"
        >
          <RotateCcw size={16} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Fechar"
          className="flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white"
        >
          <X size={18} />
        </button>
      </header>

      {/* Conversa */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && <DaiWelcome suggestions={suggestions} onPick={pickSuggestion} />}
        {messages.map((m) => (
          <DaiBubble key={m.id} role={m.role} text={m.text} />
        ))}
        {thinking && <DaiTyping />}
      </div>

      {/* Sugestões rápidas (sempre visíveis, discretas) — telas do menu do usuário */}
      {messages.length > 0 && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t px-4 py-2">
          {suggestions.slice(0, 3).map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pickSuggestion(s)}
              disabled={thinking}
              title={`Abrir ${s.text} (${s.solucao})`}
              className="flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
            >
              <SuggestionIcon name={s.icon} size={12} />
              <span className="max-w-[140px] truncate">{s.text}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="border-t p-3">
        <div className="flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-primary/40">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={1}
            placeholder="Pergunte ou peça algo à DIA…"
            className="max-h-28 flex-1 resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || thinking}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <SendHorizontal size={16} />
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
          DIA pode cometer erros. Confira ações importantes.
        </p>
      </div>
    </aside>
  )
}

// ── Tela de boas-vindas / sugestões ──────────────────────────────────────────
function DaiWelcome({
  suggestions,
  onPick,
}: {
  suggestions: DaiSuggestion[]
  onPick: (s: DaiSuggestion) => void
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-2 py-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/60 text-white shadow-md">
        <Sparkles size={28} />
      </div>
      <div>
        <h3 className="text-base font-semibold text-foreground">Olá! Sou a DIA 👋</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Posso responder sobre vendas, estoque, oficina e peças com dados reais — e abrir a tela
          certa pra você. É só perguntar.
        </p>
      </div>
      {suggestions.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Wand2 size={13} /> Acesso rápido às suas telas:
          </span>
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s)}
              className="flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-primary hover:bg-secondary"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
                <SuggestionIcon name={s.icon} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{s.text}</span>
                <span className="block truncate text-xs text-muted-foreground">{s.solucao}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Ícone da sugestão: mapeia o nome vindo do menu; fallback = janela genérica.
const SUGGESTION_ICONS: Record<string, LucideIcon> = {}
function SuggestionIcon({ name, size }: { name?: string; size: number }) {
  const Icon = (name && SUGGESTION_ICONS[name]) || AppWindow
  return <Icon size={size} />
}

// ── Balão de mensagem ──────────────────────────────────────────────────────────
function DaiBubble({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  const isUser = role === 'user'
  return (
    <div className={['flex items-start gap-2.5', isUser ? 'flex-row-reverse' : ''].join(' ')}>
      <div
        className={[
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-secondary text-foreground' : 'bg-primary text-primary-foreground',
        ].join(' ')}
      >
        {isUser ? <User size={15} /> : <Bot size={15} />}
      </div>
      <div
        className={[
          'max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
          isUser
            ? 'rounded-tr-sm bg-primary text-primary-foreground'
            : 'rounded-tl-sm border bg-background text-foreground',
        ].join(' ')}
      >
        {text}
      </div>
    </div>
  )
}

// ── Indicador "pensando" ────────────────────────────────────────────────────────
function DaiTyping() {
  return (
    <div className="flex items-start gap-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Bot size={15} />
      </div>
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm border bg-background px-4 py-3">
        <Dot delay="0ms" />
        <Dot delay="150ms" />
        <Dot delay="300ms" />
      </div>
    </div>
  )
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
      style={{ animationDelay: delay }}
    />
  )
}
