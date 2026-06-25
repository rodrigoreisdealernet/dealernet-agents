// Campo combo (FK/enum) das telas de cadastro: carrega opções de uma fonte async,
// cacheia por cacheKey (dedupe de requests concorrentes), trata loading e VALOR-ÓRFÃO
// (FK que aponta p/ registro fora da lista — ex. empresa inativa — não some no edit).
// searchable=false → <select> nativo; searchable=true → combobox typeahead via Popover.

import { useEffect, useMemo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronsUpDown, Loader2, Search } from 'lucide-react'
import type { ComboOption, ComboSource } from '@/portal/types'
import { cn } from '@/lib/utils'

// Cache module-level: cacheKey -> Promise das opções (compartilhada entre instâncias).
const cache = new Map<string, Promise<ComboOption[]>>()

function loadOptions(source: ComboSource): Promise<ComboOption[]> {
  let p = cache.get(source.cacheKey)
  if (!p) {
    p = source.load().catch((e) => {
      cache.delete(source.cacheKey) // falha não fica cacheada
      throw e
    })
    cache.set(source.cacheKey, p)
  }
  return p
}

/** Invalida o cache de um combo (ex.: após cadastrar nova Empresa). */
export function invalidateCombo(cacheKey: string) {
  cache.delete(cacheKey)
}

export interface ComboFieldProps {
  source: ComboSource
  value: string // código atual (string; '' = nenhum)
  onChange: (v: string) => void
  invalid?: boolean
  placeholder?: string
  disabled?: boolean
}

export default function ComboField({
  source,
  value,
  onChange,
  invalid,
  placeholder = 'Selecione…',
  disabled,
}: ComboFieldProps) {
  const [options, setOptions] = useState<ComboOption[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErro(false)
    loadOptions(source)
      .then((opts) => alive && setOptions(opts))
      .catch(() => alive && setErro(true))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [source])

  // FK numérica sem seleção chega como '0' (registro vazio do CRUD) — tratar igual a '' (nenhum),
  // senão o combo mostraria "#0 (fora da lista)" ao criar. PK char nunca é '0'.
  const semValor = value === '' || value === '0'

  // Garante que o value atual apareça mesmo se não estiver na lista (valor-órfão real, ex. empresa inativa).
  const opcoes = useMemo<ComboOption[]>(() => {
    const base = options ?? []
    if (!semValor && !base.some((o) => o.value === value)) {
      return [{ value, label: `#${value} (fora da lista)` }, ...base]
    }
    return base
  }, [options, value, semValor])

  const labelAtual = semValor ? '' : (opcoes.find((o) => o.value === value)?.label ?? '')

  const borda = invalid ? 'border-destructive' : 'border-input'

  // --- select nativo (lista pequena) ---
  if (!source.searchable) {
    return (
      <div className="relative">
        <select
          value={semValor ? '' : value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || loading}
          className={cn(
            'w-full appearance-none rounded-lg border bg-background px-3 py-2 pr-8 text-sm outline-none focus:border-primary disabled:opacity-60',
            borda,
          )}
        >
          <option value="">{loading ? 'Carregando…' : erro ? 'Erro ao carregar' : placeholder}</option>
          {opcoes.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
          {loading ? <Loader2 className="animate-spin" size={14} /> : <ChevronsUpDown size={14} />}
        </span>
      </div>
    )
  }

  // --- combobox typeahead (lista grande) ---
  // Passa value normalizado ('' quando sem seleção) p/ não exibir "(Nenhum)"/realce ao criar.
  return <ComboSearch source={source} opcoes={opcoes} value={semValor ? '' : value} labelAtual={labelAtual} loading={loading} erro={erro} borda={borda} placeholder={placeholder} disabled={disabled} onChange={onChange} />
}

function ComboSearch({
  source,
  opcoes,
  value,
  labelAtual,
  loading,
  erro,
  borda,
  placeholder,
  disabled,
  onChange,
}: {
  source: ComboSource
  opcoes: ComboOption[]
  value: string
  labelAtual: string
  loading: boolean
  erro: boolean
  borda: string
  placeholder: string
  disabled?: boolean
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busca, setBusca] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Busca SERVER-SIDE (Pessoa etc.): consulta source.searchFn por termo, com debounce 300ms.
  const serverMode = typeof source.searchFn === 'function'
  const [serverOpts, setServerOpts] = useState<ComboOption[]>([])
  const [serverLoading, setServerLoading] = useState(false)
  useEffect(() => {
    if (!serverMode || !open) return
    const termo = busca.trim()
    setServerLoading(true)
    const t = setTimeout(() => {
      let alive = true
      source
        .searchFn!(termo)
        .then((opts) => alive && setServerOpts(opts))
        .catch(() => alive && setServerOpts([]))
        .finally(() => alive && setServerLoading(false))
      return () => {
        alive = false
      }
    }, 300)
    return () => clearTimeout(t)
  }, [serverMode, open, busca, source])

  // server-mode: o que aparece vem do searchFn (+ o valor atual no topo p/ não sumir).
  // client-mode: filtra as opções já carregadas.
  const filtradas = useMemo(() => {
    if (serverMode) {
      const base = serverOpts
      if (value && labelAtual && !base.some((o) => o.value === value)) {
        return [{ value, label: labelAtual }, ...base].slice(0, 100)
      }
      return base.slice(0, 100)
    }
    const t = busca.trim().toLowerCase()
    if (!t) return opcoes.slice(0, 100)
    return opcoes.filter((o) => o.label.toLowerCase().includes(t)).slice(0, 100)
  }, [serverMode, serverOpts, opcoes, busca, value, labelAtual])

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled || loading}
          className={cn(
            'flex w-full items-center justify-between rounded-lg border bg-background px-3 py-2 text-left text-sm outline-none focus:border-primary disabled:opacity-60',
            borda,
            !value && 'text-muted-foreground',
          )}
        >
          <span className="truncate">{loading ? 'Carregando…' : erro ? 'Erro ao carregar' : labelAtual || placeholder}</span>
          <ChevronsUpDown size={14} className="ml-2 shrink-0 text-muted-foreground" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            inputRef.current?.focus()
          }}
          className="z-[1003] w-[var(--radix-popover-trigger-width)] rounded-lg border border-border bg-card p-1.5 shadow-lg outline-none"
        >
          <div className="relative mb-1.5">
            <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={serverMode ? 'Digite para buscar…' : 'Buscar…'}
              className="w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <div className="max-h-60 overflow-auto">
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
              >
                (Nenhum)
              </button>
            )}
            {filtradas.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="truncate">{o.label}</span>
                {o.value === value && <Check size={14} className="ml-2 shrink-0 text-primary" />}
              </button>
            ))}
            {filtradas.length === 0 && (
              <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                {serverMode && serverLoading
                  ? 'Buscando…'
                  : serverMode && !busca.trim()
                    ? 'Digite para buscar.'
                    : 'Nenhum resultado.'}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
