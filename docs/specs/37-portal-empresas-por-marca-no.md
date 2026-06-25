# Spec #37: Seletor de Empresas por Marca, Renomeação de Menus e Reclassificação

## Overview

Três ajustes independentes no shell do Portal DMS (`frontend-portal`) descobertos em teste ao vivo. A primeira e principal trata do seletor de empresas no header: migrar do mock hardcoded (`MOCK_EMPRESAS`) para as empresas reais da view `v_dia_company_current`, agrupadas por `brand_name` (em vez de `grupo`). As outras duas são renomeações de rótulos de menu e reclassificação de itens administrativos.

## Problema / Contexto

Após a associação empresa↔marca estabelecida em #31, o seletor de empresa no header continua usando uma lista fictícia agrupada por um campo de `grupo` que não corresponde aos dados reais. Para coerência com os dados vivos:

- O seletor precisa ler empresas de `v_dia_company_current` (via `getCompanies()` em `agentsApi.ts`, com colunas `name`, `brand_id`, `brand_name`).
- O agrupamento hierárquico no dropdown deve ser por `brand_name` (não por `grupo`).
- Empresas sem marca associada devem cair num bloco "Sem marca".
- A mudança de empresa via selector (ação `changeEmpresa`) continua funcionando com o mesmo mecanismo.

Adicionalmente, os rótulos "Estoque de Veículos" e "Estoque de Peças" no menu Concessionária são verbosos; a navegação esperada encurtou-os para "Veículos" e "Peças". E os itens "Empresas" e "Marcas", sendo dados mestres, devem ficar no grupo Administração (junto de Usuários), não em Concessionária.

## Critérios de Aceite

- [ ] O dropdown de empresas no header, ao abrir, exibe as empresas vivas lidas de `v_dia_company_current`, não mais `MOCK_EMPRESAS`.
- [ ] As empresas no dropdown são agrupadas por `brand_name` (ex.: "GM", "FIAT"), com seções separadas; empresas sem marca aparecem numa seção "Sem marca" / "Outras".
- [ ] Ao selecionar uma empresa no dropdown, a ação `changeEmpresa(id)` é disparada e o estado `empresaAtualId` é atualizado sem regressões.
- [ ] O menu Concessionária mostra "Veículos" (não "Estoque de Veículos") e "Peças" (não "Estoque de Peças"); os titles das janelas abertas acompanham.
- [ ] Os itens "Empresas" e "Marcas" aparecem no menu Administração (seção com `requiredRole: 'admin'`), não mais em Concessionária.
- [ ] As telas Empresas e Marcas continuam abrindo normalmente pelos novos caminhos no menu Administração; o CRUD continua intacto.

## Não-Goals

- Mudança do backend real (menu via `SP_PortalDMS_Menu`, endpoint dedicado do GeneXus). Esta issue cobre o modo mock/local; alinhar o menu real é follow-up.
- Persistência automática da empresa ativa entre sessões (fora do que já existe com `persist` do Zustand).
- Redesenho visual do dropdown ou dos itens de menu.

## Out-of-Scope

- Telas de Empresas e Marcas (CRUD) — continuam como estão; mudança é só de navegação.
- Backend API (`portalApiReal.ts`, `agentsApi.ts` para leitura real) — já existem funções prontas.
- Validações de acesso por role em Empresas/Marcas (já herdadas do grupo Administração).

---

**STATUS: DRAFT — Aguardando aprovação antes de qualquer escrita de código.**
