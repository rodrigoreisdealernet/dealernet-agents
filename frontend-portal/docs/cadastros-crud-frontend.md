# Telas de Cadastro (CRUD) — Portal DMS Front

**Status:** proposta para aprovação · **Data:** 2026-06-10
**Projeto:** `portal-dms` (Portal DMS = Dealernet Multi Solution)
**Raiz:** `C:\Dealernet\Genexus\VS_Code\PortalDMS` (Vite + React + TypeScript)
**Relacionado:** `docs/portal-mdi-arquitetura.md` (casca MDI, renderers, contratos `/api/v1`)

> **Escopo deste doc:** as telas de **cadastro (CRUD)** que rodam como janelas
> `kind: component` (telas nativas) dentro do shell MDI. Documenta o **estado atual**
> (apenas Cargo pronto), o **padrão de tela** a replicar e o **backlog priorizado** dos
> cadastros faltantes — incluindo a tela complexa `CadastroUsuario` (5 abas).

Arquivos-chave inspecionados:
- `src\portal\lib\portalApiReal.ts` — camada REST real (BFFs `API_Portal_*` da KB DealernetHubIntegration)
- `src\portal\lib\portalApi.ts` — switch mock/real + mocks em `localStorage`
- `src\portal\renderers\registry.ts` — registry `componentKey -> componente lazy`
- `src\portal\renderers\screens\CadastroCargo.tsx`, `AlterarSenha.tsx`
- `src\portal\types.ts` — tipos centrais
- `.env` / `.env.example`

---

## 0. Padrão de layout: drawer lateral vs. tela cheia (REGRA)

> Fonte normativa: `DealernetHubIntegration/docs/design/16-padrao-telas-cadastro.md`.

O layout de edição é definido por **3 fatores** — basta UM disparar tela cheia:

| Fator | Drawer (320px) | Tela cheia (com abas) |
|---|---|---|
| Nº de campos editáveis | ≤ 4 | **≥ 5** |
| Tem ≥1 combo de FK (busca outra entidade) | não | **sim** |
| Tem agrupamento por abas/seções | não | **sim** |

**Regra:** tela cheia se `campos ≥ 5` **OU** `tem combo de FK` **OU** `tem abas`; senão drawer.

- **Drawer:** Cargo, Departamento, Grupo de Empresa, Perfil de Acesso, Empresa.
- **Tela cheia:** Usuário (6+ campos, combos Empresa/Equipe, abas Dados/Empresa/Telefone).

**Campo FK = combo, nunca input de código.** Atributo que é FK (Empresa/Equipe/Cargo) ou
domínio enum (TipoAcesso/Idioma) vira dropdown que mostra a descrição e grava o código.
Origem das opções: enum fixo no front, ou `/list` da API CRUD da entidade
(`API_Portal_Empresa`/`_Cargo`/`_Equipe`). Componente `ComboField` (carga async + cache
por `cacheKey` + valor-órfão + `searchable` p/ listas grandes como Empresa).

---

## 1. Estado atual

### 1.1 CRUD de Cargo funcionando contra API real

- Tela `CadastroCargo.tsx` (`componentKey: 'portal-cargo'`), registrada em `registry.ts`.
- Consome `portalApi` (que resolve para `portalApiReal` quando `VITE_USE_REAL_API=true`).
- Endpoints reais já mapeados em `portalApiReal.ts` contra `API_Portal_Cargo` (BFF GeneXus):

| Método front | Verbo / rota | Payload / retorno |
|--------------|--------------|-------------------|
| `listCargos` | `GET /cargo/list` | `SDT_PortalCargo[]` |
| `getCargo` | `GET /cargo/get?Cargo_Codigo=` | `Item[]` (0 ou 1 elemento) |
| `saveCargo` | `POST /cargo/save` | body `{ CargoItem: [item] }` — `Codigo 0` = inclusão; `>0` = alteração |
| `deleteCargo` | `DELETE /cargo/delete?Cargo_Codigo=` | soft delete (inativa) |

- Mock equivalente em `portalApi.ts` (semente em `localStorage`), com a **mesma assinatura**.
- É o **único CRUD nativo** existente — serve de molde para todos os próximos.

### 1.2 Camada de API com switch mock/real

- Em `portalApi.ts` (linha final): `const USE_REAL = import.meta.env.VITE_USE_REAL_API === 'true'`
  → `export const portalApi = USE_REAL ? portalApiReal : portalApiMock`.
- O **contrato (assinaturas) é idêntico** nas duas camadas; trocar de mock para real
  **não exige mexer nas telas**.
- `portalApiReal.req<T>()`: `fetch` com `credentials:'include'` (sessão por cookie HttpOnly),
  base `VITE_API_BASE` (default `/DealernetHubIntegrationNETCoreSQL/api/v1/portal`).
  Trata `401`/`400` com corpo JSON como **resposta de NEGÓCIO** (não erro técnico);
  `NetworkError` só quando **não há corpo parseável**.

### 1.3 Injeção de menu EXTRA_MENU (DEV)

- Em `portalApiReal.getMenu()`, quando `VITE_MOCK_MENU_EXTRA === 'true'`, injeta `EXTRA_MENU`
  (grupo "Cadastros" → "Cargos") **antes** da árvore vinda da SP do backend.
- Permite abrir telas nativas novas **antes** de a SP de menu publicá-las. Removível sem
  impacto em produção.
- O mock (`portalApi.ts`) já traz o mesmo item "Cargos" dentro de `MOCK_MENU`.

### 1.4 Menu real vindo do backend

- `getMenu` → `GET /menu/menus`: 1 entrada por produto (`SDT_PortalMenu`), cada uma com a
  árvore pronta da SP em `menuJson` (formato DVelop, recursivo via `subItems`).
- `buildMenuTree` / `spNodeToItem` traduzem para `MenuItem`; `PRODUTO_LABEL` rotula os
  módulos do DMS. (Detalhe da SP em `portal-mdi-arquitetura.md` §5.1.)

### 1.5 Sessão / config / empresas / workspaces (real)

- `auth` → `POST /identity/auth`; `logout` → `POST /identity/logout`.
- `getConfig` → `GET /config/config`; `getEmpresas` → `GET /identity/me` (EmpresaItems).
- `setEmpresa` e `alterarSenha` ainda são **placeholders** no real (endpoints não gerados
  na KB) — `alterarSenha` retorna `{ ok:false, mensagem:'Alteração de senha indisponível no momento.' }`.
- Workspaces: **CRUD real** (`/workspace/list|get|save|delete`); mock usa `localStorage`.

### 1.6 Telas existentes

| Tela | `componentKey` | Situação |
|------|----------------|----------|
| `CadastroCargo.tsx` | `portal-cargo` | **Único CRUD nativo** — pronto contra API real |
| `AlterarSenha.tsx` | `portal-alterar-senha` | Utilitária; validação client-side; depende de `portalApi.alterarSenha` (hoje placeholder no real) |
| `DemoFunil` | `demo-funil` | Demo |

### 1.7 .env (dev atual)

```
VITE_API_TARGET=http://localhost:8082
VITE_API_BASE=/DealernetHubIntegrationNETCoreSQL/api/v1/portal
VITE_USE_REAL_API=true
VITE_MOCK_MENU_EXTRA=true
```

---

## 2. Padrão de tela CRUD (modelo = `CadastroCargo`)

Layout e mecânica a replicar nos próximos cadastros simples.

### 2.1 Estrutura visual

- **Container** `flex h-full flex-col bg-background`; **header** com ícone (lucide),
  título/subtítulo e botão "Novo".
- **Faixas de feedback** no topo: `okMsg` (sucesso) e `erro` (lista).
- **Lista**:
  - busca client-side (`<input>` com ícone `Search`, filtro por
    `descricao.toLowerCase().includes(...)`);
  - estados `loading` (`Loader2` spin) / vazio / `<table>` com colunas
    **Código, Descrição, Situação** (badge Ativo/Inativo), **Ações**.
- **Ações por linha**: Editar (`Pencil`) e alternar ativo (`Power` inativar /
  `RotateCcw` reativar) — `opacity-60` nas linhas inativas.
- **Form lateral** (`<aside className="w-80 border-l">`), aberto quando `form !== null`:
  - `codigo === 0` = inclusão, `> 0` = edição;
  - valida campos obrigatórios;
  - `salvar` chama `portalApi.saveX` e recarrega a lista.

### 2.2 Soft delete

- `alternarAtivo`: se o registro está **ativo** chama `deleteX` (inativa); se **inativo**
  chama `saveX({ ...c, ativo:true })` (reativa).
- **Sem hard delete.**

### 2.3 Estado React (por tela)

`lista`, `loading`, `erro`, `busca`, `form | null`, `salvando`, `erroForm`, `okMsg`.

### 2.4 Receita para cada CRUD novo

Para cada cadastro novo, sempre os mesmos 5 pontos de toque:

1. adicionar **tipo** em `types.ts`;
2. adicionar métodos `list/get/save/delete` em `portalApiReal.ts`
   (**+ mock equivalente** em `portalApi.ts`, mesma assinatura);
3. criar a **tela** em `renderers/screens`;
4. registrar a entrada em `registry.ts` (`componentKey -> componente lazy`);
5. adicionar o item em `EXTRA_MENU` (e em `MOCK_MENU`).

---

## 3. Backlog priorizado

> **Dependência transversal:** os CRUDs simples dependem dos BFFs `API_Portal_*` na KB
> **DealernetHubIntegration**. **Antes de religar o real**, checar se os endpoints/SDTs já
> existem (OpenAPI dos `API_Portal_*`).

### P0 — CRUDs simples (cópia direta do padrão Cargo)

Esforço baixo e repetível — bom para padronizar antes da tela complexa.

| # | Cadastro | `componentKey` | Tipo | Métodos real/mock |
|---|----------|----------------|------|-------------------|
| 1 | **Departamento** | `portal-departamento` | `Departamento` | `listDepartamentos / getDepartamento / saveDepartamento / deleteDepartamento` |
| 2 | **GrupoEmpresa** | `portal-grupo-empresa` | `GrupoEmpresa` | análogo (`list/get/save/delete`) |
| 3 | **PerfilAcesso** | `portal-perfil-acesso` | `PerfilAcesso` | análogo (`list/get/save/delete`) |
| 4 | **Empresa** | `portal-empresa` | `Empresa` (CRUD) | análogo — **validar contrato do BFF** |

- Cada item segue a receita §2.4 (tipo + métodos real/mock + tela + registry + EXTRA_MENU/MOCK_MENU).
- **Empresa** hoje existe **apenas como tipo de listagem/seletor** (em `getEmpresas`);
  como CRUD provavelmente terá **mais campos que descrição + ativo** — validar o contrato
  do BFF antes de assumir o molde simples.

### P1 — `CadastroUsuario` (tela complexa, 5 abas)

Não existe **nenhuma base**; é o **maior item** do backlog.

| Aba | Conteúdo | Observações |
|-----|----------|-------------|
| 1 — **Dados** | Campos do usuário + **toggle "ADM" condicional** | exibido/habilitado conforme regra; quando ADM, comportamento/permissões diferentes |
| 2 — **Senha provisória** | Definição de senha provisória | fluxo **distinto** do `AlterarSenha` existente; provavelmente **novo endpoint** no BFF de Usuario (hoje `alterarSenha` real é placeholder) |
| 3 — **Empresas (N:N)** | Associação usuário ↔ empresas | multi-seleção / lista de vínculos |
| 4 — **Perfis (N:N)** | Associação usuário ↔ perfis de acesso | **depende** do CRUD PerfilAcesso (P0 item 3) |
| 5 — **Grupos (N:N)** | Associação usuário ↔ grupos de empresa | **depende** do CRUD GrupoEmpresa (P0 item 2) |

Implica:
- tipo `Usuario` com **coleções N:N**;
- métodos BFF de Usuario (`list/get/save` + sub-recursos de vínculo);
- componente com **navegação por abas** — **não há componente de Tabs no acervo atual**
  (criar ou reusar);
- **validação condicional** do toggle ADM.

**Dependências:** idealmente construir **após** os CRUDs de PerfilAcesso, GrupoEmpresa e
Empresa (abas 3–5 referenciam essas entidades).

### P2 — Pendências transversais

- Religar `alterarSenha` real quando a KB expuser o endpoint (hoje placeholder); idem
  `setEmpresa` (`/empresa/atual`).
- Quando as SPs de menu publicarem os novos cadastros, **remover** os itens de `EXTRA_MENU`
  e **desligar** `VITE_MOCK_MENU_EXTRA`.
- Não há `AGENTS.md` / `CLAUDE.md` na raiz do PortalDMS nem descrição das 5 entidades nos
  docs (`portal-mdi-arquitetura.md`); os **contratos virão dos OpenAPI `API_Portal_*`** da
  KB DealernetHubIntegration.

---

## 4. Resumo da ordem de execução

1. **P0.1–P0.3** (Departamento, GrupoEmpresa, PerfilAcesso) — cópia direta do padrão Cargo.
2. **P0.4** (Empresa) — validar contrato do BFF (campos extras).
3. **P1** (`CadastroUsuario`) — depois das entidades referenciadas nas abas 3–5; criar
   componente de Tabs.
4. **P2** — religar placeholders e limpar o menu DEV quando o backend publicar.
