# Spec — Issue #128: Histórico de execuções por agente DIA (`ops_agent_run_history_view`) [U5]

## Overview
Adicionar uma visão de **histórico de execuções por agente** para que o gestor da concessionária veja as últimas execuções de cada agente DIA (início, fim/duração, status e número de achados gerados). Hoje as execuções existem em `public.ops_workflow_run`, mas só alimentam contadores agregados na `ops_agent_status_view`; não há lista legível execução-a-execução. A entrega cobre uma nova view de banco, um endpoint de leitura no `ops_api` e um painel "Histórico" no detalhe do agente.

## Problem / Context
Unidade U5 (observabilidade). O operador não tem transparência sobre o que cada agente fez ao longo do tempo: quando rodou, se teve sucesso ou falhou, quanto tempo levou e quantos achados produziu. Os dados já estão persistidos (`ops_workflow_run` com `started_at`/`finished_at`/`status`/`counts`, e `finding` ligada por `run_id`/`agent_key`), porém são consumidos apenas de forma agregada. Sem uma linha-do-tempo por agente, o gestor não consegue auditar comportamento, diagnosticar falhas recorrentes nem confirmar produtividade — fechando uma lacuna de confiança/transparência.

## Acceptance Criteria
- [ ] **AC1 — Lista de histórico por agente.** Ao abrir um agente, o gestor vê uma lista das últimas N execuções, cada uma exibindo: data/hora de início, fim (ou duração), status e a quantidade de achados gerados naquela execução. A lista respeita o limite `N` solicitado.
- [ ] **AC2 — Ordenação cronológica.** As execuções aparecem da mais recente para a mais antiga (por horário de início).
- [ ] **AC3 — Contagem coerente após múltiplas execuções.** Após 3 execuções de um agente, o histórico mostra exatamente essas 3 linhas, cada uma com o status correto e a contagem de achados correspondente àquela execução.
- [ ] **AC4 — Isolamento por concessionária (tenant-scoped).** Cada concessionária vê somente o histórico das suas próprias execuções; execuções de outros tenants nunca aparecem.
- [ ] **AC5 — Somente leitura.** O histórico é estritamente de leitura para o usuário autenticado; não há ação que altere, crie ou apague execuções a partir dele.
- [ ] **AC6 — Estados de UI e bilíngue.** O painel apresenta estados de carregando, erro e vazio de forma clara, e todos os rótulos estão disponíveis em pt-BR e en-US; a lista atualiza por polling consistente com as demais telas de agentes (10s).
- [ ] **AC7 — Sem regressão.** As views e KPIs existentes (ex.: `ops_agent_status_view` e seus contadores `total_runs`/`succeeded_runs`/`failed_runs`/`pending_findings`) continuam retornando os mesmos resultados de antes.

## Non-Goals
- Não introduzir métricas avançadas de telemetria de tokens/custo de LLM (já cobertas por `ops_llm_usage`).
- Não criar paginação infinita, exportação (CSV/PDF) ou filtros avançados do histórico — apenas as últimas N execuções.
- Não permitir reexecutar, cancelar ou editar execuções a partir do painel de histórico.
- Não alterar a forma como execuções são gravadas em `ops_workflow_run`.

## Out-of-Scope
- Drill-down execução→achados individuais (lista de findings de uma execução específica) — fora desta entrega.
- Alertas/notificações sobre falhas de execução.
- Gráficos de tendência/agregação histórica (taxa de sucesso ao longo do tempo).
- Alterações no esquema de `ops_workflow_run` ou em migrações já publicadas (a entrega usa migração nova com timestamp único).

## Notas de implementação (grounding de schema, confirmado por leitura do código)
- `public.ops_workflow_run`: `run_id` (pk), `tenant_id`, `workflow_key`, `started_at`, `finished_at`, `status`, `counts` (jsonb), `created_at`; RLS habilitado; `select` para `authenticated`. **A coluna de agente é `workflow_key`** (não `agent_key`).
- `ops_agent_status_view` junta runs em `r.workflow_key = c.agent_key` e usa `security_invoker = true`.
- `public.finding`: `run_id`, `agent_key`, `tenant_id`, `created_at` — usar para `findings_emitted` (contagem por `run_id`).
