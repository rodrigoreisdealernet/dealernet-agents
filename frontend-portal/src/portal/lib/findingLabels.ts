// Friendly, localized labels for ops finding metadata (issue #73). Maps raw
// codes (agent_key, finding_type, recommended_action) to human-readable names,
// falling back to the raw code when a translation is missing.
import { useCallback } from 'react'
import { useTranslations } from 'use-intl'

export function useFindingLabels() {
  const root = useTranslations()
  const agents = useTranslations('labels.agents')
  const types = useTranslations('labels.findingTypes')
  const actions = useTranslations('labels.actions')

  const agentLabel = useCallback(
    (key: string | null | undefined): string => (key ? (agents.has(key) ? agents(key) : key) : ''),
    [agents],
  )
  const findingTypeLabel = useCallback(
    (key: string | null | undefined): string => (key ? (types.has(key) ? types(key) : key) : ''),
    [types],
  )
  const actionLabel = useCallback(
    (key: string | null | undefined): string => (key ? (actions.has(key) ? actions(key) : key) : ''),
    [actions],
  )
  // Resolve a full i18n key path from the mission catalog (issue #125), e.g.
  // `labels.agentMissions.<agent_key>.objective`. Falls back to '' (never the raw
  // key) so a missing translation hides the line instead of leaking the key.
  const missionText = useCallback(
    (key: string | null | undefined): string => (key ? (root.has(key) ? root(key) : '') : ''),
    [root],
  )

  return { agentLabel, findingTypeLabel, actionLabel, missionText }
}
