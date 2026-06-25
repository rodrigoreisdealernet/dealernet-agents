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
  'audit-trail': lazy(() => import('@/portal/renderers/screens/AuditTrail')),
  'executive-pack': lazy(() => import('@/portal/renderers/screens/ExecutivePack')),
  // DIA dealership domain (issue #4) — primeira entidade de negócio com CRUD.
  'dia-vehicles': lazy(() => import('@/portal/renderers/screens/VehiclesInventory')),
  // DIA dealership domain (issue #5) — dados mestres empresa/marca com CRUD.
  'dia-companies': lazy(() => import('@/portal/renderers/screens/CompaniesCrud')),
  'dia-brands': lazy(() => import('@/portal/renderers/screens/BrandsCrud')),
}

export function resolveComponent(key: string) {
  return componentRegistry[key] ?? null
}
