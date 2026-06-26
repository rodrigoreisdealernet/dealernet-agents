// Filtro de busca do menu lateral. Casa nome do item E do grupo, ignorando
// acentos e maiúsc/minúsc. Se o grupo casa, mantém todos os filhos; senão,
// mantém só os filhos que casam (e descarta grupos sem nenhum match).

import type { MenuItem } from '@/portal/types'

/** Normaliza para comparação: minúsculas + sem acentos. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/**
 * Filtra a árvore de menu por um termo, em PROFUNDIDADE (N níveis). Não muta.
 * - termo vazio → retorna o menu original.
 * - nó cujo texto casa → mantido com TODA a sua subárvore (mostra o que há dentro).
 * - nó que não casa → mantido apenas se algum descendente casar, e só com os
 *   ramos que levam a um match (preserva o caminho pai → ... → folha).
 * - folha (sem children) → mantida só se o texto casar.
 */
export function filterMenu(menu: MenuItem[], term: string): MenuItem[] {
  const q = normalize(term)
  if (!q) return menu
  return filterNodes(menu, q)
}

function filterNodes(nodes: MenuItem[], q: string): MenuItem[] {
  const result: MenuItem[] = []
  for (const node of nodes) {
    const selfMatches = normalize(node.text).includes(q)
    const children = node.children ?? []

    if (!children.length) {
      // Folha (ou atalho de topo sem filhos): entra só se casar.
      if (selfMatches) result.push(node)
      continue
    }

    if (selfMatches) {
      // O grupo casa: mantém a subárvore inteira.
      result.push(node)
    } else {
      // Não casa: desce e mantém apenas os ramos com algum match.
      const matchedChildren = filterNodes(children, q)
      if (matchedChildren.length) result.push({ ...node, children: matchedChildren })
    }
  }
  return result
}

/**
 * Remove (em profundidade) itens cujo `requiredRole` o usuário corrente não atende
 * ou que estejam marcados como `hidden`. Regra simples da POC: só `admin` satisfaz
 * `requiredRole === 'admin'`; itens sem requiredRole são visíveis a todos. Itens
 * `hidden` nunca aparecem (a tela segue acessível por componentKey). Grupos que
 * ficam sem filhos são descartados.
 */
export function filterMenuByRole(menu: MenuItem[], role: string | null): MenuItem[] {
  return menu
    .filter((node) => !node.hidden && (!node.requiredRole || node.requiredRole === role))
    .map((node) =>
      node.children ? { ...node, children: filterMenuByRole(node.children, role) } : node,
    )
    .filter((node) => !node.children || node.children.length > 0 || !!node.spec)
}

/** Total de itens-folha (telas) na árvore, em PROFUNDIDADE — para mensagens de resultado. */
export function countLeaves(menu: MenuItem[]): number {
  let n = 0
  for (const node of menu) {
    if (node.children?.length) n += countLeaves(node.children)
    else if (node.spec) n += 1
  }
  return n
}
