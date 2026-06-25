# Alinhar CRUDs do PortalDMS aos padrões corporativos (grid completo + RHF/Zod + BFF v2)

> **Data de aprovação:** 2026-06-11
> **Versão:** v0.1
> **Status:** Aprovado

## Contexto

O usuário pediu auditoria das telas CRUD do PortalDMS contra o **Boilerplate corporativo** (`SKILLS-GX\Boilerplate`) e a **spec de grid aprovada** (`DealernetCRM\docs\design\11-padrao-grid-filtros.md`, v0.1 2026-06-08). A auditoria encontrou gaps: colunas sem tipagem (.num/.col-code/alinhamento), sem ordenação/filtro por coluna, sem paginação, form sem RHF+Zod, **inativação sem confirmação** (gap de UX/segurança), sem persistência de estado do grid, e o BFF sem paginação/filtros server-side. O usuário escolheu **alinhamento completo já** (incl. evolução do BFF) e **adotar RHF+Zod agora**. A edição em drawer lateral foi validada (padrão de mercado + prevista na spec interna) e será mantida.

**Decisão de contrato (pragmática p/ GeneXus):** NÃO usar `filter[col]=op:val` dinâmico no BFF (inviável em GX REST). Contrato = **parms tipados** (`Page/Size/Sort/Busca/FiltroAtivo[/FiltroX]`); o formato da spec (`filters:{col:"op:val"}`) vive no front/persistência e um adapter traduz.

## Fase 1 — Front client-side (independe do BFF; telas continuam funcionando)

**Deps novas** (PortalDMS): `@tanstack/react-table@8`, `react-hook-form@7`, `zod@4`, `@hookform/resolvers@5`, `@radix-ui/react-popover`, `@radix-ui/react-checkbox`, `@radix-ui/react-alert-dialog`. (SEM TanStack Query/Router; sem date-picker — nenhuma entidade tem coluna data.)

**Novos arquivos** em `src/portal/components/datatable/`:
- `types.ts` — `DnColumn<T>` `{key,label,tipo:'texto'|'numero'|'codigo'|'badge'|'data'|'bool',filtravel?,ordenavel?,visivelDefault?,enumOptions?,width?,serverParam?}`; `GridState` (v:1, sort, page/size, filters{col:"op:val"}, busca, columns{order,hidden}); `ListQuery`/`ListResult<T>` (`total?:number`, `serverPaged` derivado).
- `DataTable.tsx` (TanStack headless; converte DnColumn→ColumnDef; colunas fixas Situação/Ações; estado controlado pelo GridState; linha 40px, header sticky, `.num` direita+tabular-nums, `.col-code` mono)
- `ColumnHeader.tsx` (sort + popover de filtro), `Toolbar.tsx` (busca global atalho `/`, seletor de colunas via dropdown-menu existente, limpar filtros), `Pagination.tsx`, `TableSkeleton.tsx`
- `filters/FilterText.tsx` (contains, debounce 300ms), `FilterEnum.tsx` (multi-select in), `FilterNumberRange.tsx` (client), `FilterBool.tsx` (toggle 3 estados, client)
- `useGridState.ts` (persistência debounced; fase 1 = localStorage), `useDataTableQuery.ts` (motor híbrido)
- `src/portal/components/ui/ConfirmDialog.tsx` (Radix AlertDialog)
- `src/portal/lib/gridStateApi.ts` (BFF + fallback localStorage; chave `PORTAL_DMS_<Tela>_GridState`)

**Modo híbrido por detecção**: resposta sem `total` → client-side (TanStack getSorted/Filtered/PaginationRowModel sobre fetch único); com `total` → manual* + refetch (busca/sort/filtros com `serverParam`/page) e filtros sem serverParam refinam a página client (spec §2). `forceClientMode` opcional por tela.

**Refactor `CrudCadastro.tsx`**: tabela→DataTable (prop `screenKey`); `CrudField` ganha `required/min/max/type:'text'|'number'|'email'|'select'/options`; `buildZodSchema(campos)` deriva o schema; `useForm({resolver:zodResolver})` com erro inline; ConfirmDialog antes de inativar (reativar não confirma); atalho `/`. Atualizar as 5 telas finas + **migrar CadastroCargo para o genérico** (adicionar `cargo` nas factories `crudReal`/`crudMock`; deprecar listCargos/saveCargo/etc.).

**`crudReal`/`crudMock`** passam a aceitar `ListQuery` e devolver `ListResult` (fase 1: real ignora query, retorna `{data, serverPaged:false}`; mock idem).

**Sem URL-sync** (desvio documentado da spec): MDI sem rota própria; persistência só por chave.

## Fase 2 — BFF v2 (pode rodar em paralelo)

- `Temp\build-portal-crud-v2.ps1` (base no v1; **MESMOS seeds DetGuid** → reimport=UPDATE; SDTs inalterados): PRC_Portal_XList com `parm(in:&Page,in:&Size,in:&Sort,in:&Busca,in:&FiltroAtivo[,in:&FiltroX], out:&autenticado,out:&total,out:&SDT_PortalX)`; Size clamp ≤200 default 50; total com as mesmas wheres; página com `skip/count` + `order <att> when &Sort='col:dir'` (parênteses=desc); busca `like '%x%' when not empty`; filtro CSV→`in` via coleção. Estender `New-Var` com kinds `num`/`vchar`. API ganha os in:/out: no método list.
- `Temp\build-portal-gridstate.ps1` (one-off): PRC_Portal_GridStateGet/Save sobre BC `UserCustomizations` (JÁ é BC na KB; padrão do `LoadUserKeyValue.xml`) com **gate `StartsWith('PORTAL_')`** (segurança); API_Portal_GridState rota `portal/gridstate` GET get/POST save + Events 401.
- Gerar 7 pacotes (6 entidades + GridState). **Validar GUIDs idênticos ao v1** antes de entregar.

**Usuário na IDE**: importar GridState, reimportar os 6 (conferir UPDATE no diálogo), Build (sem reorg), conferir YAMLs, publicar.

## Fase 3 — Ligar modo server no front

`crudReal.list` monta query real (Page/Size/Sort/Busca/Filtro* + mapa serverParam) e lê `total`; `gridStateApi` aponta p/ `/gridstate`; mock simula paginação; marcar `serverParam` nas colunas (`FiltroAtivo` em todas; `FiltroTipoAcesso` Usuario; `FiltroTipo` PerfilAcesso).

## Riscos
- `order...when` + `skip/count` juntos no specifier (baixo; fallback: Do case com For eaches dedicados).
- Case dos query params GX (`Page`, não `page`) — adapter centraliza.
- Duas janelas MDI mesma tela → last-write-wins no GridState (documentado).
- `like '%x%'` = scan; ok p/ tabelas de cadastro (pequenas).

## Verificação
1. `npm run build` + lint verdes (PortalDMS).
2. Smoke BFF com cookie: list v2 (paginação/sort/busca/FiltroAtivo/Size clamp), gridstate round-trip + rejeição de chave sem `PORTAL_`, 401 sem sessão.
3. Manual nas 6 telas (mock e real): CRUD completo, validação Zod inline, ConfirmDialog no inativar, filtros por tipo, sort, ocultar coluna, paginação, `/`, fechar/reabrir janela restaura estado, "limpar filtros" no vazio, skeleton sem flash.
4. Estado persiste cross-browser (mesmo usuário) e cai p/ localStorage com BFF fora.
5. Gate `frontend-review-gate` antes de marcar done.

## Arquivos críticos
- `PortalDMS\src\portal\renderers\screens\CrudCadastro.tsx` (refactor central)
- `PortalDMS\src\portal\lib\portalApiReal.ts` / `portalApi.ts` (ListQuery/ListResult, cargo, gridStateApi)
- `PortalDMS\src\portal\components\datatable\*` (novo)
- `DealernetHubIntegration\Temp\build-portal-crud-v2.ps1` + `build-portal-gridstate.ps1` (novos geradores)
- Spec normativa: `DealernetCRM\docs\design\11-padrao-grid-filtros.md`
- Molde GridState: `DealernetHubIntegration\ObjetosDaKbEmXml\Procedure\LoadUserKeyValue.xml`
