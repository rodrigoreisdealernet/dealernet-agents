# Spec — #117 collections-prioritizer: corrigir HTTP 409 "Executar agora" + revalidar ponta-a-ponta

## Overview
O botão **"Executar agora"** do agente **collections-prioritizer** (Priorização de
Cobrança) no Painel de Agentes deve iniciar o workflow em vez de falhar com HTTP 409.
A correção segue o mesmo padrão genérico de disparo manual entregue em #115 (LEAD),
registrando o agente no mapa `_MANUAL_RUN_WORKFLOWS`.

## Problem / Context
`runAgentNow` envia `locale`, então `run_agent_now` entra no ramo de start direto
(`locale is not None`). Esse ramo consulta `_MANUAL_RUN_WORKFLOWS`, que **não inclui**
`collections-prioritizer`. Com `registered is None`, o fluxo cai no fallback
`schedule.trigger()` sobre um schedule inexistente (seed `schedule.enabled=false`; o
worker não o cria) → `NOT_FOUND` → **409** "Agent ... is disabled or schedule not
provisioned". O schedule recorrente **não** deve ser habilitado (assist-only).

O input do workflow (`CollectionsPrioritizerWorkflowInput`) é tenant-only, sem `locale`
— igual ao `service-estimate-rescue` já registrado.

## Acceptance Criteria
1. "Executar agora" do `collections-prioritizer` (`POST /api/ops/agents/collections-prioritizer/run` com `{"locale":"pt-BR"}`) retorna **202** com `status:"started"` e `workflow_id`, em vez de 409, iniciando `CollectionsPrioritizerWorkflow.run`.
2. O schedule recorrente do agente **não** é habilitado; nenhuma mudança em `seed.sql` nem em `worker.py`.
3. `recommended_action` permanece restrito ao conjunto permitido e re-run não duplica (dedupe por fingerprint) — comportamento já existente do workflow, não regredido pela correção.
4. approve/reject/dismiss de finding `collections_priority` persiste a disposição + auditoria, é idempotente e **não** retorna 500 (a ação concreta permanece `{skipped:true}`, assist-only).
5. O comportamento assist-only pós-aprovação para `collections_priority` é **documentado** no código (docstring de `execute_finding_action`), sem implementar efeito concreto (PRD não exige movimentação/contato).

## Non-Goals
- Habilitar o schedule recorrente do agente.
- Implementar efeito concreto pós-aprovação (movimentação de dinheiro, SMS/outbound) para `collections_priority`.
- Alterar a lógica de scope/assess/dedupe/record do workflow.

## Out-of-scope
- Mudanças em `seed.sql`, `worker.py`, ou no frontend (o front já envia `locale`).
- Demais agentes não cobertos por #115.
