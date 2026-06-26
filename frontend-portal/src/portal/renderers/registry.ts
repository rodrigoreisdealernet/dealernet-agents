// Registry de telas nativas (kind=component): componentKey -> componente lazy.
// LIMPEZA 2026-06-15: telas de cadastro migradas para DealernetHubIntegration.
// POC 2026-06-25: adicionadas as 5 telas-âncora da Operations Factory (IA proativa).

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { ScreenProps } from '@/portal/renderers/screens/types'

export const componentRegistry: Record<string, LazyExoticComponent<ComponentType<ScreenProps>>> = {
  'demo-funil': lazy(() => import('@/portal/renderers/demos/DemoFunil')),
  // Operations Factory (POC) — ver docs/PRD-portal-dms-frontend-acoplamento.md §7/§9.
  'agents-dashboard': lazy(() => import('@/portal/renderers/screens/AgentsDashboard')),
  'findings-queue': lazy(() => import('@/portal/renderers/screens/FindingsQueue')),
  'finding-detail': lazy(() => import('@/portal/renderers/screens/FindingDetail')),
  'executive-pack': lazy(() => import('@/portal/renderers/screens/ExecutivePack')),
  // Fast BI (issue #16) — dashboard de Vendas VN/VU.
  'dia-sales': lazy(() => import('@/portal/renderers/screens/SalesDashboard')),
  // Fast BI de Peças (issue #18) — dashboard read-only de estoque/vendas de peças.
  'dia-parts-bi': lazy(() => import('@/portal/renderers/screens/PartsBI')),
  'dia-vehicle-inventory': lazy(() => import('@/portal/renderers/screens/VehicleInventoryBI')),
  // DIA dealership domain (issue #4) — primeira entidade de negócio com CRUD.
  'dia-vehicles': lazy(() => import('@/portal/renderers/screens/VehiclesInventory')),
  // DIA dealership domain (issue #130) — vendas de veículos (status = vendido), read-only.
  'dia-vehicle-sales': lazy(() => import('@/portal/renderers/screens/VehicleSales')),
  // DIA dealership domain (issue #5) — dados mestres empresa/marca com CRUD.
  'dia-companies': lazy(() => import('@/portal/renderers/screens/CompaniesCrud')),
  'dia-brands': lazy(() => import('@/portal/renderers/screens/BrandsCrud')),
  // Gestão de usuários/perfis (issue #6) — somente admin (gating na tela + nav).
  'admin-users': lazy(() => import('@/portal/renderers/screens/UsersAdmin')),
  // DIA dealership domain (issue #7) — Oficina / ordens de serviço.
  'dia-service-orders': lazy(() => import('@/portal/renderers/screens/ServiceOrders')),
  // DIA dealership domain (issue #8) — peças + estado de estoque crítico.
  'dia-parts': lazy(() => import('@/portal/renderers/screens/PartsInventory')),
  // DIA dealership domain (issue #10) — venda de peças (baixa de estoque).
  'dia-part-sales': lazy(() => import('@/portal/renderers/screens/PartSales')),
  // DIA Fast BI (issue #15) — dashboard Visão do Dono.
  'dia-overview': lazy(() => import('@/portal/renderers/screens/DiaOverview')),
  // DIA Fast BI (issue #17) — dashboard Oficina (deriva de v_dia_service_order_current).
  'dia-service-dashboard': lazy(() => import('@/portal/renderers/screens/ServiceDashboard')),
  // Morning Brief do Dono (issue #43) — visão por marca → lojas → ações do agente.
  'morning-brief': lazy(() => import('@/portal/renderers/screens/MorningBrief')),
}

export function resolveComponent(key: string) {
  return componentRegistry[key] ?? null
}
