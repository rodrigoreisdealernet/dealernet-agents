// Barra superior enxuta: ações de janela · usuário/empresa · tema.
// A navegação (menu) agora vive na Sidebar esquerda. (doc §4.3)

import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { AppWindow, Check, Columns2, Copy, Languages, Menu, Minimize, Moon, Palette, Sun, User, XSquare } from 'lucide-react'
import { useTranslations } from 'use-intl'
import { usePortalStore } from '@/portal/store/portalStore'
import { useTheme, ACCENTS } from '@/hooks/use-theme'
import { portalApi } from '@/portal/lib/portalApi'
import type { TemaPortal } from '@/portal/types'
import { useBreakpoint } from '@/hooks/use-breakpoint'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'
import { EmpresaSelector } from '@/portal/components/EmpresaSelector'
import { useTour } from '@/portal/components/tour/useTour'
import { locales } from '@/i18n/locale'
import { useLocale } from '@/i18n/LocaleProvider'
import { LocaleFlag } from '@/i18n/flags'

export function TopBar() {
  const t = useTranslations('shell')
  const tLocale = useTranslations('locale')
  const config = usePortalStore((s) => s.config)
  const cascade = usePortalStore((s) => s.cascade)
  const minimizeAll = usePortalStore((s) => s.minimizeAll)
  const closeAll = usePortalStore((s) => s.closeAll)
  const setDrawerOpen = usePortalStore((s) => s.setDrawerOpen)
  const openWindow = usePortalStore((s) => s.openWindow)
  const layoutMode = usePortalStore((s) => s.layoutMode)
  const setLayoutMode = usePortalStore((s) => s.setLayoutMode)
  const empresas = usePortalStore((s) => s.empresas)
  const { theme, toggleTheme, accent, setAccent, hex, setHex, aplicarMarcaSeSemOverride, aplicarHexMarcaSeSemOverride } = useTheme()
  const [temas, setTemas] = useState<TemaPortal[]>([])

  // Temas de cor da MARCA da empresa ativa (vindos da API). Aplica o 1º como padrão
  // (só se o usuário não tem override) e popula o seletor. Fallback: accents fixos.
  const empresaAtiva = empresas.find((e) => e.ativa)
  const marcaAtiva = empresaAtiva?.grupo
  useEffect(() => {
    let vivo = true
    portalApi
      .getTemas(empresaAtiva ? Number(empresaAtiva.id) : undefined)
      .then((lista) => {
        if (!vivo) return
        setTemas(lista)
        if (lista.length > 0) aplicarHexMarcaSeSemOverride(lista[0].corPrimaria)
        else aplicarMarcaSeSemOverride(marcaAtiva) // sem temas → cor da paleta pela sigla
      })
      .catch(() => { if (vivo) aplicarMarcaSeSemOverride(marcaAtiva) })
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marcaAtiva])
  const { compact } = useBreakpoint()
  const { session, logout } = useAuth()
  const startTour = useTour((s) => s.start)
  const { locale, setLocale } = useLocale()

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-header-border bg-header px-3 text-header-foreground">
      {/* ESQUERDA: menu (compacto) + EMPRESA (contexto vem primeiro). */}
      {compact && (
        <IconBtn title={t('menu')} onClick={() => setDrawerOpen(true)}>
          <Menu size={18} />
        </IconBtn>
      )}
      {compact && <span className="truncate font-semibold">{config?.portalName ?? 'DIA — Dealernet Intelligence Agents'}</span>}

      {!compact && (
        <span data-tour="empresa">
          <EmpresaSelector />
        </span>
      )}

      {/* DIREITA: modo · ações de janela · cor · tema · usuário (agrupados). */}
      <div className="ml-auto flex items-center gap-1">
        {!compact && (
          <>
            {/* Toggle de modo: Abas (estilo navegador) ↔ Janelas (MDI flutuante) */}
            <div data-tour="modo" className="flex items-center gap-0.5 rounded-lg bg-white/10 p-0.5">
              <IconBtn
                title={t('tabsMode')}
                active={layoutMode === 'tabs'}
                onClick={() => setLayoutMode('tabs')}
              >
                <Columns2 size={16} />
              </IconBtn>
              <IconBtn
                title={t('windowsMode')}
                active={layoutMode === 'mdi'}
                onClick={() => setLayoutMode('mdi')}
              >
                <AppWindow size={16} />
              </IconBtn>
            </div>

            {/* Ações de janela só fazem sentido no modo MDI. */}
            {layoutMode === 'mdi' && (
              <div className="flex items-center gap-0.5 rounded-lg bg-white/10 p-0.5">
                <IconBtn title={t('cascade')} onClick={cascade}>
                  <Copy size={16} />
                </IconBtn>
                <IconBtn title={t('minimizeAll')} onClick={minimizeAll}>
                  <Minimize size={16} />
                </IconBtn>
                <IconBtn title={t('closeAll')} onClick={closeAll}>
                  <XSquare size={16} />
                </IconBtn>
              </div>
            )}
            <span className="mx-1 h-6 w-px bg-white/20" />
          </>
        )}

        {/* Seletor de cor do tema */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            title={t('themeColor')}
            data-tour="tema"
            className="flex h-8 w-8 items-center justify-center rounded-md text-white/80 outline-none transition-colors hover:bg-white/10 hover:text-white data-[state=open]:bg-white/10"
          >
            <Palette size={16} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-[9999] w-44 rounded-lg border bg-card p-1 text-card-foreground shadow-xl"
            >
              {temas.length > 0 ? (
                /* Há temas configurados p/ a marca → mostra SÓ eles (esconde os defaults). */
                <>
                  <DropdownMenu.Label className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                    {marcaAtiva ? t('brandThemes', { brand: marcaAtiva }) : t('brandThemesFallback')}
                  </DropdownMenu.Label>
                  {temas.map((t) => (
                    <DropdownMenu.Item
                      key={t.codigo}
                      onSelect={() => setHex(t.corPrimaria)}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
                    >
                      <span
                        className="h-4 w-4 shrink-0 rounded-full ring-1 ring-black/10"
                        style={{ backgroundColor: t.corPrimaria }}
                      />
                      <span className="flex-1">{t.descricao}</span>
                      {hex === t.corPrimaria && <Check size={14} className="text-primary" />}
                    </DropdownMenu.Item>
                  ))}
                </>
              ) : (
                /* Marca sem temas → mostra a paleta default do sistema. */
                <>
                  <DropdownMenu.Label className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                    {t('portalColor')}
                  </DropdownMenu.Label>
                  {ACCENTS.map((a) => (
                    <DropdownMenu.Item
                      key={a.id}
                      onSelect={() => setAccent(a.id)}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
                    >
                      <span
                        className="h-4 w-4 shrink-0 rounded-full ring-1 ring-black/10"
                        style={{ backgroundColor: a.swatch }}
                      />
                      <span className="flex-1">{a.label}</span>
                      {!hex && accent === a.id && <Check size={14} className="text-primary" />}
                    </DropdownMenu.Item>
                  ))}
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <IconBtn title={t('toggleTheme')} onClick={toggleTheme}>
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </IconBtn>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            title={t('language')}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-white/80 outline-none transition-colors hover:bg-white/10 hover:text-white data-[state=open]:bg-white/10"
          >
            <Languages size={16} />
            <LocaleFlag locale={locale} />
            <span className="hidden text-xs font-medium sm:inline">{locale}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-[9999] min-w-44 rounded-lg border bg-card p-1 text-card-foreground shadow-xl"
            >
              <DropdownMenu.Label className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                {t('language')}
              </DropdownMenu.Label>
              {locales.map((option) => (
                <DropdownMenu.Item
                  key={option}
                  onSelect={() => setLocale(option)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
                >
                  <LocaleFlag locale={option} />
                  <span className="flex-1">{tLocale(option)}</span>
                  {locale === option && <Check size={14} className="text-primary" />}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger data-tour="usuario" className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none hover:bg-white/10 data-[state=open]:bg-white/10">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white">
              <User size={15} />
            </span>
            <span className="hidden md:inline">{session?.nome ?? config?.userName ?? t('guest')}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-[9999] min-w-48 rounded-lg border bg-card p-1 text-card-foreground shadow-xl"
            >
              <DropdownMenu.Item
                onSelect={() => startTour()}
                className="cursor-pointer rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
              >
                {t('portalTour')}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() =>
                  openWindow({
                    title: t('changePassword'),
                    kind: 'component',
                    componentKey: 'portal-alterar-senha',
                    width: 460,
                    height: 440,
                  })
                }
                className="cursor-pointer rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-secondary"
              >
                {t('changePassword')}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => logout()}
                className="cursor-pointer rounded-md px-3 py-2 text-sm text-destructive outline-none data-[highlighted]:bg-destructive data-[highlighted]:text-destructive-foreground"
              >
                {t('signOut')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  active?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
        active ? 'bg-white/20 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
    </button>
  )
}
