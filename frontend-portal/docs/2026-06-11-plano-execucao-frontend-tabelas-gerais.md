# Plano de execução Frontend — Tabelas Gerais (7 cadastros novos)

- **Data:** 2026-06-11 · **Versão:** v0.1 · **Status:** proposta para aprovação
- **Pré-requisito:** import dos 7 pacotes TRN no DHI (ver
  `DealernetWorkflow\docs\relatorios\2026-06-11-resumo-noturno-pacotes.md`) e, em seguida,
  os BFFs lean v3 por entidade na KB DHI.
- **Padrões normativos (não divergir):** `CLAUDE.md` deste repo; `cadastros-crud-frontend.md`
  (receita §2.4); doc 16 da DHI (drawer×tela cheia); BFF lean v3 (`SDT + List + Save + API`,
  envelope `SDT_DHI_ApiResponse`, sem Get/Delete, soft delete via `save({...row, ativo:false})`);
  grid `DataTable` corporativo; FK/enum **sempre** `ComboField`; tokens light/dark (sem cor hardcoded).

## 0. Dependência: BFF lean por entidade (KB DHI, antes do front)

Para cada entidade: `SDT_<X>` + `PRC_Portal_<X>List` + `PRC_Portal_<X>Save` + `API_Portal_<X>`
(4 objetos, padrão lean v3). Toda API valida sessão (WWPContext → 401) e aplica filtros
server-side. TRN precisa de **BC=True** (marcar na IDE pós-import).

Decisões de negócio por entidade no BFF:
- **MotAusencia / TipoDepartamento / Feriado**: têm `Ativo` → soft delete padrão.
- **Ausencia / ServerPrint / Impressao**: NÃO têm coluna `Ativo` → definir semântica de
  exclusão (sem delete no lean; se precisar, decisão explícita).
- **Ausencia**: replicar no PRC Save o histórico (`AusenciaHistorico`) e avaliar a validação
  de bolsão da Oficina (regras da EV2 que ficaram fora da TRN).
- **Feriado**: Save deve tratar o segundo nível (FeriadoEmpresa — vínculos N:N com Empresa).

## 1. Classificação das telas (regra doc 16: drawer ≤4 campos simples; tela cheia se ≥5 OU FK OU abas)

| # | Tela | Layout | Campos editáveis | Combos |
|---|---|---|---|---|
| 1 | TipoDepartamento | **Drawer** | Descricao, Ativo | — |
| 2 | Servico | **Drawer** | Sigla (enum), Descricao | enum fixo `ServicoSigla` |
| 3 | MotAusencia | **Tela cheia** (≥5 campos) | Descricao, Tipo (enum), Ativo, LiberaLoginSistema + demais flags | enum `MotAusenciaTipo` |
| 4 | Ausencia | **Tela cheia** (FK) | Usuario (FK), MotAusencia (FK), DataInicial, DataFinal | `ComboField` Usuario (`/usuario/list`, searchable) + MotAusencia (`/motausencia/list`) |
| 5 | Feriado | **Tela cheia** (abas) | Aba Dados: Nome, Data, Fixo, Ativo · Aba Empresas: vínculos N:N | `ComboField` Empresa (searchable, cache) na aba 2 |
| 6 | ServerPrint | **Tela cheia** (FK + upload) | Empresa (FK), Arquivo (upload blob), CaminhoImpressora, TipoImpressao (enum), Parametros | Empresa + enum `TipoImpressao` |
| 7 | Impressao | **Tela cheia** (FK) | Empresa (FK), Usuario (FK), NaturezaOperacaoCod, TipoOSCod, CondicaoPagamentoCod, Tipo (enum), CaminhoImpressora | Empresa, Usuario + enum; NatOperacao/TipoOS/CondPagamento SEM TRN no DHI → **input numérico com label "código"** nesta fase (combo quando as entidades migrarem) |

> Exceção consciente em Impressao: a regra "FK = combo, nunca input de código" fica suspensa
> para NaturezaOperacao/TipoOS/CondicaoPagamento porque as entidades ainda não existem no DHI
> (sem `/list` para alimentar o combo). Registrar TODO no código e promover a combo quando migrar.

## 2. Receita por tela (5 pontos de toque — `cadastros-crud-frontend.md` §2.4)

Para CADA cadastro: 1) tipo em `src/portal/types.ts` · 2) métodos `list/save` (+ soft delete
quando houver `Ativo`) em `portalApiReal.ts` **+ mock de mesma assinatura** em `portalApi.ts` ·
3) tela em `src/portal/renderers/screens/` usando o shell `CrudCadastro` (drawer) ou layout de
tela cheia (molde Usuario) · 4) registro em `registry.ts` (`componentKey` lazy) ·
5) item em `EXTRA_MENU` + `MOCK_MENU`.

`componentKey` propostos: `portal-tipo-departamento`, `portal-servico`, `portal-mot-ausencia`,
`portal-ausencia`, `portal-feriado`, `portal-server-print`, `portal-impressao`.

Grupos de menu (espelhando o menu DWF): Segurança → Feriado, Motivo Ausência, Ausência;
Empresarial → Tipo Departamento, Serviço, Server Print, Impressão.

## 3. Ordem de execução (espelha valor + dependências)

| Fase | Telas | Racional |
|---|---|---|
| F1 | TipoDepartamento, Servico | Drawers — cópia direta do molde Cargo, valida BFFs novos rápido |
| F2 | MotAusencia | Tela cheia simples (sem FK) — molde p/ F3 |
| F3 | Ausencia | Depende do combo de MotAusencia (F2) e Usuario (já existe) |
| F4 | Feriado | Abas + N:N Empresa — reusa padrão de abas do CadastroUsuario |
| F5 | ServerPrint, Impressao | Mais complexas (upload blob / códigos sem FK) |

Cada fase fecha com `npm run build` (gate de tipo) + teste manual mock e real
(`VITE_USE_REAL_API`) + commit (política: commit ao fim de cada entrega).

## 4. Fora de escopo desta frente

- FechamentoContabil (excluído pelo usuário) e Estoque/Identificador (updates T6/T7 pendentes de aprovação).
- Telas de Parâmetros (aguardam retrofit das TRNs — ver classificação em
  `DealernetWorkflow\docs\relatorios\2026-06-11-parametros-classificacao.md`).
- Remoção do `EXTRA_MENU`/`VITE_MOCK_MENU_EXTRA` quando a SP `SP_PortalDMS_Menu` publicar os itens novos.
