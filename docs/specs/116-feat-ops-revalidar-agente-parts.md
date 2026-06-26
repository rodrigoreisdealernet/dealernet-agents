# Spec — Revalidar `parts-inventory-advisor` ponta-a-ponta + corrigir HTTP 409 "Executar agora" (#116)

## Overview
O botão **"Executar agora"** do agente **parts-inventory-advisor** (Reposição de
Estoque de Peças) no Painel de Agentes deve iniciar o workflow do agente em vez
de falhar com HTTP 409. A correção generalizada de disparo manual (#115)
registrou 5 agentes em `_MANUAL_RUN_WORKFLOWS`, mas **não incluiu**
`parts-inventory-advisor`; com `locale` presente, esse agente cai no fallback de
`schedule.trigger()` sobre um schedule nunca provisionado (assist-only off por
padrão) → `NOT_FOUND` → 409.

## Problem / Context
- `runAgentNow` envia `locale`. Em `temporal/src/ops_api/app.py::run_agent_now`,
  `locale is not None` entra no ramo de start direto, consultando
  `_MANUAL_RUN_WORKFLOWS.get(agent_key)`.
- `parts-inventory-advisor` não está no mapa → `registered is None` → cai no
  `get_schedule_handle(...).trigger(...)`. O seed ship `schedule.enabled=false` e o
  worker não cria o schedule → `RPCStatusCode.NOT_FOUND` → `AgentScheduleNotProvisioned`
  → 409 na rota.
- `PartsInventoryWorkflowInput` é tenant-only (`tenant_id`, janela opcional); como
  `service-estimate-rescue`, ignora `locale`.
- O fluxo de decisão (approve/reject/dismiss) já trata findings `replenish_now`:
  `execute_finding_action` retorna `{"executed": False, "skipped": True}` para
  qualquer `finding_type != "stock_aging_90d"`, persistindo disposição + auditoria
  sem efeito colateral (assist-only). Comportamento já correto; falta documentá-lo.

## Acceptance Criteria
1. **AC1 — 409 corrigido:** `parts-inventory-advisor` está registrado em
   `_MANUAL_RUN_WORKFLOWS`, mapeando para `PartsInventoryWorkflow.run` com uma
   input-factory `(tenant_id, locale) -> PartsInventoryWorkflowInput(tenant_id=...)`
   tenant-only. Um disparo manual com `locale` não-nulo retorna `status="started"`
   (HTTP 202), não 409, e inicia exatamente um workflow.
2. **AC2 — input tenant-only:** o workflow é iniciado com
   `PartsInventoryWorkflowInput` contendo apenas `tenant_id`; `locale` não vaza para
   a input (sem atributo `locale`). O `workflow_id` segue o padrão
   `ops:<tenant>:parts-inventory-advisor:manual:<ts>`.
3. **AC3 — fallback preservado:** com `locale is None`, o caminho permanece o
   schedule-trigger (`status="triggered"`), sem iniciar workflow diretamente; o
   recurring schedule (assist-only, off) nunca é habilitado. Nenhum outro agente
   registrado regride.
4. **AC4 — decisão idempotente sem 500:** approve/reject/dismiss de um finding
   `replenish_now` deste agente persiste disposição + auditoria, é idempotente e
   nunca retorna 500; `execute_finding_action` reporta `skipped`/assist-only.
5. **AC5 — assist-only documentado:** o comportamento pós-aprovação assist-only
   para findings `replenish_now` (sem criação de PO/requisição; `auto_apply` forçado
   `False`) está documentado no código (docstring de `execute_finding_action`).
6. **AC6 — teste de regressão:** existe teste provando que o disparo manual de
   `parts-inventory-advisor` inicia (202/`started`) em vez de 409, mais guardas de
   no-regression para o fallback e demais agentes.

## Non-Goals
- Habilitar o schedule recorrente (`schedule.enabled` permanece `false`).
- Alterar `supabase/seed.sql` ou `temporal/src/worker.py`.
- Implementar efeito concreto de compra/PO/requisição (assist-only; a PRD exige
  recomendação apenas, `auto_apply=False`).
- Alterar a lógica de scope/assess/dedupe do workflow (já entregue).

## Out-of-scope
- Mudanças de UI no Painel de Agentes além do disparo já existente.
- Outros agentes DIA fora `parts-inventory-advisor`.
