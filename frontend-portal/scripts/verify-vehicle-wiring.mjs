// Verificacao dependency-free do wiring do frontend de Veiculos (Issue #4).
//
// Ambiente OFFLINE sem runner de teste instalavel (sem vitest): usamos apenas os
// modulos nativos do Node (node:test, node:assert, node:fs) para assertar, lendo
// os arquivos-fonte, que a tela de Veiculos esta conectada as RPCs/view corretas,
// registrada no registry e exposta no menu. Garante que o frontend nao regrida.
//
// Roda com: node --test scripts/verify-vehicle-wiring.mjs
//
// NOTA DE DESVIO (spec docs/specs/4-vehicle-crud.md): a spec pedia a UIEngine em
// `frontend/`, mas essa app foi removida pela migration de prune; a tela foi
// implementada nativamente em `frontend-portal` (componente + registry + menu).
// Estes asserts cobrem exatamente esse caminho real.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Raiz do frontend-portal (este arquivo vive em frontend-portal/scripts/).
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function read(relPath) {
  const full = resolve(ROOT, relPath)
  assert.ok(existsSync(full), `arquivo esperado nao encontrado: ${relPath}`)
  return readFileSync(full, 'utf8')
}

test('AC: VehiclesInventory.tsx existe', () => {
  assert.ok(
    existsSync(resolve(ROOT, 'src/portal/renderers/screens/VehiclesInventory.tsx')),
    'a tela VehiclesInventory.tsx deve existir',
  )
})

test('AC: agentsApi.ts le da view v_dia_vehicle_current', () => {
  const api = read('src/portal/lib/agentsApi.ts')
  assert.ok(
    api.includes('v_dia_vehicle_current'),
    'agentsApi.ts deve consultar a view v_dia_vehicle_current (leitura corrente de veiculos)',
  )
})

test('AC: agentsApi.ts escreve via as 3 RPCs endurecidas (create/update/delete_vehicle)', () => {
  const api = read('src/portal/lib/agentsApi.ts')
  for (const rpc of ['create_vehicle', 'update_vehicle', 'delete_vehicle']) {
    // Exige a chamada .rpc('<nome>') — pega regressao tanto no nome quanto no
    // canal de escrita (deve ser RPC, nunca INSERT/UPDATE direto no cliente).
    assert.match(
      api,
      new RegExp(`\\.rpc\\(\\s*['"]${rpc}['"]`),
      `agentsApi.ts deve escrever via supabase.rpc('${rpc}', ...)`,
    )
  }
})

test('AC: VehiclesInventory.tsx consome as 3 operacoes de escrita (via agentsApi)', () => {
  const screen = read('src/portal/renderers/screens/VehiclesInventory.tsx')
  for (const fn of ['createVehicle', 'updateVehicle', 'deleteVehicle', 'getVehicles']) {
    assert.ok(
      screen.includes(fn),
      `VehiclesInventory.tsx deve usar ${fn} do agentsApi (CRUD completo + leitura)`,
    )
  }
})

test('AC: a tela esta registrada no registry sob a chave dia-vehicles', () => {
  const registry = read('src/portal/renderers/registry.ts')
  // Casa a entrada 'dia-vehicles': lazy(() => import('.../VehiclesInventory'))
  assert.match(
    registry,
    /['"]dia-vehicles['"]\s*:\s*lazy\([\s\S]*?VehiclesInventory/,
    "registry.ts deve mapear 'dia-vehicles' -> import lazy de VehiclesInventory",
  )
})

test('AC: ha item de menu para o estoque de veiculos apontando para a tela', () => {
  const portalApi = read('src/portal/lib/portalApi.ts')
  // O item de menu deve existir (id dealership-vehicles) e seu spec deve apontar
  // para o componentKey 'dia-vehicles' (o mesmo registrado no registry).
  assert.ok(
    portalApi.includes('dealership-vehicles'),
    "portalApi.ts deve ter um item de menu com id 'dealership-vehicles'",
  )
  assert.match(
    portalApi,
    /componentKey:\s*['"]dia-vehicles['"]/,
    "o item de menu deve apontar componentKey: 'dia-vehicles' (liga menu -> registry -> tela)",
  )
})
