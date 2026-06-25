// Props que o WindowBody passa para toda tela nativa (kind=component) da POC.
// params vem do WindowSpec.params (ex.: { findingId } | { agentKey } | { entityId }).
export interface ScreenProps {
  params?: Record<string, unknown>
}
