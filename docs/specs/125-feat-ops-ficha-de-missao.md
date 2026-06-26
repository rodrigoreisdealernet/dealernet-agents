# Spec — #125 · Ficha de missão dos agentes DIA (catálogo estático no código) [U2]

> **Status: RASCUNHO (DRAFT)** — requer aprovação humana antes de qualquer código ser escrito.

## Visão geral

Hoje a "missão" de cada agente DIA (objetivo, dados que analisa, o que prevê, ações que pode recomendar e o fato de ser assist-only) vive apenas nos prompts em `ops_agent_config`, invisível ao operador. Esta unidade (U2 do `design-spec.md` §2 RF-1) adiciona um **catálogo de missão estático e versionado no código**, com conteúdo textual em i18n (pt-BR/en-US), exposto de forma read-only para que o painel de agentes mostre um card de missão por agente — sem revelar o prompt cru.

## Problema / Contexto

- Os 4 agentes DIA cobertos por esta unidade são (chaves reais já no código, em `temporal/src/ops_api/app.py` e `temporal/src/agents/`):
  - `vehicle-aging-analyst` — ações reais: `monitor, markdown, transfer, prioritize_sale, wholesale_auction` (`vehicle_aging_analyst.py`).
  - `service-estimate-rescue` — ações reais: `contact_customer, offer_discount, reprice, escalate, monitor` (`service_estimate_rescue.py`).
  - `collections-prioritizer` — ações via LLM, descritas por rótulos i18n (sem enum fixo no código).
  - `parts-inventory-advisor` — ações via LLM, descritas por rótulos i18n (sem enum fixo no código).
- Nenhuma tela explica o que cada agente faz. O dono abre o painel de agentes e vê apenas lista/saúde/próxima execução, sem entender o propósito de cada um.
- Decisão aprovada pelo dono: catálogo **estático no código** (versionável junto com o agente, sem migração de dados); o catálogo guarda apenas **chaves i18n + dados estruturais** (lista de ações, `assist_only=True`, chave de "prevê"). Texto de UI nunca é hard-coded no catálogo.
- Restrições: os agentes permanecem **assist-only**; o `system_prompt`/`user_prompt_template` nunca é exposto; não pode haver regressão na lista/saúde de agentes já existente. Depende da #124 (compartilha `AgentsDashboard.tsx`/`agentsApi.ts`/i18n).

## Critérios de aceite

- [ ] **Card de missão por agente:** Ao abrir o painel de agentes, cada um dos 4 agentes DIA exibe um card/painel de missão com: objetivo, dados analisados, o que prevê (rótulo "prevê: …"), ações possíveis e selo **assist-only**.
- [ ] **Conteúdo 100% via i18n, em pt-BR e en-US:** Todo o texto da ficha (objetivo, "prevê", dados e rótulos de ações) aparece traduzido em pt-BR e en-US; nenhuma chave i18n crua (ex.: `labels.agentMissions.*`) é exibida em nenhum dos idiomas.
- [ ] **Prompt nunca exposto:** O `system_prompt`/`user_prompt_template` do agente não aparece em nenhuma resposta de API consumida pelo painel nem na UI.
- [ ] **Vocabulário de ações bate com o código real:** As ações listadas em cada ficha correspondem exatamente ao vocabulário real do agente — `vehicle-aging-analyst`: `monitor/markdown/transfer/prioritize_sale/wholesale_auction`; `service-estimate-rescue`: `contact_customer/offer_discount/reprice/escalate/monitor`; `collections-prioritizer` e `parts-inventory-advisor`: ações por rótulo i18n.
- [ ] **Catálogo cobre exatamente os 4 agentes:** O catálogo estático expõe missão para exatamente os 4 `agent_key` DIA (`vehicle-aging-analyst`, `collections-prioritizer`, `parts-inventory-advisor`, `service-estimate-rescue`), cada um marcado como `assist_only=true`, e nenhum a mais.
- [ ] **Sem regressão:** A lista de agentes existente e o indicador de saúde/status continuam funcionando como antes (nenhum agente some, nenhuma quebra de status).

## Não-objetivos (Non-Goals)

- Tornar os agentes "ativos": continuam **assist-only**; a ficha não executa nem aciona nenhuma ação.
- Editar a missão pela UI: o catálogo é read-only; alterações só acontecem via código.
- Persistir o catálogo em banco/migração: a decisão é catálogo estático no código.

## Fora de escopo (Out-of-Scope)

- Prévia de decisão por finding (`describe_action_effect`/`decision_preview`) — U3.
- Campos de preditividade/horizonte no finding e severidade calibrada — U4.
- Próxima execução real do cron no dashboard — U1 (#124, dependência: mergear depois para evitar conflito em `AgentsDashboard.tsx`/`agentsApi.ts`/i18n).
- Fichas de missão para os demais agentes ops/integração fora dos 4 DIA.

---

**Este documento é um RASCUNHO (DRAFT) e requer aprovação humana antes de qualquer código ser escrito.**
