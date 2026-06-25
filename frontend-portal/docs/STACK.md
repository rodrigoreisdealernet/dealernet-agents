# Stack do Projeto — Portal DMS (Dealernet Multi Solution)

> **Status:** Vivo · **Data:** 2026-06-12 · **Dono:** DealernetHubIntegration (DHI)
> Documento canônico da stack tecnológica do Portal DMS. **Espelhado** nas pastas `docs/` de
> DealernetHubIntegration, PortalDMS, DealernetCRM, DealernetProdutos e DealernetFrontEnd —
> manter sincronizado (a fonte é a DHI). Levantado dos arquivos reais (package.json, model.ini,
> appsettings.json, vite.config, geradores).

## Arquitetura geral

```
┌──────────────────────────────────────────────────────────────┐
│  FRONT-END (SPA React)          PortalDMS  :5174              │
│  shell MDI (janelas) + telas nativas CRUD + DAI (assistente)  │
│  └─ iframe ?embed=1 → DealernetFrontEnd (telas do mód. Compras)│
└────────────────────────┬─────────────────────────────────────┘
                        │ proxy Vite (cookie HttpOnly, MESMA origem)
                        │ /DealernetHubIntegrationNETCoreSQL/api/v1/portal
┌────────────────────────▼─────────────────────────────────────┐
│  BFF REST (GeneXus 18 → .NET Core)   app  :8082               │
│  API objects + PRC (padrão lean: List/Save + SDT_ApiResponse) │
└────────────────────────┬─────────────────────────────────────┘
                        │ ADO.NET
┌────────────────────────▼─────────────────────────────────────┐
│  SQL Server (.\SQL2022) — banco Dealernetworkflow (ERP)       │
└───────────────────────────────────────────────────────────────┘
```

Três camadas, mesma origem (cookie de sessão flui pelo proxy). O Portal DMS é o **shell** que
consome a identidade/dados da KB DHI (provedora de identidade do Portal Único).

## Domínios e fronteiras por KB (decisão 2026-06-11)

| KB | Domínio |
|---|---|
| **DealernetHubIntegration (DHI)** | **Tabelas gerais e segurança** (Usuario, Empresa, Cargo, Perfil, Grupo, Menu...), identidade do Portal (login/sessão/menu) e **integrações com montadoras e parceiros** |
| **DealernetProdutos** | Tudo de **peças e compras**: requisição, pedido, cotação, fornecedores de material, estoque de peças |
| **DealernetCRM** | Funil comercial / CRM |

**Regras de fronteira:**
- **Cada KB expõe as PRÓPRIAS APIs REST** (`/api/v1/...`) para atender o seu módulo —
  a **DHI NÃO é centralizadora de API interna**. O que é centralizado na DHI é só o que é
  domínio dela: identidade/sessão, tabelas gerais e integrações externas.
- **Toda API interna valida sessão** (`LoadWWPContext` → 401 sem usuário) — sem exceção,
  em qualquer KB.
- KB descontinuada: **CPFornec** (Portal de Fornecedores) não existe mais; o atendimento a
  fornecedor é mais um público do Portal DMS (login dedicado por **CNPJ**, `Usuario_TipoAcesso=FO`
  — ver §4) + APIs do módulo de compras.

## 1. Front-end — `PortalDMS` (`Genexus/VS_Code/PortalDMS`, package `portal-dms`)

| Camada | Tecnologia | Versão |
|---|---|---|
| Framework | React + TypeScript | 18.3 / 5.7 |
| Build/dev | Vite + @vitejs/plugin-react | 6 |
| Estilo | Tailwind CSS (`@tailwindcss/vite`) | 4 |
| UI primitives | Radix UI (dropdown, tooltip, popover, checkbox, alert-dialog) | 1.x/2.x |
| Tabela/grid | **TanStack Table** (headless) | 8 |
| Formulários | React Hook Form + Zod (`@hookform/resolvers`) | 7 / 4 |
| Estado | Zustand | 5 |
| Animação | Framer Motion | 11 |
| Janelas MDI | react-rnd (drag/resize) | 10 |
| Ícones | lucide-react | — |
| Utils CSS | clsx + tailwind-merge + class-variance-authority | — |

**Scripts:** `dev` (vite), `build` (`tsc -b && vite build`), `preview`, `lint` (eslint).

**Padrões próprios do front:**
- Camada de API: `portalApiReal` (REST real) / `portalApi` (mock) — escolha por `VITE_USE_REAL_API`.
- `DataTable` corporativo: filtro/ordenação por coluna, paginação, seletor de colunas, persistência
  por usuário+tela. Ver `DealernetCRM/docs/design/11-padrao-grid-filtros.md`.
- `ComboField`: combo de FK com carga async + cache + valor-órfão + typeahead.
- `CrudCadastro`: shell CRUD genérico (drawer ≤4 campos / tela cheia ≥5 ou combo ou abas).
  Regra em `DealernetHubIntegration/docs/design/16-padrao-telas-cadastro.md`.
- Sidebar recursivo (menu multi-nível: Sistema > grupo > subgrupo > item).
- DAI — assistente IA do portal (camada `portal/components/dai`, em evolução).

### 1.1 Front do módulo de Compras — `DealernetFrontEnd`

| Camada | Tecnologia | Versão |
|---|---|---|
| Framework | React + TypeScript | 18 / 5 |
| Build/dev | Vite | — |
| Estilo | Tailwind CSS | — |

- **Mesma stack do PortalDMS** (React 18 + TS + Vite + Tailwind), porém é uma SPA **separada**:
  contém as **telas do módulo de Compras** (peças/requisição/pedido/cotação).
- **Não é shell:** o **Portal DMS é a master page única**. As telas do DealernetFrontEnd são
  abertas **dentro do Portal DMS via iframe** com `?embed=1` (modo embutido, sem o próprio
  cabeçalho/sidebar). A sessão (cookie HttpOnly) é a mesma do Portal DMS / DHI.
- Consome as APIs REST do **DealernetProdutos** (módulo de Compras), validando a sessão WWPContext.
- Tela dedicada de **login de fornecedor** (`login-fornecedor.tsx`, rota `?portal=fornecedor`) —
  ver §4.

## 2. Backend — KB **DealernetHubIntegration** (GeneXus 18)

| Item | Detalhe |
|---|---|
| IDE/KB | GeneXus 18 U13 (`GX18_U13`), spec `18_0_13-186676`, KMW 4.0 build 186676 |
| Gerador | Default **.NET** (.NET Core) → pasta `NETCoreSQL` |
| App | `localhost:8082` (DealernetHubIntegrationNETCoreSQL) |
| Versionamento | **GXServer** (KB conectada); o **commit é do usuário** — a automação nunca commita |
| Módulos GX built-in | GeneXus, GeneXusUnanimo, GeneXusReporting, SecurityAPICommons, GeneXusJWT, AWSCore |

**Padrão BFF — LEAN v3 (único para todos os sistemas Dealernet):** por entidade = **4 objetos**:
`SDT_Portal<X>` + `PRC_Portal_<X>List` + `PRC_Portal_<X>Save` + `API_Portal_<X>`.
- SEM PRC_Get (Get = List com `&Codigo` opcional) · SEM PRC_Delete (soft delete = Save com Ativo=false).
- List: `parm(in:&Codigo, in:&Filtros, out:&SDT_ApiResponse)` — filtro dinâmico via SDT_Filtro (Do Case/Otherwise).
  Exposto como **`POST [RestPath("/list")]` com o JSON do SDT_Filtro no CORPO** (NÃO GET): o
  ASP.NET barra o caractere `:` na query string, então o filtro vai no body.
- Resposta única: `SDT_DHI_ApiResponse {StatusCode, Content(JSON), ErrorMessage}` → 1 parser no front.
- Sessão: `LoadWWPContext.Call(&Context)` + `if &Context.Usuario_Codigo.IsEmpty()` → 401.
- Detalhe: `DealernetHubIntegration/docs/...` + memória `bff-lean-padrao-unico-dealernet`.

> **Nomes por KB (2026-06-11):** a ESTRUTURA dos objetos e o contrato no fio
> (`{StatusCode, Content, ErrorMessage}`) são únicos; o **nome** é prefixado pela KB alvo.
> Na **DHI**: `SDT_DHI_ApiResponse`, `API_Portal_<X>`, `PRC_Portal_<X>List/Save`, `SDT_Portal<X>`.
> No **DealernetProdutos** (Portal de Compras): `SDT_ApiResponse`, `API_<Entidade>`,
> `PRC_<Entidade>List/Save`, `SDT_<Entidade>` (doc 13 v0.3). Ao gerar objeto novo, seguir o
> prefixo da KB alvo — nunca misturar.
>
> **Atenção (front):** o GeneXus pode serializar `StatusCode` como **string** (`"200"`/`"401"`) —
> coagir para número antes de comparar (`Number(...)`), senão o tratamento de 401 não dispara.
> Validado no PortalDMS (`portalApiReal.ts`) e corrigido no DealernetFrontEnd (`http.ts`) em 2026-06-11.

**Geração headless:** pacotes `import_file.xml` via PowerShell (`Temp/build-portal-crud-v3.ps1`),
GUID determinístico (DetGuid), checagens automáticas no gerador, gates em
`SKILLS-GX/Comunidade/scripts` (Test-GeneXusImportFileEnvelope / Get-...Inventory). Import + Build na IDE.

## 3. Banco de dados

| Item | Detalhe |
|---|---|
| DBMS | SQL Server — instância `.\SQL2022` |
| Banco | `Dealernetworkflow` (banco do ERP, compartilhado entre sistemas) |
| Acesso (dev) | autenticação integrada (`sqlcmd -S .\SQL2022 -E -C`) |
| Conexão da app | criptografada no `appsettings.json` (GeneXus encripta datasource/user/senha) |

## 4. Integração & Autenticação

- **Proxy Vite** (`vite.config.ts`): encaminha `/DealernetHubIntegrationNETCoreSQL/*` para
  `VITE_API_TARGET` (`:8082`), `changeOrigin` + reescrita de cookie → **mesma origem** para o
  cookie de sessão HttpOnly ser aceito/reenviado.
- **Auth (a DHI é o provedor de identidade do Portal)**: o login é feito pelos objetos da **DHI**
  **`API_Portal_Auth`** (REST, base path **`api/v1/portal/identity`**) → **`PRC_Portal_Login`**.
  **NÃO** é o `API_Login`/`PRC_Login` genérico (legado). DealernetProdutos e os demais módulos só
  **CONSOMEM** a sessão (cookie HttpOnly → `WWPContext`); não autenticam.
- **Sessão** WWP/GAM (cookie), validada em TODA API (401 se sem sessão), em qualquer KB.
- **Login do fornecedor:** o **CNPJ é o `Usuario_Identificador`** + senha. Regra única =
  `Usuario_TipoAcesso='FO'` (fornecedor) vs `<>'FO'` (interno). Domínio **`DomUsuarioTipoAcesso`**
  `Character(2)`: **`SI`** Sistema · **`WS`** WebService · **`FO`** Fornecedor.
  - Backend: `PRC_Portal_Login` separa por `&TipoPortal` (interno=1 / fornecedor=2); rota
    **`POST /rest/api/v1/portal/identity/authFornecedor`** no `API_Portal_Auth`.
  - Front: tela dedicada no **DealernetFrontEnd** (`login-fornecedor.tsx`, rota `?portal=fornecedor`),
    `authFornecedor()` com `VITE_API_BASE_FORNECEDOR=/rest/api/v1/portal/identity`.
  - Detalhe: `DealernetHubIntegration/docs/PROMPT-login-fornecedor-portal-auth.md`.
- **Menu**: SP `SP_PortalDMS_Menu` no banco devolve a árvore pronta (multi-produto); em dev o front
  injeta `EXTRA_MENU` (`VITE_MOCK_MENU_EXTRA=true`).
- **.env** (PortalDMS): `VITE_API_TARGET`, `VITE_API_BASE=/DealernetHubIntegrationNETCoreSQL/api/v1/portal`,
  `VITE_USE_REAL_API`, `VITE_MOCK_MENU_EXTRA`.

## 5. Ecossistema, docs e ferramentas

- **Docs**: cada KB tem `docs/` (design + especificacoes + referencias) + INDEX.md. Confluence: space RDPRD.
- **Skills GeneXus (Comunidade)**: xpz-* (reader, sync, msbuild-import/build), gates de import headless.
- **Sistemas Dealernet (Menu_TipoProduto):** DWF (Dealernet Workflow, ERP principal), DHI (Hub Integration),
  DCRM (CRM), FASTRENTAL, DNWA (Fast Service), FASTREPORT, GATEWAY.
- **Repositórios paralelos** (acervo XML da KB): `ObjetosDaKbEmXml` por KB, materializado via xpz-sync.
