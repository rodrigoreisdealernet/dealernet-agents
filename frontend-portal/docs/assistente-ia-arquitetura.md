# DAI — Dealernet AI · Assistente do Portal — Documento de Visão & Arquitetura

**Assistente:** **DAI — Dealernet AI** (nome oficial do assistente do portal).
**Status:** proposta para discussão (esboço visual já construído no front; sem backend ainda) · **Data:** 2026-06-10
**Projeto:** Portal DMS (shell React) + DHI (identidade) + BFF de IA → **Globant Enterprise AI (GEAI)**
> _Nota: a pasta física do projeto ainda se chama `PortalNovo` (rename pendente, travado pelo VS Code); o branding interno já é **Portal DMS**._
**Decisões iniciais (usuário):** MVP = **navegação por comando**; **BFF de IA fino** (não guarda
chave de LLM); **GEAI como orquestrador** (escolha de LLM + controle de custo); **tool use no BFF**.

---

## 1. Objetivo

A **DAI (Dealernet AI)** é um assistente conversacional no portal que **interage pelos menus,
navega nas telas** e, no futuro, **consulta dados**. O usuário fala em linguagem natural
("abre o funil de vendas", "onde cadastro um lead?", e adiante "quantos leads abertos esse mês?")
e a DAI age.

## 2. Capacidades em 3 níveis (crescentes)

| Nível | Capacidade | Viabilidade | Fase |
|---|---|---|---|
| **1 — Navegar** | abrir telas/abas, buscar no menu, trocar workspace/empresa | **Alta** — o portal já tem `menu` + `openWindow` no store | **MVP** |
| **2 — Consultar dados** | responder com dados reais via APIs `/api/v1` | Média-alta — exige APIs de dados + tool-use | Fase 2 |
| **3 — Operar telas** | preencher/criar dentro das telas | **Baixa p/ legado** — telas ASPX em iframe são cross-origin; o agente não acessa o interior | Fase 3+ (só telas React nativas) |

> **Restrição-chave:** o portal embute telas legadas em **iframe sandboxed**. O assistente
> **não consegue clicar/preencher dentro de um iframe ASPX**. Por isso "operar telas legadas"
> fica para quando a tela for nativa (React) — ou via API, nunca via DOM do iframe.

## 3. Arquitetura (padrão: agente com ferramentas / tool use)

```
┌───────────────────────────────────────────────┐
│ Portal DMS (React)                             │
│  ┌─────────────┐   pergunta (texto)            │
│  │ Chat painel │ ───────────────►              │
│  └─────────────┘                  │            │
│        ▲ resposta / ação          ▼            │
│        │            ┌──────────────────────┐   │
│        │            │ AssistantClient       │   │
│        │            │ (executa as tools que │   │
│        │            │  o BFF pediu, no front)│  │
│        │            └──────────┬───────────┘   │
└────────┼───────────────────────┼───────────────┘
         │ /api/v1/assistente    │ tools de navegação executadas no front:
         ▼ (cookie sessão)       │  navegar(), listarMenu(), abrirWorkspace()...
┌────────────────────────────┐  │
│ BFF de IA (fino)            │  │
│ - orquestra o TOOL USE      │  │  (define as tools, faz o loop, injeta
│   (loop de chamadas)        │  │   contexto do usuário: menu+permissão)
│ - NÃO guarda chave de LLM   │  │
└──────────┬─────────────────┘  │
           │ chama o modelo      ▼ tools de dados (Fase 2): BFF chama
           ▼ (function calling)    /api/v1/<modulo> (GeneXus, sessão do usuário)
┌────────────────────────────┐
│ Globant Enterprise AI (GEAI)│  ← ORQUESTRADOR DE IA
│ - gateway de modelo: escolhe│
│   o LLM, controla CUSTO,    │
│   limites, observabilidade  │
│ - credencial do LLM vive AQUI│
└────────────────────────────┘
```

**Fluxo (MVP — navegação):**
1. Usuário digita no chat → front envia ao **BFF de IA** (`POST /api/v1/assistente`) com o
   histórico e o **contexto** (menu do usuário, tela atual).
2. O **BFF orquestra o tool use**: monta o prompt + a definição das ferramentas (§4) e chama o
   **GEAI** (que escolhe o LLM e controla custo). O GEAI devolve texto **ou** uma chamada de tool.
3. Se for tool de navegação → o BFF devolve a "ação" ao front; o **front executa** (`openWindow`).
4. Se for tool de dados (Fase 2) → o **BFF executa** chamando a API GeneXus com a sessão do usuário,
   e devolve o resultado ao GEAI para fechar a resposta (loop de tool use).
5. Resposta final volta ao chat ("Abri o Funil de Vendas pra você.").

**Divisão de responsabilidades:**
- **GEAI** = gateway de modelo (qual LLM, custo, limites, observabilidade). A credencial do LLM
  vive no GEAI — o BFF se autentica no GEAI, não no provedor do modelo.
- **BFF (fino)** = orquestra o tool use (loop), injeta o contexto/permissão do usuário, executa
  tools de dados. Não escolhe modelo nem guarda chave de LLM.
- **Front** = executa as tools de **navegação** (estado do shell; só o front faz).

> **Pré-requisito a confirmar com a equipe GEAI:** como o tool use fica no BFF, o GEAI precisa
> expor uma API que aceite **definição de ferramentas e retorne tool calls** (function calling),
> não apenas texto. Se o GEAI não suportar function calling nativo, o BFF faz o "tool routing"
> por prompt (modelo retorna JSON da ação) — funciona, mas é menos robusto.

## 4. Ferramentas (tools) do assistente

**MVP (navegação) — executadas no front:**
- `listarMenu()` → devolve o menu do usuário (produtos/telas que ele pode acessar). É como o
  assistente "sabe o que existe". Fonte: `usePortalStore().menu` (já filtrado por permissão).
- `navegar(telaId | termo)` → abre a tela (`openWindow`). Aceita id do menu ou busca por nome.
- `abrirWorkspace(nome)` / `salvarWorkspace(nome)` → `loadWorkspace`/`saveCurrentWorkspace`.
- `trocarEmpresa(nome)` / `trocarTema(cor)` → `changeEmpresa`/`setAccent`.
- `telaAtual()` → o que está aberto (contexto para perguntas tipo "fecha essa tela").

**Fase 2 (dados) — executadas no BFF:**
- `consultar(modulo, recurso, filtros)` → chama `/api/v1/<modulo>/...` **com a sessão do
  usuário** (cookie repassado). Ex.: `consultar("crm","leads",{periodo:"mes",status:"aberto"})`.
- Cada consulta respeita a **permissão do próprio usuário** (mesma sessão) — o assistente
  nunca vê mais do que o usuário veria.

## 5. Segurança (o ponto mais sério)

1. **Credencial do LLM vive no GEAI** — nunca no browser nem no BFF. O front fala com o BFF; o
   BFF se autentica no **GEAI** (token/credencial do GEAI), e o GEAI fala com o provedor do modelo.
2. **O assistente herda a permissão do usuário** — toda tool de dados usa a **sessão (cookie)
   do usuário logado**; o BFF não tem "superpoder". Se o usuário não pode ver, o assistente não vê.
3. **Navegação ≠ ação destrutiva** — no MVP o assistente só *abre* telas. Ações que alteram
   dados (Fase 2+) exigem **confirmação explícita** do usuário antes de executar.
4. **Allowlist de tools** — o assistente só pode chamar as ferramentas registradas; não executa
   código arbitrário nem acessa o DOM dos iframes.
5. **Auditoria** — registrar o que o assistente fez (navegou/consultou) no histórico de acesso.
   O **GEAI** também provê observabilidade/custo por requisição (governança centralizada).
6. **Sem dado sensível no prompt** — o contexto enviado ao modelo (via GEAI) é o menu + tela
   atual, não dados de cliente. Dados só entram sob demanda, via tool, e com cuidado (LGPD).
7. **Governança de modelo/custo no GEAI** — qual LLM, teto de gasto, limites e troca de modelo
   são configurados no GEAI, sem mexer no portal nem no BFF.

## 6. UX

- **Painel de chat** flutuante/lateral (abre por atalho ou botão no header), não invade o MDI.
- Respostas curtas + **ações com 1 clique de confirmação** quando fizer sentido.
- A DAI "vê" o menu do usuário → sugere telas que ele realmente tem.
- Estado de "pensando", histórico da conversa, e um disclaimer (a DAI pode errar).

### 6.1 Esboço visual já construído (mock, sem backend)

O **front-end visual da DAI já está implementado** como mock (sem chamadas reais ao BFF/GEAI),
para validar a UX antes de plugar a IA. Componentes em `src/portal/components/dai/`:

| Arquivo | Papel |
|---|---|
| `DaiAssistant.tsx` | launcher flutuante + painel lateral + balões + input |
| `useDaiStore.ts` | estado do chat (mensagens, aberto/fechado, "pensando") |
| `daiSuggestions.ts` | derivação das sugestões iniciais a partir do menu (§6.2) |

**O que o esboço já entrega:**
- **Launcher flutuante** — botão com ícone **Sparkles** + **pulso accent** (cor fria do tema; vermelho
  reservado para perigo), sempre visível sobre o shell MDI.
- **Painel lateral deslizante (400px)** — header **navy em gradiente** com **badge "beta"**, tela de
  **boas-vindas**, **balões user/assistente** distintos, indicador **"pensando"** animado.
- **Input com Enter-pra-enviar** e **disclaimer** (a DAI pode errar) no rodapé.
- Respeita os tokens do Design System (OKLCH, `[data-theme]` light/dark + accent, IBM Plex Sans).

> Estado atual: **mock visual** — as respostas e ações ainda não passam pelo BFF/GEAI. O próximo
> passo (Fase 1 / POC) é ligar o `useDaiStore` ao `POST /api/v1/assistente` e às tools de navegação.

### 6.2 Sugestões iniciais — configuráveis e DERIVADAS DO MENU

As sugestões iniciais (os "chips" de partida que a DAI mostra na tela de boas-vindas) **não são
hardcoded**: são **derivadas do menu do usuário** — que já vem **filtrado por permissão** (via
`GrupoAcessoMenu`, montado pela `SP_PortalDMS_Menu`). **Zero cadastro:** cada usuário só vê
sugestões para telas que ele **pode realmente abrir**.

Cada sugestão é um objeto com:
- **texto** — rótulo amigável (ex.: "Abrir Funil de Vendas").
- **ícone** — o `iconClass` do próprio nó de menu (Font Awesome).
- **ação de navegação** — clicar **abre a tela** via `openWindow` (mesma rota da tool `navegar`).
- **solução de origem** — a `SolucaoDMS`/produto de onde a tela vem (DWF, DCRM, FASTRENTAL, …),
  permitindo **filtrar sugestões por solução**.

**Heurística de seleção (MVP):** "primeiras telas de cada solução" do menu do usuário.
**Evolução:** quando houver **histórico de acesso**, troca-se a heurística por **"mais usadas"**
(personalização real, sem cadastro). Fonte da derivação: `daiSuggestions.ts` consumindo
`usePortalStore().menu` (a mesma árvore pronta que a tool `listarMenu()` expõe).

## 7. Plano de fases

| Fase | Entregável | Depende de |
|---|---|---|
| **0** | Este documento (visão/arquitetura) aprovado | — |
| **1 (MVP)** | Painel de chat + BFF fino + GEAI + tools de **navegação** (listarMenu, navegar, workspace, empresa, tema) | menu real importado; acesso ao GEAI configurado |
| **2** | Tool `consultar` + 1ª API de dados real; respostas com dados (com confirmação p/ ações) | APIs `/api/v1` de dados; políticas LGPD |
| **3** | Operar telas **nativas** (React) por comando; (legado fica fora) | telas migradas p/ React |

## 8. Decisões tomadas (registro)

1. **MVP = navegação por comando** (não consulta/ação ainda).
2. **GEAI (Globant Enterprise AI) como orquestrador de IA** — gateway de modelo, controle de
   custo, escolha/troca de LLM e observabilidade. A credencial do LLM vive no GEAI.
3. **BFF de IA fino** — orquestra o tool use (loop) e injeta contexto/permissão; **não guarda
   chave de LLM nem escolhe modelo**. Autentica-se no GEAI.
4. **LLM configurável no GEAI** (sem travar provedor no portal) — o GEAI decide qual modelo.
5. Tools de navegação **executam no front** (estado do shell); tools de dados **no BFF** (Fase 2).
6. **Segurança:** assistente herda a sessão/permissão do usuário; credencial de LLM no GEAI;
   allowlist de tools; custo/limites governados pelo GEAI.

## 9. Questões abertas (para a discussão)

- **GEAI suporta function calling (tool use) nativo na API?** Se sim, o BFF passa as definições
  de tools direto; se não, o BFF faz tool routing por prompt (modelo retorna JSON da ação).
- **Como o BFF se autentica no GEAI?** (API key de serviço, OAuth, etc.) e qual endpoint/SDK.
- **Onde hospedar o BFF fino?** micro-serviço Node próprio vs. endpoint na DHI (GeneXus) — ambos
  agora só falam com o GEAI, não com o provedor do modelo.
- **Streaming** das respostas (typewriter) no MVP — o GEAI expõe streaming?
- **Teto de custo/limites** por usuário — configurar no GEAI.
- **Persona da DAI** (tom, escopo do que ela "sabe") — nome já definido: **DAI — Dealernet AI**.
- **Qual(is) LLM(s)** habilitar no GEAI para este caso de uso.

## 10. Próximo passo

Aprovado este documento → **POC da Fase 1**: ligar o esboço visual da DAI no Portal DMS (já pronto,
§6.1) a um BFF mínimo (Node) com a tool `navegar`/`listarMenu`, provando "abrir tela por comando"
ponta a ponta — e ativando as sugestões iniciais derivadas do menu (§6.2).
