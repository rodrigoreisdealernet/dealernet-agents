# Spec — #118: Revalidar agente `vehicle-aging-analyst` ponta-a-ponta

## Overview
Revalidação ponta-a-ponta do agente DIA **vehicle-aging-analyst** (Analista de Estoque Parado / floor-plan 90 dias) para garantir que disparo manual, execução do workflow, geração de findings e ações pós-resultado (markdown, disposição e dismiss) continuam funcionando 100% antes da demo. O foco é **não-regressão** após a generalização do disparo manual da #115 — nenhuma funcionalidade nova é entregue, apenas confirmação e correção de eventuais quebras.

## Problem / Context
Este é um dos 4 agentes DIA da demo e, diferentemente dos outros, já tem o disparo manual mapeado (`_MANUAL_RUN_WORKFLOWS["vehicle-aging-analyst"]` em `temporal/src/ops_api/app.py`) e a ação pós-resultado implementada (`execute_finding_action` para `stock_aging_90d`). A #115 generalizou o dispatch de "Executar agora" usando um mapa `agent_key → (workflow, input_factory)`; se esse mapeamento direto perder a entrada `vehicle-aging-analyst`, o "Executar agora" cai no fallback de schedule e retorna conflito/erro (o schedule recorrente é mantido **desabilitado / assist-only**). A revalidação confirma que o caminho direto permanece intacto e que toda a cadeia scope → assess → dedupe → record → finalize e as ações de aprovação seguem corretas.

## Acceptance Criteria
- [ ] **Executar agora sem regressão:** `POST /api/ops/agents/vehicle-aging-analyst/run` com `{"locale":"pt-BR"}` retorna `202` com `status:"started"` e um `workflow_id`, iniciando o `VehicleAgingWorkflow` diretamente (não cai no fallback de schedule, sem `409`).
- [ ] **Pipeline completo:** o workflow percorre scope → assess → dedupe → record → finalize e grava os findings escopados (`demo-dia-vehicle-%`) com `status='pending_approval'` e `finding_type='stock_aging_90d'`, visíveis em `ops_agent_status_view` e `ops_finding_kpis`.
- [ ] **Ação recomendada válida e dedupe:** todo finding tem `recommended_action` dentro de `{monitor, markdown, transfer, prioritize_sale, wholesale_auction}`, respeitando os thresholds de aging (warning/breach) e os bounds de máximo por run; uma re-execução não duplica findings (fingerprint deduplicado).
- [ ] **Aprovar markdown:** aprovar um finding de `markdown` aplica um novo `sale_price` em uma nova versão SCD2 do veículo, registra `finding_action` com status `executed` e gera auditoria `vehicle_action_executed`, de forma idempotente (no máximo um `finding_action` por finding).
- [ ] **Aprovar disposição e dismiss:** aprovar `transfer`/`prioritize_sale`/`wholesale_auction` grava a disposição numa nova versão SCD2 com `finding_action` em `pending_execution` (sem alterar preço); `dismiss` registra auditoria `vehicle_finding_dismissed` sem mover preço; `monitor` registra sem alterar preço.
- [ ] **Assist-only preservado:** o schedule recorrente do `vehicle-aging-analyst` permanece desabilitado (nenhuma execução automática é provisionada/habilitada por esta mudança).

## Non-Goals
- Não habilitar nem agendar a execução recorrente automática do agente (continua assist-only).
- Não alterar o modelo do LLM, prompts, thresholds padrão ou o conjunto de ações recomendadas.
- Não introduzir auto-aplicação de ações: toda disposição continua exigindo aprovação humana.
- Não alterar o comportamento de outros agentes DIA (revrec, pm-evaluator, demais).

## Out-of-Scope
- A generalização do dispatch de disparo manual em si (#115) e as revalidações dos demais agentes (#116, #117).
- Mudanças no frontend-portal além do necessário para confirmar a exibição existente (`agentsApi.ts`, `AgentsDashboard.tsx`).
- Qualquer evolução do esquema de banco/contrato SQL além de validar o contrato de estoque existente (`supabase/tests/vehicle_aging_contract.test.mjs`).

---

> ⚠️ **DRAFT — requer aprovação humana antes de qualquer código ser escrito.** Esta especificação é um rascunho produzido pelo agente Spec (passo 01) e não é final até ser revisada e aprovada por um humano.
