// Bandeiras SVG inline por idioma — portadas verbatim do dealernet-workbench
// (apps/web/src/app/components/shell/LocaleSwitcher.tsx). Renderizam igual em
// qualquer navegador/SO, sem depender de emoji, e usam tokens do design system.
import type { Locale } from '@/i18n/locale'

export function LocaleFlag({ locale }: { locale: Locale }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        height: 18,
        width: 24,
        overflow: 'hidden',
        borderRadius: 'var(--radius-xs)',
        border: '1px solid var(--border)',
        background: 'var(--surface)',
      }}
    >
      {locale === 'pt-BR' ? <BrazilFlag /> : <UnitedStatesFlag />}
    </span>
  )
}

function BrazilFlag() {
  return (
    <svg
      style={{ height: '100%', width: '100%' }}
      viewBox="0 0 32 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#229E45" height="24" width="32" />
      <path d="M16 3.2 29 12 16 20.8 3 12Z" fill="#F8E044" />
      <circle cx="16" cy="12" fill="#2B49A3" r="5.2" />
      <path
        d="M11.2 10.8c2.8-.9 6.1-.4 9.5 1.4"
        fill="none"
        stroke="#F7FAFC"
        strokeLinecap="round"
        strokeWidth="1.1"
      />
    </svg>
  )
}

function UnitedStatesFlag() {
  const stripeHeight = 24 / 13

  return (
    <svg
      style={{ height: '100%', width: '100%' }}
      viewBox="0 0 32 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#F7FAFC" height="24" width="32" />
      {Array.from({ length: 7 }, (_, index) => (
        <rect
          fill="#B22234"
          height={stripeHeight}
          key={index}
          width="32"
          y={index * stripeHeight * 2}
        />
      ))}
      <rect fill="#3C3B6E" height={stripeHeight * 7} width="14" />
      {Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 4 }, (_, column) => (
          <circle
            cx={2.1 + column * 3.1 + (row % 2) * 1.5}
            cy={2.1 + row * 2.2}
            fill="#F7FAFC"
            key={`${row}-${column}`}
            r="0.45"
          />
        )),
      )}
    </svg>
  )
}
