// Campo de seleção por MODAL de busca — para FK de tabela GRANDE (ex. Pessoa, ~milhares de linhas)
// onde um combo/typeahead inline não serve. Mostra o item escolhido (read-only) + botão "Buscar";
// o modal faz busca SERVER-SIDE (debounce) e lista resultados paginados leves.
// Reutilizável: passe `buscar(termo)` (server-side) + como exibir/extrair value de cada item.
// Usa as classes canônicas do design-system (.input/.btn/.dialog/.field).

import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, Search, X } from 'lucide-react'

export interface BuscaItem {
  value: string
  label: string
  sub?: string // linha secundária (ex.: documento)
}

export interface BuscaModalFieldProps {
  value: string // código atual ('' = nenhum)
  /** rótulo a exibir do item já selecionado (vem do registro: ex. pessoaNom). */
  selectedLabel?: string
  onChange: (value: string, item?: BuscaItem) => void
  /** busca server-side por termo. */
  buscar: (termo: string) => Promise<BuscaItem[]>
  titulo?: string
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
}

export default function BuscaModalField({
  value,
  selectedLabel,
  onChange,
  buscar,
  titulo = 'Buscar',
  placeholder = 'Nenhum selecionado',
  invalid,
  disabled,
}: BuscaModalFieldProps) {
  const [open, setOpen] = useState(false)
  const [termo, setTermo] = useState('')
  const [itens, setItens] = useState<BuscaItem[]>([])
  const [loading, setLoading] = useState(false)
  // Par {value,label} do item escolhido no modal. Só vale enquanto o value do form == picked.value;
  // se o form mudar por fora (trocar de registro), cai de volta no selectedLabel do registro.
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // busca debounced (300ms) enquanto o modal está aberto
  useEffect(() => {
    if (!open) return
    const t = termo.trim()
    if (!t) {
      setItens([])
      return
    }
    setLoading(true)
    const id = setTimeout(() => {
      let alive = true
      buscar(t)
        .then((r) => alive && setItens(r))
        .catch(() => alive && setItens([]))
        .finally(() => alive && setLoading(false))
      return () => {
        alive = false
      }
    }, 300)
    return () => clearTimeout(id)
  }, [open, termo, buscar])

  // Label exibido: prioriza o item escolhido neste componente (se ainda corresponde ao value),
  // senão o label do registro (selectedLabel), senão o código.
  const labelLocal = picked && picked.value === value ? picked.label : ''
  const textoCampo = value ? labelLocal || selectedLabel || `#${value}` : ''

  function selecionar(item: BuscaItem) {
    setPicked({ value: item.value, label: item.label })
    onChange(item.value, item)
    setOpen(false)
    setTermo('')
    setItens([])
  }

  const inputCls = `w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary ${invalid ? 'border-destructive' : 'border-input'}`
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={textoCampo} placeholder={placeholder} className={`${inputCls} flex-1 cursor-default`} />
      {value && !disabled && (
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Limpar"
          onClick={() => onChange('')}
        >
          <X size={15} />
        </button>
      )}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-input px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60"
          >
            <Search size={14} /> Buscar
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1100] bg-black/40" />
          <Dialog.Content
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              inputRef.current?.focus()
            }}
            className="fixed left-1/2 top-1/2 z-[1101] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-4 shadow-xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <Dialog.Title className="text-sm font-semibold">{titulo}</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Fechar">
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="relative mb-3">
              <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={inputRef}
                value={termo}
                onChange={(e) => setTermo(e.target.value)}
                placeholder="Digite nome ou documento…"
                className="w-full rounded-lg border border-input bg-background py-2 pl-8 pr-3 text-sm outline-none focus:border-primary"
              />
            </div>
            <div className="max-h-[50vh] overflow-auto rounded-lg border border-border">
              {loading && (
                <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 size={15} className="animate-spin" /> Buscando…
                </p>
              )}
              {!loading && !termo.trim() && (
                <p className="py-6 text-center text-sm text-muted-foreground">Digite ao menos 1 caractere para buscar.</p>
              )}
              {!loading && termo.trim() && itens.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">Nenhum resultado.</p>
              )}
              {!loading &&
                itens.map((it) => (
                  <button
                    key={it.value}
                    type="button"
                    onClick={() => selecionar(it)}
                    className="flex w-full flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted"
                  >
                    <span className="text-sm">{it.label}</span>
                    {it.sub && <span className="font-mono text-xs text-muted-foreground">{it.sub}</span>}
                  </button>
                ))}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
