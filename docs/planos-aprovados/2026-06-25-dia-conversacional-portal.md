# DIA conversacional ao vivo no Portal (chat que responde dados + navega)

- **Título:** DIA conversacional ao vivo no Portal — chat que responde BI e navega
- **Data de aprovação:** 2026-06-25
- **Versão:** v0.1 (SemVer)
- **Status:** Aprovado

---

## Contexto

Hoje o Portal tem **duas peças de IA desconectadas**:

- **DAI** (front): casca visual completa em `frontend-portal/src/portal/components/dai/` — launcher
  flutuante, painel lateral, balões, "pensando", sugestões derivadas do menu. Mas `useDaiStore.send()`
  ainda usa um `fakeReply()` mockado. **Nunca chamou IA de verdade.**
- **DIA** (backend): infra agêntica madura em Azure OpenAI — o loop `chat_with_tools`
  (`temporal/src/agents/openai_client.py`) com tools read-only sobre os dados e **saída estruturada
  Pydantic**, exposto por um gateway FastAPI (`temporal/src/ops_api/app.py`). Mas só roda em
  **batch/agendado** (morning brief, findings) — não há canal conversacional ao vivo.

**Objetivo desta entrega** (decisões confirmadas com o usuário):
1. **Escopo:** o assistente responde **perguntas de BI com dados reais (read-only)** *e* **navega**
   abrindo a tela certa na sequência. Ex.: "como estão minhas vendas hoje?" → responde + abre o dashboard.
2. **Backend:** **reaproveitar a DIA** (Azure OpenAI / `chat_with_tools`) via um **endpoint
   conversacional novo** no `ops_api` — sem GEAI por enquanto.
3. **Marca:** **uma só IA**. Unificar DAI/DIA num cérebro só (nome canônico **DIA**).

Resultado pretendido: o usuário abre o painel no Portal, pergunta em linguagem natural, e a DIA
responde com dados da concessionária **e** abre/foca a tela relevante — tudo herdando a permissão dele.

---

## Arquitetura (encaixe na infra existente)

```
Portal (React)                         ops_api (FastAPI)              Azure OpenAI
┌──────────────────┐  POST /assistant/chat  ┌───────────────────┐   ┌──────────────┐
│ useDaiStore.send │ ─────────────────────► │ portal_assistant  │──►│ chat_with_   │
│  (histórico +    │  Bearer = Supabase JWT │  - system prompt   │   │ tools (loop) │
│   contexto)      │                        │  - tools BI (RO)   │◄──│ structured   │
│                  │ ◄───────────────────── │  - allowlist telas │   │ output       │
│ openWindow(acts) │   { reply, actions }   └───────────────────┘   └──────────────┘
└──────────────────┘
   ↑ executa navegação no front          ↑ tools de DADOS executam no backend (RLS por tenant)
```

**Princípio-chave (já viabilizado pelo `chat_with_tools`):** o agente devolve **um objeto estruturado**
`{reply, actions, suggestions}`. `actions` são comandos de navegação que **só o front executa**
(`openWindow`); as **tools de dados rodam no backend** (read-only). Isso é exatamente a divisão
prevista em `frontend-portal/docs/assistente-ia-arquitetura.md` §3.

**Estado da conversa:** *stateless* no servidor no MVP — o front mantém o histórico em `useDaiStore`
e envia a lista completa de `messages` a cada turno (formato que o `chat_with_tools` já consome).
Sem tabelas novas. Persistência/auditoria de conversa fica para fase posterior.

**Compat futura com GEAI:** o contrato do front (`assistantApi.ts`) é **agnóstico ao backend** — trocar
Azure→GEAI no futuro muda só o servidor, não o Portal.

---

## Backend — `temporal/src/`

### 1. Schema de resposta estruturada
**Novo:** `agents/portal_assistant_schema.py` (Pydantic, `extra="forbid"` — padrão do projeto):
- `AssistantReplyV1`: `reply: str` (texto PT-BR), `actions: list[AssistantAction]`,
  `suggestions: list[str]` (follow-ups curtos).
- `AssistantAction`: `type: Literal["open_screen"]`, `component_key: str`, `title: str`,
  `params: dict[str, Any] = {}`, `reason: str`.
- Só `open_screen` no MVP (escopo = navegação + dados, **sem ações destrutivas**).

### 2. Tools de BI read-only
**Novo:** `agents/tools/dia_bi.py`, seguindo o padrão de `agents/tools/rental_data.py` (funções
read-only, escopadas por `tenant_id`, backed por views Supabase). Cobrir as mesmas views que o front
já lê via `agentsApi`: KPIs do dono, tendência de vendas, resumo de estoque/veículos, findings,
métricas de serviço/peças. Exportar um `AVAILABLE_TOOLS`/definições de função (mesmo formato das
tools existentes).

### 3. Agente conversacional
**Novo:** `agents/portal_assistant.py`:
- Monta o **system prompt** (persona DIA, escopo, idioma PT-BR; instrui: responder dados via tools,
  e quando fizer sentido propor `open_screen` escolhendo `component_key` **apenas** do allowlist
  recebido no contexto; nunca inventar tela).
- Injeta contexto recebido do front: `current_screen`, `available_screens` (lista
  `{component_key, title, solution}` derivada do menu já filtrado por permissão), `empresa_id`.
- Chama `chat_with_tools(messages, tools=BI, tool_executor=..., response_format=AssistantReplyV1)`.
- Reusa transporte/failover Azure e validação de schema que já existem — nada novo nesse núcleo.

### 4. Endpoint no gateway
**Editar:** `temporal/src/ops_api/app.py` — `POST /api/ops/assistant/chat`:
- Auth via o **mesmo extrator de principal/JWT** já usado nos endpoints de findings (tenant, role, sub).
- Body: `{ messages: [{role, content}], context: { current_screen, available_screens, empresa_id } }`.
- **Validação de allowlist (servidor):** antes de retornar, descartar qualquer `action.component_key`
  que não esteja em `context.available_screens` (defesa contra navegação fora da permissão).
- Retorna `{ reply, actions, suggestions }`.

---

## Frontend — `frontend-portal/src/`

### 5. Cliente da API
**Novo:** `portal/lib/assistantApi.ts` — `chatWithAssistant(messages, context)`:
- Reusa o **access token do Supabase** já gerenciado em `portal/lib/agentsApi.ts` como
  `Authorization: Bearer`.
- POST para o endpoint do `ops_api`. Base URL via env (`VITE_OPS_API_BASE` ou similar; alinhar com
  como o front já alcança o ops_api hoje).

### 6. Ligar o store
**Editar:** `portal/components/dai/useDaiStore.ts`:
- Trocar `fakeReply()`/`setTimeout` por `await chatWithAssistant(...)`.
- Montar `context`: `current_screen` = `componentKey` da janela ativa
  (`usePortalStore.getState().windows`/`activeWindowId`); `available_screens` = derivado do menu
  permissionado (reaproveitar a lógica de `portal/components/dai/daiSuggestions.ts` que já varre o
  menu); `empresa_id` = `empresaAtualId`.
- Na resposta: append do `reply`; para cada `action.type==="open_screen"` chamar
  `usePortalStore.getState().openWindow({ kind:'component', componentKey, title, params })` e registrar
  no chat ("Abri *X* pra você ✅"). Manter `thinking` durante o await; tratar erro com mensagem amigável.

### 7. Unificar a marca para DIA
**Editar** strings visíveis em `portal/components/dai/DaiAssistant.tsx` (header, welcome, badge,
disclaimer) de "DAI" → "DIA". **Manter a pasta `dai/`** por ora (rename físico = follow-up opcional,
sem valor funcional). Atualizar o disclaimer removendo "sem IA real ainda".

---

## Segurança (herda os trilhos já existentes)
- **Permissão do usuário:** tools de dados escopadas por `tenant_id` do JWT; navegação restrita ao
  allowlist do menu permissionado (validado também no servidor). O assistente nunca vê/abre além do usuário.
- **Credencial do LLM** fica no `ops_api` (env Azure, `.env.dia-ops`) — o browser nunca a vê.
- **Tool output como evidência não-confiável** já é tratado no loop (`_TOOL_EVIDENCE_WARNING`).
- **Sem ações destrutivas** no MVP (somente `open_screen`).

---

## Verificação (ponta a ponta)
1. **Backend unit (pytest, `temporal/tests/`):** injetar um *fake* `ChatCompletionTransport` (o
   protocolo já permite) e validar que (a) uma pergunta de BI dispara a tool certa e retorna `reply`
   preenchido; (b) uma `action.open_screen` com `component_key` fora do allowlist é **descartada**.
   `python -m pytest temporal/tests/ -v`.
2. **Endpoint (FastAPI TestClient):** `POST /api/ops/assistant/chat` com JWT de teste → 200 e shape
   `{reply, actions, suggestions}`; sem JWT → 401.
3. **Front type gate:** `cd frontend-portal && npm run lint && npm run build`.
4. **Manual e2e:** subir o Portal (`npm run dev`) com `ops_api` + Supabase + Azure configurados;
   abrir a DIA; perguntar "como estão minhas vendas hoje?" → ver resposta com dados **e** o dashboard
   de vendas abrindo; perguntar "abre o estoque de veículos" → janela abre. Validar via MCP preview
   (snapshot/console) que não há erro e a janela correta entra no MDI.

---

## Fora de escopo (follow-ups)
- Persistência/auditoria de conversa (tabelas `conversation`/`conversation_turn`).
- Streaming token-a-token (typewriter) — o `chat_with_tools` hoje retorna resposta final.
- Ações que escrevem (aprovar finding, CRUD pré-preenchido) — exigem confirmação explícita.
- Troca do backend Azure→GEAI (contrato do front já fica pronto para isso).
- Rename físico da pasta `dai/` → `dia/`.
