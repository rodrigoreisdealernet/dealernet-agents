# Portal DMS MDI — Documento de Arquitetura

**Status:** proposta para aprovação · **Data:** 2026-06-08
**Projeto:** `portal-dms` (Portal DMS = Dealernet Multi Solution)
**Substitui:** Portal legado `W5Portal` (ExtJS 3, `C:\Dealernet\Genexus\VS_Code\Portal`)
**Stack:** projeto próprio espelhando o DealernetFrontEnd (React 18 + TypeScript + Vite + Tailwind + Radix + framer-motion)

> **Nota de nomenclatura:** o front-end foi renomeado de "PortalNovo"/"Portal Novo" para
> **Portal DMS** (branding interno, título e `package.json` já atualizados). A **pasta física
> ainda se chama `C:\Dealernet\Genexus\VS_Code\PortalNovo`** — o rename da pasta está pendente
> (travado pelo VS Code). Onde este doc cita caminhos, leia a pasta atual como `PortalNovo`.

> **Nota de organização:** o portal é um **projeto independente**, com seu próprio
> `package.json` e ciclo de build/deploy, para não acoplar releases ao DealernetFrontEnd.
> Ele **copia as convenções** do DealernetFrontEnd (proxy `/rest`, alias `@`, Tailwind,
> padrão de `lib/api.ts` + `use-auth` por cookie HttpOnly), sem dependência de código entre eles.
> Dev server na porta **5174** (DealernetFrontEnd usa 5173).

---

## 1. Objetivo e escopo

Construir o **Portal DMS** na stack moderna que permita **abrir várias frames (janelas) ao mesmo tempo**, preservando a experiência **MDI (janelas flutuantes)** do portal antigo, porém **moderno e seguro**. Além do MDI, o portal oferece um **modo Abas** alternável (toggle, persistido) para quem prefere navegação tabular.

### Decisões já tomadas (ver registro de decisões, §10)

| Tema | Decisão |
|------|---------|
| Conteúdo das janelas | Híbrido: **(a)** telas GeneXus legadas (ASPX), **(b)** telas novas do DealernetFrontEnd, **(c)** URLs externas / BI |
| Experiência de janelas | **MDI completo** — janelas flutuantes (mover, redimensionar, sobrepor, minimizar, cascata, maximizar, workspaces) |
| Stack | **Espelhar o DealernetFrontEnd** (React/Vite/Tailwind/Radix), em **projeto próprio** |
| Motor MDI | **Híbrido próprio** — `react-rnd` (drag/resize) + Zustand (estado) + framer-motion (animações) |
| Entrega | **Documento primeiro** (este arquivo); aprovado → POC funcional |
| Cor/tema | **Por marca** — a TRN Tema (DHI) guarda a cor (hex) por Marca; o portal aplica a cor da marca da empresa logada (--primary + --chrome), com override do usuário. Ver `SPEC-TEMAS-POR-MARCA.md` |

### Não-objetivos (Fase 1)

- Migrar as telas legadas ASPX para React (elas continuam em iframe).
- Reescrever o backend de workspaces (mantém contrato com GeneXus, ver §6).
- Atalhos de teclado, multi-monitor, "tabs" como modo principal.

---

## 2. Por que não manter o portal antigo

O `W5Portal.js` (1965 linhas, ExtJS 3, SVN, de 2010) cumpre a função, mas tem dívidas que o tornam inviável de evoluir com segurança:

- **ExtJS 3 / SVN são EOL** — sem suporte, sem patches de segurança.
- **`eval` em vários pontos** (`W5Portal.js:316, 324, 1106, 1820`) — vetor de injeção e manutenção frágil.
- **Acesso direto a `frame.contentWindow`/`contentDocument`** entre origens — quebra com CSP moderno e é inseguro.
- **Sessão em JSON plano** (`config.application.userName`) em vez de cookie HttpOnly.
- **Tratamento de erro destrutivo** — quase todo `catch` faz `window.location.reload()` ou vai pra `logout.aspx`, mascarando bugs.
- **iframes sem `sandbox` nem CSP** — qualquer conteúdo embutido roda com privilégio total.

O Portal DMS resolve cada um desses pontos por construção (§5 Segurança).

---

## 3. Visão geral da arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│  PortalShell (React)                                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ TopBar: logo · MainMenu · UserMenu · Empresa · Idioma   │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  WindowManager (área MDI)                               │  │
│  │   ┌───────────┐  ┌───────────┐  ┌───────────┐          │  │
│  │   │ <Window>  │  │ <Window>  │  │ <Window>  │   ...    │  │
│  │   │ Iframe    │  │ Component │  │ Iframe    │          │  │
│  │   │ (ASPX)    │  │ (nativo)  │  │ (BI ext)  │          │  │
│  │   └───────────┘  └───────────┘  └───────────┘          │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ StatusBar: Workspaces · Minimizadas · Favoritos · msgs │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Estado: portalStore (Zustand)  ·  Sessão: useAuth (cookie) │
└──────────────────────────────────────────────────────────────┘
        │ /rest (proxy Vite → GeneXus)        │ credentials: include
        ▼                                     ▼
   APIs REST /api/v1 (config, menu, workspaces, notif)    Cookie HttpOnly
```

A casca é React puro. Cada janela é um componente `<Window>` controlado pelo `portalStore`. O **renderer** de cada janela decide *como* o conteúdo aparece (iframe sandboxed ou componente nativo). Toda a comunicação com o backend usa o mesmo padrão do DealernetFrontEnd (`fetch` com `credentials:'include'` via proxy `/rest`).

---

## 4. Componentes

### 4.1 PortalShell
Layout raiz (substitui `Ext.Viewport` border layout). Monta TopBar, WindowManager e StatusBar. Carrega config/menu/workspaces no boot e injeta no `portalStore`. Protegido por `useAuth` (redireciona ao login se não autenticado).

### 4.2 WindowManager + `<Window>`
O coração do MDI. Renderiza a lista de janelas do store. Cada `<Window>`:
- usa **`react-rnd`** para drag + resize (posição/tamanho controlados pelo store);
- tem barra de título com tools (imprimir, refresh, voltar/avançar, auto-ajuste, favoritar, minimizar, maximizar, fechar) — paridade com `createWindow` do antigo (`W5Portal.js:1010`);
- gerencia z-index (foco traz pra frente), limites da área (não sai da viewport), snap opcional;
- anima abrir/fechar/minimizar com `framer-motion`.

**Renderers de conteúdo** (discriminated union por `kind`):
| `kind` | Conteúdo | Render |
|--------|----------|--------|
| `iframe-aspx` | Tela GeneXus legada | `<SandboxedFrame>` com sandbox + allowlist + postMessage |
| `component` | Tela nativa nova | Componente React lazy-loaded por chave de rota |
| `iframe-external` | BI / URL externa | `<SandboxedFrame>` com sandbox mais restrito |

### 4.3 TopBar
Logo, MainMenu (a partir do JSON de **árvore pronta** do GeneXus — ver §5.1), UserMenu (logout, alterar senha), troca de empresa, troca de idioma, toggle **MDI ↔ Abas**, timeout de sessão. Componentes Radix (`dropdown-menu`, `tooltip`).

### 4.4 StatusBar
Seletor de workspace ativo, lista de janelas minimizadas, favoritos (bookmarks), container de mensagens transitórias. Paridade funcional com `createStatusbar` do antigo (`W5Portal.js:459`).

### 4.5 portalStore (Zustand)
Fonte única de verdade do MDI:
```ts
interface PortalState {
  windows: PortalWindow[]          // janelas abertas (posição, tamanho, z, estado)
  activeWindowId: string | null
  minimized: string[]
  bookmarks: Bookmark[]
  workspaces: WorkspaceMeta[]
  activeWorkspaceId: string | null
  config: PortalConfig | null
  menu: MenuItem[]
  // ações
  openWindow(spec: WindowSpec): void
  closeWindow(id: string): void
  focusWindow(id: string): void
  minimizeWindow(id: string): void
  restoreWindow(id: string): void
  cascade(): void
  loadWorkspace(id: string): Promise<void>
  saveWorkspace(name?: string): Promise<void>
  // ...
}
```

### 4.6 SandboxedFrame
Wrapper de iframe com segurança embutida — ver §5.

---

## 5. Modelo de segurança (o "seguro" do objetivo)

| Risco no portal antigo | Mitigação no novo |
|------------------------|-------------------|
| iframe sem isolamento | `sandbox="allow-same-origin allow-scripts allow-forms allow-popups"` — **allowlist mínima** por tipo de conteúdo; externo recebe menos permissões |
| Qualquer URL embutível | **CSP** `frame-src` com allowlist de domínios (ERP/WF, BI, externos aprovados); URLs fora da lista são bloqueadas |
| `eval` e acesso a `contentWindow` | **`postMessage` tipado** com validação de `event.origin` contra allowlist (substitui `receiveMessage` solto do antigo, `W5Portal.js:71`) |
| Sessão em JSON | **Cookie HttpOnly** no padrão do DealernetFrontEnd (`credentials:'include'`); JS nunca lê o token |
| Macros de URL por regex frágil | Construção de URL tipada + `encodeURIComponent`; sem `eval` de querystring |
| Logout/timeout por reload | Timeout de sessão controlado + chamada explícita a endpoint de logout |

Regras de `postMessage` (contrato shell ↔ iframe legado):
- toda mensagem tem `{ type, payload }` tipado;
- shell só aceita `event.origin` na allowlist de config;
- ações permitidas do legado: pedir abertura de janela, fechar a própria, notificar título/altura (para auto-ajuste). Nada mais.

---

## 5.1 Menu via Stored Procedure (árvore pronta)

O menu **não** é mais montado no front. Abandonamos o `SDT_MenuNode` plano + `buildMenuTree`
(que remontava a árvore por `codigoPai`). Agora existe no banco a SP **`SP_PortalDMS_Menu`**
(nova, espelha a recursão de 5 níveis da `SP_DealernetCRM_Menu` sem tocá-la) que recebe
usuário + TipoProduto + idioma e devolve o **JSON da árvore já pronta e já filtrada por
permissão** (formato `DVelop_Menu` `{id, caption, link, iconClass, subItems[]}`).

A SP faz **JOIN com `SolucaoDMS`** e devolve o `link` **já com a URL completa do ambiente**:
`.aspx` → `UrlBase + PgmName` (GX18/EV2 legado); rota simples → `UrlBaseSpa + PgmName`
(React/IA); link `http(s)` → absoluto; fallback relativo (só `PgmName`) se a solução não
estiver em `SolucaoDMS`. Banco por ambiente (cada dev/qa/prod tem suas URLs).

No front, `portalApiReal.buildMenuTree` apenas **consome** essa árvore (`JSON.parse` por
produto) e **deriva o `kind`** de cada item (`.aspx`/rota → `iframe-aspx`; `http` →
`iframe-external`). Endpoint: `GET /api/v1/portal/menu/menus` (pacote GeneXus na KB
DealernetHubIntegration: `EO_SP_Portal_Menu` + `SDT_PortalMenu` + `PRC_Portal_Menu` +
`API_Portal_Menu`).

## 5.2 DAI — Dealernet AI (assistente do portal)

O portal embarca o **DAI** (Dealernet AI), assistente acessível por botão flutuante +
painel lateral deslizante. **MVP = navegação por comando**: as sugestões iniciais são
**derivadas do menu do usuário** (telas que ele pode abrir, já filtradas por permissão) —
cada sugestão tem ação de navegação que abre a janela via `openWindow`. Arquitetura de IA:
**GEAI (Globant Enterprise AI)** como orquestrador de modelo + **BFF de IA fino** (orquestra
tool use e injeta contexto/permissão, sem guardar chave de LLM). Detalhe em
`docs/assistente-ia-arquitetura.md`.

## 5.3 Tratamento de erros de login (credencial × comunicação)

O login distingue **três** situações, para nunca confundir o usuário:

| Situação | Como é detectada (camada `portalApiReal.auth`) | Mensagem ao usuário |
|---|---|---|
| **Credencial inválida** | DHI respondeu com corpo de negócio `{autenticado:false}` **sem** sinal técnico | "Usuário ou senha inválidos." (genérica — anti-enumeração) |
| **Falha de comunicação** | DHI **não respondeu** como serviço: `fetch` lançou (rede/CORS/fora do ar), **ou** HTTP de erro **sem corpo de negócio** (404 de rota inexistente, página de erro do IIS, 502/503 de gateway), **ou** mensagem do backend com sinal técnico (`5xx`/`host`/`conex`/`timeout`/`workflow`/`aspx`/`http`) | "Falha de comunicação com o servidor. O serviço de login está indisponível…" |
| **2FA** | status `2FA_REQUIRED` | fluxo de 2º fator (doc 12) |

Regra-chave (`req()`): um JSON de erro só é tratado como **negócio** se tiver a "cara" do
contrato da DHI (campos `autenticado` / `StatusCode` / `mensagem` / `ErrorMessage`). Qualquer
outro 4xx/5xx — **inclusive a DHI não existir / rota 404** — vira `NetworkError` e o `auth`
o classifica como `SERVICE_UNAVAILABLE` (falha de comunicação), **não** como credencial.
Status do contrato: `OK | 2FA_REQUIRED | INVALID_CREDENTIALS | SERVICE_UNAVAILABLE`.

## 5.4 Onboarding tour (apresentação guiada)

Tour guiado de 1ª utilização — **componente próprio, sem biblioteca** (DS navy/accent).
Arquivos: `portal/components/tour/PortalTour.tsx` (overlay + spotlight + balão) e
`useTour.ts` (store + passos + flag de "já viu").

- **Spotlight:** escurece a tela e recorta o elemento-alvo (via `box-shadow` gigante no buraco +
  `outline` no `--primary`); o balão se posiciona ao lado e é mantido dentro da viewport.
- **Alvos:** marcados com `data-tour="<id>"` nos componentes (Sidebar/TopBar/StatusBar/DAI),
  então o tour não acopla a estrutura interna deles — só ao atributo.
- **Passos (9):** `menu` → `busca` → `modo` (Abas/MDI) → `workspaces` → `favoritos` → `empresa`
  → `tema` → `usuario` → `dai`.
- **Disparo:** automático no **1º login** (flag `dealernet-portal-tour-v1` no `localStorage`,
  após o boot, com os alvos já no DOM); **rever** pelo menu do usuário → **"Tour do portal"**
  (`useTour().start()`).
- **Navegação:** Próximo / Voltar / Pular, **setas ←/→**, **Enter** (próximo) e **Esc** (fechar);
  progresso por *dots*. Alvo ausente na resolução atual → escurece a tela e o tour segue navegável.

---

## 6. Contratos de backend (GeneXus / `/api/v1`)

O portal **consome**, não define, esses serviços. Reaproveita o que o `W5Portal` já esperava, mas em REST/JSON tipado sob `/rest` (proxy Vite → GeneXus). Endpoints previstos:

| Recurso | Método | Descrição | Equivalente antigo |
|---------|--------|-----------|--------------------|
| `/api/v1/portal/config` | GET | Config do portal (logo, tema, allowlists, empresa, idioma) | `aprc_wsconfig.aspx` / `config.json` |
| `/api/v1/portal/menu` | GET | Árvore de menu do usuário | `mainMenu.json` |
| `/api/v1/portal/workspaces` | GET | Lista de workspaces do usuário | `workspaces.json` |
| `/api/v1/portal/workspaces/{id}` | GET | Conteúdo (janelas+bookmarks) | `workspace.php?a=get` |
| `/api/v1/portal/workspaces` | POST/PUT/DELETE | CRUD de workspace | `workspace.php?a=save/delete` |
| `/api/v1/portal/notifications` | GET | Novas tarefas/fluxos (polling) | `CheckNewFlow`/`CheckNewTask` |
| `/api/v1/login/auth` + cookie | POST | Mesmo padrão do DealernetFrontEnd | — |

**Dependência aberta:** confirmar com o time GeneXus se esses endpoints existem em `/api/v1` ou se precisam ser criados/adaptados a partir das páginas ASPX atuais. Ver §11.

---

## 7. Modelo de dados (workspace serializável)

```ts
type WindowKind = 'iframe-aspx' | 'iframe-external' | 'component'

interface PortalWindow {
  id: string
  title: string
  kind: WindowKind
  src?: string            // URL (iframe) — relativa ao ERP ou allowlisted
  componentKey?: string   // chave da tela nativa (kind=component)
  x: number; y: number; width: number; height: number
  maximized: boolean; minimized: boolean
  zIndex: number
}

interface Workspace {
  id: string
  name: string
  windows: PortalWindow[]
  bookmarks: Bookmark[]
}
```
Compatível com o JSON de workspace antigo (`{windows:[...], bookmarks:[...]}`, ver `data/workspaces/main.json` do portal legado), facilitando migração de dados existentes.

---

## 8. Estrutura de pastas (projeto próprio Portal DMS)

> Pasta física ainda é `PortalNovo` (rename pendente — ver nota no topo).

```
PortalNovo/   (pasta física; projeto = Portal DMS)
  index.html  vite.config.ts  tailwind.config.js  postcss.config.js
  tsconfig*.json  package.json  .env.example  .gitignore
  docs/
    portal-mdi-arquitetura.md     (este documento)
  src/
    main.tsx  App.tsx  index.css  vite-env.d.ts
    portal/
      PortalShell.tsx
      store/portalStore.ts          (Zustand)
      components/
        WindowManager.tsx
        Window.tsx                  (react-rnd + tools + framer-motion)
        SandboxedFrame.tsx          (iframe seguro + postMessage)
        TopBar.tsx  StatusBar.tsx  MainMenu.tsx
      renderers/
        iframeRenderer.tsx  componentRenderer.tsx
        registry.ts                 (componentKey → componente lazy)
      lib/
        portalApi.ts                (config/menu/workspaces/notif — padrão de lib/api.ts)
        security.ts                 (allowlists, validação de origin)
      types.ts
    hooks/use-auth.tsx  use-theme.ts (copiados do DealernetFrontEnd)
    lib/api.ts  utils.ts            (copiados do DealernetFrontEnd)
    components/ui/                   (componentes base copiados conforme necessidade)
```
Dependências próprias: `react`, `react-dom`, `react-rnd`, `zustand`, `framer-motion`, Radix, Tailwind. Sem dependência de código do DealernetFrontEnd (cópia das convenções).

---

## 9. Plano de fases

**Fase 0 — Alinhamento (este doc).** Aprovar arquitetura e confirmar contratos `/api/v1` com o time GeneXus.

**Fase 1 — POC funcional.** Shell + WindowManager + `<Window>` com `react-rnd`; abrir **1 janela iframe-aspx sandboxed** e **1 janela component nativo**; foco/z-index, minimizar, fechar, cascata. Config/menu mockados localmente.

**Fase 2 — Paridade MDI.** Workspaces (load/save via API), bookmarks, maximizar, auto-ajuste, troca de empresa/idioma, timeout de sessão, notificações (polling).

**Fase 3 — Segurança e produção.** CSP definitiva, allowlists por ambiente, contrato `postMessage` com as telas legadas, logout no backend, tratamento de erro não-destrutivo, i18n.

**Fase 4 — Migração progressiva.** Trocar telas `iframe-aspx` por `component` nativo conforme forem migradas, sem mudar o shell.

---

## 10. Registro de decisões

1. **Projeto próprio** (não dentro do DealernetFrontEnd) — para desacoplar release/deploy; reusa convenções por cópia, não por dependência.
2. **Iframe é inevitável** para conteúdo ASPX e BI/externo — não há como renderizar ASPX num componente React. A segurança vem do `sandbox` + CSP + `postMessage`, não da eliminação do iframe.
3. **MDI flutuante próprio** (não biblioteca de docking) — para fidelidade ao comportamento que o usuário já conhece; libs de docking priorizam abas/split, não janelas livres sobrepostas.
4. **Espelhar a stack/auth do DealernetFrontEnd** — cookie HttpOnly, proxy `/rest`, alias `@`, padrão de `lib/api.ts`.
5. **Migração progressiva** — o shell trata iframe e componente nativo igual; migrar telas não exige tocar no portal.

---

## 11. Riscos e questões em aberto

| Item | Risco | Ação |
|------|-------|------|
| Endpoints `/api/v1/portal/*` | Podem não existir ainda | Confirmar/criar com time GeneXus (§6) |
| Telas ASPX dependem de cookies/sessão própria | Sessão dentro do iframe pode divergir da do shell | Validar SSO/compartilhamento de cookie entre portal e ERP |
| CSP `frame-src` x telas legadas | Telas antigas podem violar CSP | Levantar domínios reais e testar por ambiente |
| Charset legado (iso-8859-1) | Telas antigas em iso vs portal utf-8 | Iframe isola charset; validar acentuação |
| Volume de janelas abertas | Muitos iframes = consumo de memória | Limitar/limpar iframes de janelas minimizadas há muito tempo (lazy) |

---

## 12. Próximo passo

Aprovado este documento → implementar **Fase 1 (POC)**: esqueleto do Portal DMS rodável (`npm install && npm run dev` na pasta física `PortalNovo`), com uma janela iframe sandboxed e uma janela de componente nativo, demonstrando o MDI flutuante.
