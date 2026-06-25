# CLAUDE.md — Portal DMS (shell / hub central das soluções)

## Identificação

- **Repositório central das soluções Dealernet.** O Portal DMS é o **ponto de
  entrada único** do usuário: agrega as soluções (Portal de Compras, Veículo,
  Oficina, BI…) num só shell. Cada solução é servida pela **sua própria KB/front**
  (DealernetProduto, DealernetVeiculo, FastBI…), mas o usuário entra, autentica,
  navega e troca de solução **pelo Portal DMS**. As telas de cada solução são
  abertas no shell (componente nativo ou iframe), com identidade/menu/tema
  unificados.
- **Shell** do Portal DMS: MDI (janelas flutuantes/abas) + menu + auth + DAI (assistente IA) + tour de onboarding. React 18 + Vite 6 + Tailwind 4, porta dev **5174**.
- Backend: KB **DealernetHubIntegration (DHI)** — é o backend do PORTAL (não de
  cada solução). O DHI provê, lendo do banco: **identidade** (login/sessão/bridge
  SSO), **menu** (árvore por solução via `SP_PortalDMS_Menu`), **workspace** (área
  de trabalho/MDI do usuário: contexto de empresa/solução ativa e configuração) e
  **tema** (cor por marca). Cada solução, porém, expõe as PRÓPRIAS APIs de negócio
  na sua KB. Base das APIs do portal: `/DealernetHubIntegration/api/v1/portal`
  (proxy Vite). Backends GeneXus em porta própria (1 por KB — Kestrel não
  compartilha porta): DHI e Produto cada um na sua; alinhar `VITE_API_TARGET` no
  `.env.local`. Virtual dir = nome curto da KB (`/DealernetHubIntegration/`,
  `/DealernetProduto/`).
- **Repositório:** `https://dev.azure.com/dealernetcloud/DMS/_git/PortalDMS` (Azure DevOps, projeto DMS).
- **MUDANÇA 2026-06-14:** telas de cadastro (Usuario, Empresa, Cargo, etc.) **SAEM do PortalDMS** e vão para `GX_AI\FrontEnd\DealernetHubIntegration\` (front React separado). O PortalDMS fica **só como shell** — abre as telas via iframe.
- Docs normativos em `docs/` — **ler antes de mexer**: `STACK.md` (stack canônica espelhada,
  fonte = DHI), `portal-mdi-arquitetura.md` (shell/segurança), `assistente-ia-arquitetura.md` (DAI),
  `planos-aprovados/` (decisões com data). Padrões de backend/telas vivem na DHI:
  `DealernetHubIntegration/docs/design/15` (CRUD), `16` (telas) e `PROMPT-ensinar-padrao-bff-enxuto.md` (lean v3).

## Comandos

- `npm run dev` — Vite :5174 (proxy reescreve cookie HttpOnly p/ mesma origem).
- `npm run build` — `tsc -b && vite build` (gate de tipo após qualquer edição).
- `.env`: `VITE_API_TARGET`, `VITE_API_BASE`, `VITE_USE_REAL_API` (mock×real),
  `VITE_MOCK_MENU_EXTRA`. Override por máquina em `.env.local` (ex.: backend em :8084).

## Integração com o BFF (LEAN v3)

- Camada de API: [src/portal/lib/portalApi.ts](src/portal/lib/portalApi.ts) (switch mock/real) e
  [portalApiReal.ts](src/portal/lib/portalApiReal.ts) (REST). Envelope único
  `SDT_DHI_ApiResponse {StatusCode, Content(JSON), ErrorMessage}`.
  - `StatusCode` chega como **string** do GeneXus — coagir com `Number(...)` (já feito no `req()`).
  - Sem DELETE físico: "apagar" = soft delete (`save({...row, ativo: false})`).
- **Menu**: a árvore vem PRONTA da SP `SP_PortalDMS_Menu` (JSON por solução, link completo via
  JOIN com `SolucaoDMS`). **Nunca** montar hierarquia por `codigoPai` no front.
- Auth: cookie HttpOnly + flag de UI em localStorage; `credentials: 'include'`;
  `SessionGuard` controla timeout de inatividade.

## Padrão de telas e componentes

- Tela nova = componente em `src/portal/renderers/screens/` registrado por `componentKey` em
  [registry.ts](src/portal/renderers/registry.ts) (lazy). Navegação é menu-driven via
  `openWindow` no [portalStore](src/portal/store/portalStore.ts) (Zustand persist) — sem react-router.
- **Cadastros**: usar o shell `CrudCadastro`. Regra aprovada (doc 16 da DHI):
  **drawer** se ≤4 campos simples (sem FK, sem abas); **tela cheia** se ≥5 campos OU combo-FK OU abas.
- **FK/enum = SEMPRE `ComboField`** (opções do `/list` da API ou enum fixo) — nunca input de código.
- Grid: `DataTable` corporativo (TanStack headless, modo híbrido server/client por presença de
  `total`). Plano aprovado: `docs/planos-aprovados/2026-06-11-grid-corporativo-cruds.md`.
- Design system próprio em [src/design-system/tokens.css](src/design-system/tokens.css)
  (oklch, light/dark via `data-theme`) — não criar tokens paralelos nem hardcodear cor.

## Tema por marca (cor do portal)

- A cor pinta o **portal inteiro**: `--primary` (destaques) E `--chrome` (sidebar/topbar),
  via [src/hooks/use-theme.ts](src/hooks/use-theme.ts) (`applyAccent`/`applyHex`).
- **Origem da cor:** a TRN **Tema** (DHI) guarda `Tema_CorPrimaria` (hex) por **Marca**. O portal
  busca `getTemas(marcaCod)` → `GET /tema/list` filtrando pela marca da empresa logada e aplica o
  1º tema como **padrão da marca** (só se o usuário não escolheu manualmente — `aplicarHexMarcaSeSemOverride`).
- **Seletor (TopBar 🎨):** se a marca tem ≥1 tema → mostra **só** os temas da marca; senão → a paleta
  fixa (`ACCENTS`). Escolha do usuário (`setHex`/`setAccent`) tem prioridade e persiste (localStorage).
- A **marca** da empresa ativa aparece como chip no `EmpresaSelector`. Config admin dos temas =
  tela **CadastroTema** (DHI Front). Spec completa: `docs/SPEC-TEMAS-POR-MARCA.md`.

## Sessão e paginação

- **Sessão expirada:** chamada autenticada que volta `autenticado:false`/`StatusCode 401` dispara
  `notifySessionExpired` ([sessionEvents.ts](src/portal/lib/sessionEvents.ts)); o `SessionGuard`
  mostra a tela central "Sessão expirada → Entrar novamente". Login/`bridge/validar` são exceção
  (tratam credencial/token, não disparam). Cobre o caso "Não foi possível gerar a sessão da tela".
- **Paginação:** o BFF lean NÃO devolve total → o `api.list` real OMITE `total` (não mandar o
  tamanho da página como se fosse total). A DataTable entra em modo CLIENT, busca um lote grande
  (size 500), pagina e CONTA no cliente. Tabelas >500 exigem o backend devolver `TotalCount` (TODO).
- Iframes legados (`.aspx`) só via `SandboxedFrame` (sandbox + allowlist de origin em
  `security.ts` + postMessage validado).

## Regras

- Mudança de contrato de API passa pelo `STACK.md` espelhado (dono: DHI) — não divergir localmente.
- `Cargo` é o CRUD de referência contra o BFF real; replicar o molde nos demais (P0 do
  `cadastros-crud-frontend.md`) antes de inventar variação.
- Repositório no Azure DevOps (`DMS/_git/PortalDMS`, branch `main`): **commitar ao
  fim de cada entrega**; PR com revisor para `main` (front segue a política da equipe).
