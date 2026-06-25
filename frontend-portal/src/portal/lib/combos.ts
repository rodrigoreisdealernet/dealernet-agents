// Combos reutilizáveis das telas de cadastro. Centraliza:
//  - comboDominio(nome): opções de um domínio enum vindas da API de domínios da KB (dinâmico, cacheado).
//  - combos de FK (Empresa/GrupoEmpresa/Equipe/Cargo/Setor) que consomem o /list da entidade.
//  - comboPessoa: busca server-side (typeahead) — tabela grande, NÃO carrega tudo.
// ComboSource é o contrato consumido por ComboField (ui/ComboField.tsx).

import type { ComboSource } from '@/portal/types'
import { portalApi } from '@/portal/lib/portalApi'

/** Combo de domínio enum (badge/select). Opções vêm de GET dominio/list?Nome=<dom> (cacheado lá). */
export function comboDominio(nome: string): ComboSource {
  return {
    cacheKey: `dominio-${nome}`,
    load: () => portalApi.buscarDominio(nome),
  }
}

/** FK que consome o /list de uma entidade de cadastro. value=código, label=descrição. */
function comboFk<T extends { codigo: number; ativo: boolean }>(
  cacheKey: string,
  list: (q?: { page: number; size: number }) => Promise<{ data: T[] }>,
  rotulo: (t: T) => string,
  searchable = false,
): ComboSource {
  return {
    cacheKey,
    searchable,
    load: async () =>
      (await list({ page: 1, size: 1000 })).data.filter((t) => t.ativo).map((t) => ({ value: String(t.codigo), label: rotulo(t) })),
  }
}

export const comboEmpresa = comboFk(
  'fk-empresa',
  portalApi.cadastros.empresa.list,
  (e) => `${e.codigo} — ${e.nomeFantasia}`,
  true,
)
export const comboGrupoEmpresa = comboFk('fk-grupoempresa', portalApi.cadastros.grupoEmpresa.list, (g) => g.nome)
export const comboEquipe = comboFk('fk-equipe', portalApi.cadastros.equipe.list, (e) => e.descricao)
export const comboCargo = comboFk('fk-cargo', portalApi.cadastros.cargo.list, (c) => c.descricao)
export const comboSetor = comboFk('fk-setor', portalApi.cadastros.setorServico.list, (s) => s.descricao)

// Pessoa (tabela grande) NÃO usa combo — usa BuscaModalField (modal de busca server-side).
// Ver buscarPessoaItens nas telas CadastroUsuario/CadastroEmpresa.
