// iframe seguro: sandbox por tipo de conteúdo + validação de postMessage por origin.
// Substitui o acesso direto a contentWindow/eval do portal legado (doc §5).
//
// Telas legadas do WF (EV2) passam pela BRIDGE (SSO): antes de montar o iframe,
// pede um token à DHI (/bridge/abrir) e usa a URL retornada (já autenticada).
// Ver docs/portal-mdi-arquitetura §5; design/18-bridge-sso-telas-legadas.

import { useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import { sandboxFor, isMessageTrusted, isOriginAllowed, precisaBridge, telaDoWF, engineDoSrc, precisaTokenSpa, comToken, telaDoSrcSpa } from '@/portal/lib/security'
import { portalApi } from '@/portal/lib/portalApi'
import type { WindowKind } from '@/portal/types'

interface Props {
  src: string
  kind: WindowKind
  title: string
  allowedOrigins: string[]
}

export function SandboxedFrame({ src, kind, title, allowedOrigins }: Props) {
  const t = useTranslations('shell.frame')
  // URL efetiva do iframe. Telas do WF (Bridge) e fronts SPA próprios (token) são
  // resolvidas async (geram token de sessão antes de montar o iframe).
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(
    precisaBridge(src) || precisaTokenSpa(src) ? null : src,
  )
  const [bridgeError, setBridgeError] = useState<string | null>(null)

  // Escuta mensagens do iframe e descarta o que vier de origin não confiável.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isMessageTrusted(event.origin, allowedOrigins)) return
      // eslint-disable-next-line no-console
      console.debug('[portal] mensagem confiável de', event.origin, event.data)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [allowedOrigins])

  // Resolve a URL. Token novo a cada abertura (Bridge WF ou front SPA próprio).
  useEffect(() => {
    const ehWF = precisaBridge(src)
    const ehSpa = !ehWF && precisaTokenSpa(src)

    if (!ehWF && !ehSpa) {
      setResolvedSrc(src)
      return
    }
    let vivo = true
    setResolvedSrc(null)
    setBridgeError(null)
    // engine GX18 p/ DHI Front (.NET Core); EV2 p/ telas legadas do WF.
    portalApi
      .abrirTelaBridge(ehSpa ? telaDoSrcSpa(src) : telaDoWF(src), ehSpa ? 'GX18' : engineDoSrc(src))
      .then((r) => {
        if (!vivo) return
        if (!r.ok) {
          setBridgeError(r.mensagem || t('openErrorSentence'))
          return
        }
        if (ehSpa) {
          // Front SPA próprio: usa a PRÓPRIA URL (localhost:5175/?tela=…) + token,
          // não a URL aspx da Bridge. O SPA troca o token por sessão (/bridge/validar).
          if (r.token) setResolvedSrc(comToken(src, r.token))
          else setBridgeError(t('missingSessionToken'))
        } else if (r.url) {
          setResolvedSrc(r.url)
        } else {
          setBridgeError(t('openErrorSentence'))
        }
      })
      .catch(() => vivo && setBridgeError(t('communicationFailure')))
    return () => {
      vivo = false
    }
  }, [src])

  const blocked = kind === 'iframe-external' && !isOriginAllowed(src, allowedOrigins)

  if (blocked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="text-3xl">🔒</span>
        <p className="text-sm font-medium">{t('blockedOrigin')}</p>
        <p className="max-w-xs text-xs text-muted-foreground break-all">{src}</p>
        <p className="text-xs text-muted-foreground">
          {t('allowlistHint')}
        </p>
      </div>
    )
  }

  if (bridgeError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="text-3xl">⚠️</span>
        <p className="text-sm font-medium">{t('openError')}</p>
        <p className="max-w-xs text-xs text-muted-foreground">{bridgeError}</p>
      </div>
    )
  }

  if (!resolvedSrc) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="text-sm">{t('opening')}</span>
      </div>
    )
  }

  return (
    <iframe
      src={resolvedSrc}
      title={title}
      sandbox={sandboxFor(kind)}
      className="h-full w-full border-0 bg-white"
      referrerPolicy="strict-origin-when-cross-origin"
    />
  )
}
