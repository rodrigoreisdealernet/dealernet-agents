// Diálogo de confirmação para ações destrutivas (padrão Boilerplate: confirmar antes de
// inativar/excluir). Radix AlertDialog — foco preso, Esc cancela, overlay não fecha no clique.

import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Loader2 } from 'lucide-react'
import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  /** Conteúdo descritivo (texto ou resumo do registro). */
  children?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Estiliza o botão de confirmação como destrutivo (vermelho). */
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[1000] bg-black/40" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[1001] w-[min(420px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-xl outline-none">
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          {children && (
            <AlertDialog.Description asChild>
              <div className="mt-2 text-sm text-muted-foreground">{children}</div>
            </AlertDialog.Description>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={busy}
                className="rounded-lg border border-input px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60"
              >
                {cancelLabel}
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault() // Radix fecharia; quem fecha é o caller após concluir
                  onConfirm()
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-primary-foreground transition-colors disabled:opacity-60',
                  destructive ? 'bg-destructive hover:bg-destructive/90' : 'bg-primary hover:bg-primary/90',
                )}
              >
                {busy && <Loader2 className="animate-spin" size={15} />}
                {confirmLabel}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
