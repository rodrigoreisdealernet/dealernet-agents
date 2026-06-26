# Design Spec — Agentes DIA: transparência + preditividade

> **Status:** Aguardando aprovação humana (gate AI-DLC). Nenhum código de produção foi escrito.
> Complementa `requirements.md`. Decisões de design recomendadas marcadas com **★**.

## 0. Princípios
- **Aditivo e reversível.** Migrações novas; views recriadas com lista completa de colunas;
  campos de finding novos e nulos por padrão. Zero regressão em filas/KPIs/auditoria.
- **Fonte única de verdade.** A prévia de decisão deriva do **mesmo** mapa ação→efeito que
  `OpsDecisionService.execute_finding_action`. A próxima execução deriva do **cron real**.
- **Assist-only explícito.** A UI deixa claro quando "aprovar" é no-op auditado vs. efeito real.

## 1. Arquitetura da mudança (camadas)

```
Worker (Temporal)            ops_api (FastAPI)            Supabase (views)           frontend-portal
─────────────────            ─────────────────            ────────────────           ───────────────
calcula next_run do cron  →  GET /agents (catálogo+       ops_agent_status_view  →   AgentsDashboard
e persiste no config         missão+status+next_run)      (next_run_at real)         (card missão+próxima)
                             GET /agents/{k}/runs      →  ops_agent_run_history_view RunHistory panel
agentes computam horizonte   GET /findings/{id} inclui →  finding.* (+ horizonte)    FindingDetail
(days_to_breach) no finding  decision_preview derivado    finding (+ predicted_*)    (prévia + horizonte)
```

## 2. RF-1 — Ficha de missão (catálogo de agentes)

**★ Decisão:** catálogo **estático versionado** no worker/ops_api (não em `ops_agent_config`),
exposto por endpoint read-only. Sem migração de dados; muda junto com o código do agente.

- Novo módulo `temporal/src/agents/catalog.py` (ou `ops_api/agent_catalog.py`):
  `AGENT_CATALOG: dict[agent_key, AgentMission]` com:
  ```python
  AgentMission(
    agent_key, objective_key, analyzes_keys=[...], predicts_key,
    recommended_actions=[...],  # vocabulário real por agente
    assist_only=True, default_cadence_human_key,
  )
  ```
  Conteúdo textual fica em **i18n** (pt-BR/en-US) sob `labels.agentMissions.<key>`; o catálogo
  só guarda **chaves** + dados estruturais (ações, assist_only). Render via `useFindingLabels`.
- Os 4 agentes (vocabulário real já no código):
  | agent_key | objetivo | prevê | ações |
  |---|---|---|---|
  | vehicle-aging-analyst | Antecipar capital parado em estoque | dias até estourar 90d | monitor, markdown, transfer, prioritize_sale, wholesale_auction |
  | collections-prioritizer | Priorizar cobrança antes de virar perda | rolagem para faixa de atraso pior | (LLM; rótulos i18n) |
  | parts-inventory-advisor | Evitar ruptura/excesso de peças | dias até ruptura | replenish/observar (i18n) |
  | service-estimate-rescue | Recuperar orçamento de serviço antes de expirar | horas até orçamento perdido | contact_customer, offer_discount, reprice, escalate, monitor |
- **Endpoint:** `GET /api/ops/agents/catalog` (ou estender o payload de status). ★ Estender o
  **status** existente com `mission` embutido evita um segundo fetch no dashboard.

## 3. RF-2 — Próxima execução real

Problema: `next_run_at` lê string estática `schedule->>'next_run_at'`. Solução em 2 partes:

1. **Cálculo + persistência (worker):** na reconciliação de schedules (`reconcile_*` já chamam
   `schedule_handle.describe()`), capturar `desc.info.next_action_times[0]` e **gravar** em
   `ops_agent_config.schedule.next_run_at` (PATCH no config). A view atual já materializa esse
   campo → `next_run_at` passa a refletir o cron real, sem mudar a view.
   - **★ Robustez/fallback:** se Temporal/`next_action_times` indisponível, calcular a próxima
     ocorrência do `cron` em Python puro (implementação mínima de cron de 5 campos; sem nova
     dependência pesada — `croniter` é opcional e precisaria de ADR). Degradar para `null` nunca quebra.
   - Acontece na reconciliação periódica e no `run_now` (recalcula após disparo).
2. **Render (frontend):** `AgentsDashboard` passa a mostrar `next_run_at` + `cadence_human`
   (derivado do cron via util `cronToHuman`). Estado vazio: "sem execução agendada" quando
   `enabled=false` ou `next_run_at=null`.

**Cadência humana:** util `frontend-portal/src/portal/lib/cron.ts` → `cronToHuman(cron, locale)`
para os padrões usados no seed (diário, dias úteis, horário). Cobertura por testes verify-*.mjs.

## 4. RF-3 — Prévia de decisão (aceitar/recusar)

**★ Fonte única:** extrair o mapa ação→efeito hoje embutido em `execute_finding_action`
(vehicle-aging: `markdown`→executa preço; `transfer|prioritize_sale|wholesale_auction`→
`pending_execution`/disposition; `monitor`/desconhecido→no-op auditado) para uma função pura
`describe_action_effect(finding) -> DecisionPreview`, reutilizada por:
- `execute_finding_action` (não duplica regra), e
- a resposta de `GET /finding/{id}` (campo novo `decision_preview`).

`DecisionPreview` (serializado no finding):
```json
{
  "on_approve": { "effect_key": "vehicle_aging.markdown", "is_noop": false,
                  "value_impact": -12000.0, "audited": true, "assist_only": true,
                  "params": {"markdown_pct": 0.1} },
  "on_reject":  { "effect_key": "generic.monitor_noop", "is_noop": true,
                  "value_impact": 0.0, "audited": true, "assist_only": true }
}
```
- Para os **3 agentes assist-only** (collections/parts/service): `on_approve` é "registra a
  recomendação para acompanhamento (auditado, não executa no DMS)", `on_reject` é no-op auditado.
- `FindingDetail` renderiza dois blocos (Aprovar / Recusar) com rótulos i18n + `value_impact`,
  um selo "assist-only / auditado", antes dos botões.
- **AC-3** garante coerência com o que `finding_action` realmente grava.

## 5. RF-4 — Preditividade (horizonte)

**★ Campos novos no schema de finding de cada agente** (Pydantic + payload persistido):
`predicted_breach_at: datetime | None`, `days_to_breach: int | None`, e `severity` derivada.

Cálculo por agente (a partir de dados já disponíveis hoje):
| agente | horizonte | severidade (sugestão, calibrar no seed) |
|---|---|---|
| vehicle-aging | `days_to_breach = 90 - days_in_stock` (`predicted_breach_at = purchase_date+90d`) | ≤3d high · ≤15d attention · senão low |
| collections | projeção de rolagem: dias até cruzar próxima faixa (30/60/90) dado `days_overdue` | por faixa projetada |
| parts-inventory | `days_to_stockout = on_hand / avg_daily_demand` (quando demanda disponível) | ≤lead_time high |
| service-estimate | horas/dias até `valid_until`/janela de autorização | <24h high |

- Onde não houver dado para projetar, campos = `null` e o finding mantém o comportamento atual
  (sem regressão; AC-4).
- A severidade alimenta a ordenação já existente na fila/morning brief.
- **Não** muda `finding_type` nem o fingerprint de dedupe (preserva superseding da migração `20260627130000`).

## 6. RF-5 — Histórico de execuções

Fonte real: `public.ops_workflow_run` (run_id, started_at, finished_at, status, workflow_key,
tenant_id). Já alimenta os contadores da status view.

- **Migração nova:** `ops_agent_run_history_view` (security_invoker, tenant-scoped) = últimas N
  execuções por `agent_key` com `started_at, finished_at, status, duration`, e (se disponível
  em colunas/echo do run) `items_analyzed`/`findings_emitted`. Se essas métricas não existirem
  em `ops_workflow_run`, derivar `findings_emitted` por join em `finding` (created_at na janela).
- **Endpoint:** `GET /api/ops/agents/{agent_key}/runs?limit=N`.
- **UI:** painel "Histórico" no detalhe do agente (lista enxuta, mesmo polling de 10s).

## 7. Contratos (resumo)
- **DB (migrações novas):** (a) `ops_agent_run_history_view`; (b) sem alterar `ops_agent_status_view`
  (já materializa `next_run_at`) — apenas garantir que o worker a popula. Confirmar grants
  `authenticated` espelhando as views existentes.
- **ops_api:** `mission` no payload de status (ou `GET /agents/catalog`); `decision_preview` em
  `GET /finding/{id}`; `GET /agents/{k}/runs`.
- **frontend:** `AgentsDashboard` (missão + próxima execução + link histórico); `FindingDetail`
  (prévia + horizonte); `agentsApi.ts` tipos novos; i18n pt-BR/en-US; util `cron.ts`.

## 8. Plano de construção (por unidades, AI-DLC) — proposto, pós-aprovação
1. **U1 — Próxima execução real** (worker persiste next_run + `cron.ts`/render dashboard) — menor risco, valor imediato.
2. **U2 — Ficha de missão** (catálogo + i18n + card dashboard).
3. **U3 — Prévia de decisão** (refactor `describe_action_effect` + endpoint + FindingDetail).
4. **U4 — Preditividade** (schemas + lógica por agente + severidade + testes de contrato).
5. **U5 — Histórico** (view + endpoint + painel).
6. **Build & Test:** `pytest temporal/tests`, `npm run build && npm test` (frontend), `node --test supabase/tests/*.mjs`.
Cada unidade = PR pequeno e revisável (convenção do repo). Sugiro começar por **U1** como piloto ponta-a-ponta.

## 9. Testes (cobertura mínima)
- pytest: cálculo de next-run (cron + fallback), `describe_action_effect` para todas as ações,
  cálculo de horizonte por agente (limites de severidade), sem regressão de dedupe.
- supabase/tests: contrato de `ops_agent_run_history_view` (colunas, grants, tenant scope) e
  `ops_agent_status_view.next_run_at` populado.
- frontend verify-*.mjs: `cronToHuman`, render de próxima execução/estado vazio, render da prévia
  e do horizonte, rótulos i18n presentes (pt-BR/en-US) — anexados à lista de `npm test`.

## 10. Pendências para o aprovador decidir
- Confirmar **★ catálogo estático no código** (vs entity-store).
- Confirmar **★ horizonte como campo do finding** (vs derivado em view).
- `parts-inventory`/`collections` dependem de dados de demanda/aging disponíveis no seed? Se não,
  o horizonte fica `null` nesses até haver dado (degrade graceful) — ok?
- Ordem de construção: começar por **U1** (próxima execução) como piloto? 
