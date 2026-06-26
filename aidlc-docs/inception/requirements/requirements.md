# Requisitos — Agentes DIA: transparência + preditividade

> **Status:** Aguardando aprovação humana (gate AI-DLC spec-first).
> **Autor:** Copilot CLI (inception) · **Aprovador:** @rodrigoreisdealernet

## 1. Problema (na voz do dono/gestor da concessionária)

> "Recebo 'findings', mas **não sei o que cada agente faz**, **não sei quando ele roda de
> novo**, e **não sei o que acontece se eu aceitar ou recusar**. E os avisos chegam quando o
> problema **já aconteceu** — eu preciso saber **antes**, com tempo de agir."

Os 4 agentes são o **coração** do produto, mas operam como caixa-preta. Sem clareza e sem
antecipação, o operador não confia neles e o valor do sistema não se realiza.

## 2. Estado atual (evidências no código)

| Lacuna | Evidência |
|---|---|
| Missão de cada agente é invisível | A missão vive em `ops_agent_config.system_prompt`/`user_prompt_template`; nenhuma tela expõe objetivo, dados analisados, gatilhos ou vocabulário de ações. `AgentsDashboard.tsx` só mostra saúde/taxa/runs/delta. |
| Próxima execução não confiável e não exibida | `ops_agent_status_view.next_run_at` é lido de um campo **estático** `schedule->>'next_run_at'` (migração `20260607170000`), **não** calculado do cron. O worker chama `schedule_handle.describe()` mas **nunca grava** `nextActionTimes` de volta. `AgentsDashboard` tem o campo no tipo mas **não renderiza**. |
| Efeito de aceitar/recusar não é previsível | `FindingDetail.tsx` mostra `proposed_action` em texto livre; `finding_action` (migração `20260627130200`) registra o efeito **após** a aprovação. Não há **prévia** ("ao aprovar X acontece; ao recusar Y acontece") antes de decidir. |
| Alerta, não previsão | Findings descrevem **estado atual** (`stock_aging_90d`, `replenish_now`, `collections_priority`, `estimate_rescue`) sem **horizonte/lead-time** ("estoura em N dias"). |
| Histórico/observabilidade rasa | Há `ops_audit_trail_view` e contadores agregados, mas não um histórico por agente legível ao operador (últimas execuções, itens analisados, achados, falhas). |

## 3. Objetivos e não-objetivos

**Objetivos**
1. Todo agente expõe uma **ficha de missão** legível (pt-BR/en-US): o que faz, quais dados
   analisa, com que cadência roda, que ações pode recomendar, e o que NÃO faz (assist-only).
2. **Próxima execução real** calculada a partir do cron/Temporal, exibida com cadência humana
   ("a cada dia útil 06:00 · próxima: amanhã 06:00").
3. **Prévia de decisão** determinística no finding: o que acontece **ao aprovar** e **ao
   recusar**, incluindo valor em risco/recuperável e se é assist-only (no-op auditado).
4. Agentes passam a ser **preditivos**: cada finding carrega um **horizonte** (`days_to_breach`/
   `predicted_breach_at`) e a severidade reflete a **urgência projetada**, não só o estado.
5. **Histórico de execuções** por agente (últimas N): itens analisados, achados, falhas, duração.
6. **Robustez de produção**: cálculo de próxima-execução resiliente, prévia derivada de fonte
   única de verdade, sem regressão nas filas/auditoria existentes, com testes.

**Não-objetivos (desta iteração)**
- Edição de cron pela UI (`schedule_edit`) — fora do escopo escolhido.
- Tornar os agentes "ativos" (executar ações no DMS automaticamente) — permanecem **assist-only**.
- Reescrever o motor LLM/transport ou trocar o modelo.
- Mudar o modelo de entidades/SCD2 do banco além do necessário para o horizonte preditivo.

## 4. Personas
- **Dono da concessionária**: quer o panorama e confiança ("os agentes estão cuidando, e me
  avisam antes"). Consome o card de missão + próxima execução + KPIs.
- **Gestor de operação** (gerente de pátio, F&I, peças, oficina): decide findings; precisa da
  prévia de consequência e do horizonte para priorizar.

## 5. Requisitos funcionais (com critérios de aceite)

### RF-1 — Ficha de missão do agente
- **RF-1.1** Cada um dos 4 agentes tem metadados estruturados de missão: `objective`,
  `analyzes` (fontes/dados), `cadence_human`, `recommended_actions[]` (com rótulo i18n),
  `assist_only=true`, `predicts` (o que antecipa).
- **RF-1.2** Exposto via contrato read-only (view/endpoint) e renderizado no `AgentsDashboard`
  (expandível por card) e/ou em um painel de detalhe do agente.
- **AC-1**: Abrir o dashboard mostra, para cada agente, objetivo + cadência + "prevê: …" +
  lista de ações possíveis, em pt-BR e en-US, sem expor o system_prompt cru.

### RF-2 — Próxima execução real
- **RF-2.1** O worker calcula a próxima execução a partir do cron (via Temporal
  `schedule.describe().info.next_action_times` ou cálculo de cron) e a **persiste** de forma
  que `ops_agent_status_view.next_run_at` reflita o valor real.
- **RF-2.2** `AgentsDashboard` renderiza `next_run_at` + cadência humana; estado vazio claro
  quando o schedule está desabilitado.
- **AC-2**: Com um agente habilitado com cron `0 6 * * 1-5`, o dashboard mostra a próxima
  data/hora coerente com o cron; desabilitar o agente mostra "sem execução agendada".

### RF-3 — Prévia de decisão (aceitar/recusar)
- **RF-3.1** Cada finding expõe um bloco determinístico `decision_preview` com dois ramos:
  `on_approve` e `on_reject`, cada um com `effect_label` (i18n), `is_noop` (assist-only),
  `value_impact` (recuperável/exposição) e `audited=true`.
- **RF-3.2** `FindingDetail` mostra esse bloco antes dos botões Aprovar/Recusar.
- **AC-3**: Em um finding de vehicle-aging com ação `markdown`, a prévia diz "Ao aprovar:
  registra recomendação de markdown de R$X (auditado, assist-only — não altera preço no DMS).
  Ao recusar: nenhuma ação, monitorado e auditado." Coerente com o que `finding_action` grava.

### RF-4 — Preditividade (horizonte/lead-time)
- **RF-4.1** O schema de finding de cada agente ganha campos de horizonte:
  `predicted_breach_at` (timestamptz) e/ou `days_to_breach` (int), além de `severity` derivada
  da urgência projetada.
- **RF-4.2** A lógica de cada agente passa a computar o horizonte a partir dos dados já
  disponíveis (ver design por agente). Severidade segue thresholds documentados.
- **AC-4**: Um veículo com 75 dias em estoque gera finding com `days_to_breach≈15` e severidade
  "attention"; com 88 dias → `days_to_breach≈2` e severidade "high". Sem horizonte calculável,
  o campo é nulo e o finding cai para o comportamento atual (sem regressão).

### RF-5 — Histórico de execuções
- **RF-5.1** Endpoint/registro read-only das últimas N execuções por agente: início, fim,
  status, itens analisados, achados gerados, falhas.
- **RF-5.2** UI: painel "Histórico" por agente (lista enxuta, polling coerente com o atual 10s).
- **AC-5**: Após 3 execuções, o histórico lista as 3 com status e contagem de achados.

## 6. Requisitos não-funcionais
- **Compatibilidade**: contratos atuais (`getFindings` status `pending_approval`, views de KPI,
  auditoria) **não podem regredir**. Campos novos são aditivos/nulos por padrão.
- **i18n**: tudo renderizado via `useFindingLabels()`/`use-intl` (pt-BR + en-US), nunca chaves cruas.
- **DB**: migrações **novas** (não editar publicadas), snake_case, aditivas/reversíveis,
  `create or replace view` mantendo a lista completa de colunas.
- **Logs**: uma linha, estruturados (regra do repo).
- **Robustez**: cálculo de next-run tolerante a Temporal indisponível (degrada para nulo, não quebra).
- **Testes**: pytest (`temporal/tests`), verify-*.mjs (frontend), e testes de contrato SQL
  (`supabase/tests`) para as views alteradas.

## 7. Riscos e mitigação
| Risco | Mitigação |
|---|---|
| `next_action_times` indisponível offline/sem Temporal | Fallback: calcular próxima ocorrência do cron em Python puro (croniter-like) e/ou persistir na reconciliação; nunca quebrar a view. |
| Mudar schema de finding quebra dedupe/auditoria | Campos aditivos e nulos; manter `finding_type` e fingerprint atuais; testes de contrato. |
| Prévia divergir do efeito real | Derivar `decision_preview` da **mesma** fonte que `execute_finding_action` (mapeamento único ação→efeito). |
| Severidade preditiva inflar a fila | Thresholds documentados + preservar superseding; revisar com seed real. |

## 8. Decisões em aberto para o aprovador
1. **Onde mora a ficha de missão?** (a) `ops_agent_config` (entity-store) estendido vs (b)
   catálogo estático versionado no worker exposto por endpoint. *Recomendação: (b)* — versionável,
   sem migração de dados, e independente de seed. 
2. **Horizonte: campo no schema do finding** vs **derivado na view**. *Recomendação: campo no
   schema* (a predição é responsabilidade do agente, não da apresentação).
3. **Histórico**: reusar `ops_run`/auditoria existente ou view nova dedicada? (a definir no design).
