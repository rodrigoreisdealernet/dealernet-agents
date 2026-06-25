// Sinal global de SESSÃO EXPIRADA/INVÁLIDA detectada por uma chamada de API.
//
// Diferente do timeout de inatividade (SessionGuard/use-idle-timeout, que é um timer
// LOCAL), aqui a sessão do BACKEND caiu (cookie inválido/expirado) e só uma chamada à
// API revela — ex.: /bridge/abrir ou um /list voltando autenticado:false / 401.
//
// O portalApiReal dispara este evento; o SessionGuard escuta e mostra a tela de
// "Sessão expirada" (com logout), em vez de cada iframe/tela mostrar um erro genérico.

export const SESSION_EXPIRED_EVENT = 'portal:session-expired'

let avisado = false

/** Dispara o aviso de sessão expirada UMA vez (evita N popups em chamadas paralelas). */
export function notifySessionExpired(motivo?: string) {
  if (avisado || typeof window === 'undefined') return
  avisado = true
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { motivo } }))
}

/** Rearma o aviso (chamar ao logar de novo, para futuras expirações dispararem). */
export function resetSessionExpiredFlag() {
  avisado = false
}
