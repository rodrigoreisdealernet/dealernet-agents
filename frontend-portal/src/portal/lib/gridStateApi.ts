// Persistência do estado dos grids (GridState) por usuário+tela.
// Fonte primária: BFF /gridstate (UserCustomizations na KB DHI, chave PORTAL_DMS_*).
// Fallback/cache: localStorage — usado quando o BFF ainda não tem o endpoint, em modo
// mock, ou em falha de rede. Save no BFF é fire-and-forget (falha silenciosa).

import type { GridState, GridStorage } from '@/portal/components/datatable/types'

const BASE = import.meta.env.VITE_API_BASE ?? '/DealernetHubIntegration/api/v1/portal'
const USE_REAL = import.meta.env.VITE_USE_REAL_API === 'true'
const LS_PREFIX = 'dealernet-portal-gridstate:'

interface GetOutput {
  autenticado?: boolean
  encontrado?: boolean
  UserCustomizationsValue?: string
}

function lsLoad(key: string): GridState | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key)
    return raw ? (JSON.parse(raw) as GridState) : null
  } catch {
    return null
  }
}

function lsSave(key: string, state: GridState) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(state))
  } catch {
    // cota cheia — ignora
  }
}

async function bffLoad(key: string): Promise<GridState | null> {
  const res = await fetch(`${BASE}/gridstate/get?UserCustomizationsKey=${encodeURIComponent(key)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  const text = await res.text()
  if (!text) return null
  const out = JSON.parse(text) as GetOutput
  if (!out.encontrado || !out.UserCustomizationsValue) return null
  return JSON.parse(out.UserCustomizationsValue) as GridState
}

function bffSave(key: string, state: GridState) {
  void fetch(`${BASE}/gridstate/save`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      UserCustomizationsKey: key,
      UserCustomizationsValue: JSON.stringify(state),
    }),
  }).catch(() => {
    // endpoint ausente/offline — o localStorage já guardou
  })
}

export const gridStorage: GridStorage = {
  async load(key) {
    if (USE_REAL) {
      try {
        const remoto = await bffLoad(key)
        if (remoto) return remoto
      } catch {
        // cai no localStorage
      }
    }
    return lsLoad(key)
  },
  save(key, state) {
    lsSave(key, state)
    if (USE_REAL) bffSave(key, state)
  },
}
