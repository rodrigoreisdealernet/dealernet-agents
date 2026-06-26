// Sugestões iniciais do DAI — DERIVADAS DO MENU do usuário (não hardcoded).
// Decisão (2026-06-10): zero cadastro; cada usuário vê sugestões das telas que
// REALMENTE pode abrir (o menu já vem filtrado por permissão). Cada sugestão
// carrega texto + ícone + ação de navegação (abre a tela) + a solução de origem.
//
// Heurística atual (até termos histórico de acesso): primeiras telas-folha de
// cada solução, intercalando soluções para dar variedade. Quando houver
// "telas mais usadas/favoritas", troca-se `pickLeaves()` por esse ranking.

import type { MenuItem, WindowSpec } from '@/portal/types'

export interface DaiSuggestion {
  id: string
  text: string
  icon?: string // nome do ícone (mesmo esquema do MenuItem.icon)
  spec: WindowSpec // ação: abrir a tela
  solucao: string // produto/módulo de origem (1º nível do menu)
}

// Telas-folha (que abrem janela) de um nó do menu, recursivo.
function leavesOf(node: MenuItem): MenuItem[] {
  if (node.spec && !node.children?.length) return [node]
  if (!node.children?.length) return []
  return node.children.flatMap(leavesOf)
}

/**
 * Gera sugestões a partir do menu.
 * @param menu        árvore do menu (1º nível = solução).
 * @param perSolucao  quantas telas por solução considerar.
 * @param max         total máximo de sugestões.
 * @param solucao     se informado, filtra só essa solução (1º nível).
 */
export function daiSuggestionsFromMenu(
  menu: MenuItem[],
  { perSolucao = 2, max = 4, solucao }: { perSolucao?: number; max?: number; solucao?: string } = {},
): DaiSuggestion[] {
  const solucoes = solucao
    ? menu.filter((m) => m.id === solucao || m.text === solucao)
    : menu

  // Telas-folha agrupadas por solução, limitadas a `perSolucao`.
  const porSolucao = solucoes.map((s) => ({
    solucao: s.text,
    leaves: leavesOf(s).slice(0, perSolucao),
  }))

  // Intercala soluções (round-robin) para variar as sugestões.
  const out: DaiSuggestion[] = []
  let i = 0
  while (out.length < max && porSolucao.some((s) => s.leaves[i])) {
    for (const grp of porSolucao) {
      const leaf = grp.leaves[i]
      if (leaf?.spec) {
        out.push({
          id: leaf.id,
          text: leaf.text,
          icon: leaf.icon,
          spec: leaf.spec,
          solucao: grp.solucao,
        })
        if (out.length >= max) break
      }
    }
    i++
  }
  return out
}

/** Tela navegável que a DIA pode abrir (component_key + rótulo + solução de origem). */
export interface AvailableScreen {
  component_key: string
  title: string
  solution: string
}

/**
 * Lista TODAS as telas nativas (kind 'component') que o usuário pode abrir,
 * derivadas do menu já filtrado por permissão. É o allowlist enviado à DIA:
 * o agente só pode propor abrir uma dessas — e o backend revalida.
 */
export function availableScreensFromMenu(menu: MenuItem[]): AvailableScreen[] {
  const out: AvailableScreen[] = []
  const seen = new Set<string>()
  for (const solucao of menu) {
    for (const leaf of leavesOf(solucao)) {
      const key = leaf.spec?.componentKey
      if (!key || leaf.spec?.kind !== 'component' || seen.has(key)) continue
      seen.add(key)
      out.push({ component_key: key, title: leaf.text, solution: solucao.text })
    }
  }
  return out
}
