// Camada de segurança do portal: allowlist de origins e atributos de sandbox.
// Substitui o acesso direto a contentWindow/eval do portal legado.
// Ver docs/portal-mdi-arquitetura.md §5.

import type { WindowKind } from '@/portal/types'

/** Extrai o origin (protocolo+host) de uma URL; null se relativa/invalida. */
export function originOf(url: string): string | null {
  try {
    // URLs relativas (telas ASPX servidas pela mesma origem) -> origin atual.
    return new URL(url, window.location.href).origin
  } catch {
    return null
  }
}

/** Uma URL é permitida se seu origin estiver na allowlist (ou for a própria origem). */
export function isOriginAllowed(url: string, allowedOrigins: string[]): boolean {
  const origin = originOf(url)
  if (!origin) return false
  if (origin === window.location.origin) return true
  return allowedOrigins.includes(origin)
}

/**
 * Atributos de sandbox por tipo de conteúdo — allowlist MÍNIMA.
 * Conteúdo externo recebe menos permissões (sem same-origin) que telas internas.
 */
export function sandboxFor(kind: WindowKind): string {
  switch (kind) {
    case 'iframe-aspx':
      // Tela legada do ERP: precisa de cookies/sessão (same-origin), forms e popups.
      return 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals'
    case 'iframe-external':
      // BI / terceiros: sem same-origin -> não acessa cookies/DOM do portal.
      return 'allow-scripts allow-forms allow-popups'
    default:
      return ''
  }
}

/** Valida uma mensagem postMessage vinda de um iframe contra a allowlist. */
export function isMessageTrusted(origin: string, allowedOrigins: string[]): boolean {
  return origin === window.location.origin || allowedOrigins.includes(origin)
}

// Telas legadas do WF precisam de SESSÃO autenticada na engine. Antes de abri-las no
// iframe, o portal gera um token via Bridge (ver design/18). Há 2 engines, por prefixo:
//  - EV2  (.NET Framework): /DealerNetWF/
//  - GX18 (.NET Core):      /DealernetWFNetCore/
const WF_ENGINES: { prefix: string; engine: 'EV2' | 'GX18' }[] = [
  { prefix: '/DealernetWFNetCore/', engine: 'GX18' },
  { prefix: '/DealerNetWF/', engine: 'EV2' },
]

/** A URL é uma tela legada do WF que exige passar pela Bridge (SSO)? */
export function precisaBridge(src: string): boolean {
  const s = src.trim()
  // já é a própria bridge/login → não reentra.
  if (s.includes('bridge.aspx') || s.includes('login.aspx')) return false
  return WF_ENGINES.some((e) => s.includes(e.prefix))
}

/** Engine do WF a que o src pertence (EV2 default). */
export function engineDoSrc(src: string): 'EV2' | 'GX18' {
  return WF_ENGINES.find((e) => src.includes(e.prefix))?.engine ?? 'EV2'
}

/** Extrai o nome da tela (ex.: 'wwferiado.aspx') de um src do WF, p/ passar à Bridge. */
export function telaDoWF(src: string): string {
  const semQuery = src.split('?')[0]
  const partes = semQuery.split('/').filter(Boolean)
  return partes[partes.length - 1] || ''
}

// Fronts SPA PRÓPRIOS do DMS (React) que NÃO são telas .aspx legadas, mas mesmo assim
// precisam de SESSÃO: o portal gera um token (TRN Sessao) e o anexa à URL (?token=),
// e o SPA o troca por sessão própria via /bridge/validar. Hoje: DHI Front (:5175).
const SPA_FRONTS_TOKEN = [/(^|\/\/)localhost:5175(\/|$|\?)/, /\/\/[^/]*dealernethubintegration[^/]*\//i]

// Origem pública do DHI Front em demo via túnel (ngrok). Definida em VITE_DHI_FRONT_URL.
const DHI_FRONT_ORIGIN = (() => {
  const u = (import.meta.env.VITE_DHI_FRONT_URL || '').trim()
  try {
    return u ? new URL(u).origin : ''
  } catch {
    return ''
  }
})()

/** O src é um front SPA próprio que precisa de token de sessão do portal? */
export function precisaTokenSpa(src: string): boolean {
  const s = src.trim()
  // Demo 1-URL: DHI Front servido sob /dhi/ na MESMA origem do portal (build estático).
  if (s.startsWith('/dhi/') || s.startsWith('/dhi?')) return true
  if (DHI_FRONT_ORIGIN && originOf(src) === DHI_FRONT_ORIGIN) return true
  return SPA_FRONTS_TOKEN.some((re) => re.test(src))
}

/** Anexa ?token=<tkn> a uma URL preservando os demais parâmetros (ex.: ?tela=cargo). */
export function comToken(src: string, token: string): string {
  const sep = src.includes('?') ? '&' : '?'
  return `${src}${sep}token=${encodeURIComponent(token)}`
}

/** Nome da tela do front SPA (valor de ?tela=), p/ passar ao /bridge/abrir; 'spa' default. */
export function telaDoSrcSpa(src: string): string {
  try {
    const u = new URL(src, window.location.href)
    return u.searchParams.get('tela') || 'spa'
  } catch {
    return 'spa'
  }
}
