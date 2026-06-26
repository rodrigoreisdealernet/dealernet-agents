# Disparo Imediato ("Executar Agora") para Agentes Ops

**STATUS: DRAFT — Requer aprovação humana antes de qualquer desenvolvimento.**

## Overview

Prover um mecanismo unificado e seguro para disparar imediatamente a execução de qualquer agente ops existente (revrec-analyst, pm-evaluator, vehicle-aging, etc.) sem esperar a próxima janela do cron agendado. O disparo reutiliza o mecanismo nativo do Temporal (`schedule.trigger()`) em vez de duplicar lógica por agente.

## Problem / Context

Hoje os operadores que querem ver o resultado de um agente **fora da janela agendada** precisam esperar o próximo tick do cron. Os únicos disparos manuais existentes são ad-hoc por agente (endpoints específicos para `branch-morning-brief` e `territory-brief`), sem forma unificada. Não há superfície na UI (`AgentsDashboard`) para "executar agora", mesmo que o agente já exista.

**O objetivo** é oferecer uma forma **unificada, observável e auto-serviço** de disparar qualquer agente sem mudar o schedule/cron existente.

## Acceptance Criteria

- [ ] **Um operador autenticado consegue disparar um agente existente via um endpoint genérico `POST /api/ops/agents/{agent_key}/run`**, receber 202 Accepted, e em seguida ver a execução refletida no dashboard (último run atualizado) sem esperar o cron.

- [ ] **O disparo funciona de forma unificada para múltiplos agentes ops** (revrec-analyst, pm-evaluator, vehicle-aging, fleet-auditor, credit-risk, etc.) via um único endpoint parametrizado, reutilizando a ação/args/overlap policy que o schedule já define.

- [ ] **Disparar um `agent_key` inválido, inexistente ou cujo schedule não foi provisionado retorna erro claro** (404 ou 422 conforme apropriado), sem genérico 500.

- [ ] **O disparo respeita escopo de tenant e autorização**: um usuário consegue disparar apenas agentes do seu próprio tenant, e precisa ter role em `{admin, branch_manager, field_operator}` + permissão `can_operate=true`.

- [ ] **Disparos concorrentes do mesmo agente/tenant não geram execuções duplicadas sobrepostas**, reusando a overlap policy (SKIP) do schedule.

- [ ] **O AgentsDashboard oferece ação "Executar agora" por agente** com feedback de sucesso/erro e refresh do status via polling existente (10s).

## Non-Goals

- Não alterar definições de cron ou mecanismo de reconcile do `worker.py`.
- Não introduzir auto-aprovação de findings; fluxo de aprovação humana permanece inalterado.
- Não criar novos agentes — apenas disparar os já existentes.
- Não adicionar agendamento ad-hoc/custom; somente "executar agora".

## Out-of-Scope

- Mudanças de deploy/infra (Kubernetes, Helm, Azure).
- Modificação de políticas de overlap ou timeout dos schedules.
- Suporte a parâmetros customizados por disparo manual (input args fixos via schedule).

---

**NOTA**: Este documento é um DRAFT. Requer validação e aprovação de um product owner / tech lead antes de qualquer implementação.
