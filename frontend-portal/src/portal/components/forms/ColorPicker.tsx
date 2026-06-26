// Seletor de cor reutilizável: swatch nativo (input type=color) + campo hex sincronizados.
// Aceita vazio. Controlado por value/onChange. (Cópia do DHI Front — acervos paralelos.)
import { useTranslations } from 'use-intl'
import { cn } from '@/lib/utils'

const HEX6 = /^#[0-9a-fA-F]{6}$/

export interface ColorPickerProps {
  value: string
  onChange: (hex: string) => void
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  className?: string
}

export default function ColorPicker({ value, onChange, placeholder, invalid, disabled, className }: ColorPickerProps) {
  const t = useTranslations('common')
  const hex = typeof value === 'string' ? value : ''
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <input
        type="color"
        value={HEX6.test(hex) ? hex : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-1 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={t('colorPicker')}
      />
      <input
        type="text"
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? '#RRGGBB'}
        maxLength={9}
        disabled={disabled}
        className={cn(
          'flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary',
          invalid ? 'border-destructive' : 'border-input',
          disabled && 'cursor-not-allowed bg-muted/50 text-muted-foreground',
        )}
      />
    </div>
  )
}
