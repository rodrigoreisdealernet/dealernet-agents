# Revisão do schema Supabase — o que se aplica ao DIA vs. o que é herança Wynne

> **Status:** EXECUTADO — 2026-06-25 (poda agressiva ao núcleo DIA aplicada via
> `supabase/migrations/20260625120000_dia_core_prune_wynne_domain.sql`; o `frontend/`
> dia-frontend foi removido). Ver §5 para o resultado verificado.
> **Contexto:** o schema deste repositório foi semeado da *"10x Wynne ops platform base"*
> (commit `981c6ad`), um ERP de **locação de equipamentos** (problema RentalMan). O produto
> alvo é o **DIA — Dealernet Intelligence Agents**: o ativo reutilizável **não é o domínio de
> locação**, e sim o **padrão Operations Factory** (loop *investigate → propose → approve →
> write → audit*, `finding` → `disposition`, multi-tenant, config-in-DB, audit trail) —
> conforme [PRD §1.2](../PRD-portal-dms-frontend-acoplamento.md).
> Esta revisão classifica todo o schema e propõe um caminho de limpeza **seguro e gradual**.

## 1. Dimensão atual

| Objeto | Qtd | Onde |
|---|---|---|
| Migrations | 176 | `supabase/migrations/*.sql` |
| Tabelas (dedicadas) | ~125 | — |
| Views | 145 | — |
| Functions / RPCs | 187 | — |

As entidades de negócio "core" do Wynne (assets, customers, contracts, rental orders,
invoices, maintenance) **não são tabelas dedicadas** — vivem no **modelo genérico**
`entities` / `entity_versions(data jsonb)` / `relationships_v2` (EAV + grafo + SCD2). As ~125
tabelas dedicadas são, na maioria, **expansões de domínio Wynne** adicionadas nas migrations de
junho/2026 (conectores de integração, procurement, accounting/tax, dispatch, manutenção,
compliance, rerent, projetos…).

## 2. O que o DIA realmente usa (verificado)

### 2.1 Portal DIA (`frontend-portal`) — 6 views
`agentsApi.ts` consome **apenas**: `ops_agent_status_view`, `ops_finding_kpis`,
`ops_findings_view`, `ops_audit_trail_view`, `ops_agent_config_current`, `v_home_dashboard_kpis`.

Dependências reais dessas views (lidas nas definições):
- views `ops_*` → `finding`, `tenants`, `ops_agent_config`, `ops_workflow_run` + `entities` /
  `entity_versions` + `time_series_points` / `fact_types`.
- `v_home_dashboard_kpis` → views `rental_current_assets`, `v_rental_contract_line_current`,
  `rental_current_entity_state` — **todas sobre o modelo de entidades**, não sobre tabelas
  dedicadas Wynne.

**Conclusão:** o portal DIA roda 100% sobre o modelo de entidades + analytics + Operations
Factory. **Nenhuma** das ~110 tabelas dedicadas Wynne é tocada pelo portal.

### 2.2 Seed demo (`supabase/seed.sql`)
Insere em: `entities`, `entity_versions`, `relationships_v2`, `fact_types`, `entity_facts`,
`time_series_points`, `tenants`, `ops_agent_config`, `ops_workflow_run`, `finding`,
`invoice_adjustment_draft`, `credit_change_proposal`, `ops_output_schema_registry`,
`portal_contract_scope_tokens`, `portal_intake_scope_tokens`, `fx_rates`. RPCs:
`create_entity_with_version`, `rental_upsert_entity_current_state`.

### 2.3 ops-api (`temporal/src/ops_api`)
Bridge de disposição grava em `finding` / `invoice_adjustment_draft` / `credit_change_proposal`
(Operations Factory). Sem dependência das tabelas dedicadas Wynne.

## 3. Classificação

### 3.1 MANTER — núcleo DIA (fundação do portal + Operations Factory)
| Grupo | Tabelas |
|---|---|
| Modelo de entidades (SCD2) | `entities`, `entity_versions`, `relationships_v2` |
| Camada analítica | `fact_types`, `entity_facts`, `time_series_points` |
| Auth / perfis | `profiles` |
| Operations Factory | `tenants`, `ops_agent_config`, `ops_workflow_run`, `finding`, `invoice_adjustment_draft`, `credit_change_proposal`, `ops_output_schema_registry` |
| Scope tokens (seed/portal) | `portal_contract_scope_tokens`, `portal_intake_scope_tokens` |
| Câmbio (seed) | `fx_rates` |

Mais as **views sobre o modelo de entidades** que alimentam o portal: `rental_current_*`,
`v_rental_contract_line_current`, `rental_current_entity_state`, `v_home_dashboard_kpis` e as
views `ops_*`. (São views, não tabelas — baratas e necessárias ao demo.)

### 3.2 HERANÇA WYNNE — candidatas a remoção (não tocadas pelo DIA)
~110 tabelas, agrupadas por domínio:

- **Conectores de integração** (cada um ≈ `*_sync_events` + `*_dead_letter_queue` +
  `*_sync_controls` + `*_reconciliation_results`): **Coupa, Samsara, VisionLink, NetSuite,
  BillTrust, Sage, PowerBI, SmartEquip, MuleSoft, Descartes**, + framework genérico
  (`integration_config`, `integration_delivery_log`, `external_id_map`,
  `integration_sync_state`, `integration_config_audit`), + `rapidcount_offline_queue`.
- **Procurement:** `procurement_*` (templates de aprovação, requisições, recibos, faturas de
  fornecedor, PO match, warranty, políticas de autorização).
- **Accounting / Ledger / Tax:** `accounting_posted_ledger_entries`, `accounting_posting_rules`,
  `journal_entries`, `journal_entry_lines`, `accounting_export_config`/`_runs`,
  `tax_jurisdictions`, `tax_jurisdiction_rates`, `invoice_tax_snapshots`,
  `invoice_tax_jurisdiction_snapshots`, `invoice_line_tax_snapshots`.
- **Dispatch / Logística / Field:** `dispatch_routes`, `route_stops`, `route_stop_exceptions`,
  `logistics_telematics_events`, `dvir_submissions`, `stop_pod_bundles`,
  `delivery_complaint_cases`, `live_yard_projection_feed`.
- **Manutenção:** `maintenance_cost_lines`, `preventative_maintenance_policies`,
  `pm_work_orders`, `inspection_checklist_templates`.
- **Rerent / inbound rerental:** `dim_rerent_unit_status`, `rerent_unit_status_log`,
  `dim_inbound_rerental_*`, `inbound_rerental_*`.
- **Projetos:** `dim_project_equipment_*`, `project_equipment_lifecycle_log`,
  `project_assignment_readiness_audit`.
- **Compliance:** `driver_qualification_records`, `hos_exception_log`, `operator_cert_records`,
  `personnel_training_records`, `compliance_subject_records`, `compliance_rule_inputs`.
- **Crédito / Lien:** `credit_application`, `lien_deadline_obligation`, `lien_waiver_obligation`.
- **Quoting / inventory rate:** `quote_fee_presets`, `quote_tax_presets`, `staff_quote_drafts`,
  `inventory_rate_plans`, `inventory_rate_plan_specials`, `storefront_quote_requests`.
- **Billing / fleet ops:** `billing_update_request`, `portal_billing_update_scope_tokens`,
  `portal_customer_access_grant`, `fleet_disposition_handoff_draft`.
- **Org hierarchy:** `org_scope_closure`.
- **Dimensões de status rental:** `dim_rental_order_status`, `dim_rental_contract_status`,
  `dim_rental_line_status`, `dim_asset_availability_status`, `dim_rental_rate_type`,
  `dim_rental_type` (pequenas tabelas de lookup; revisar se o demo de KPIs as usa via join).

## 4. Riscos da remoção (por que é uma decisão de produto, não mecânica)

1. **Sistema já deployado.** dev (`dia-supabase`) e UAT (`dia-supabase-test`) já têm as
   migrations aplicadas. Migrations são **append-only**: remover = **nova migration `drop`**,
   não editar/apagar as antigas.
2. **Cascata grande.** As ~110 tabelas alimentam ~100+ views/RPCs/triggers. `DROP ... CASCADE`
   derruba tudo isso de uma vez — superfície grande e propensa a erro.
3. **Quebra o `frontend/` (dia-frontend).** O PRD mantém o dia-frontend como **referência de
   contrato de dados**; suas ~68 rotas (dispatch, accounting, tax, field, procurement,
   compliance…) consomem exatamente essas views/RPCs. Remover as tabelas quebra essa referência.
4. **CI gates herdados.** Há ADRs e testes de contrato (ex.: `0108-samsara-*`, `0109-portal-
   financials-*`) e o teste `test_supabase_api_access_contract.py` que cobrem objetos Wynne;
   removê-los exige limpar gates correspondentes.

## 5. O que foi executado (poda agressiva)

Decisão do dono do produto: **podar ao núcleo DIA** e **descartar o `frontend/` (dia-frontend)**.

Aplicado numa única migration append-only dirigida por allowlist
(`20260625120000_dia_core_prune_wynne_domain.sql`): tudo em `public` fora das listas de
manutenção é dropado com `CASCADE`; as duas RPCs de escrita do modelo de entidades que tinham
efeitos colaterais Wynne (closure de org-scope, log de custódia rerent) foram redefinidas limpas.

### Resultado verificado (`supabase db reset` — 176 migrations + poda + seed, exit 0)
| Objeto | Antes | Depois |
|---|---|---|
| Tabelas (public) | ~125 | **17** |
| Views | 145 | **14** |
| Functions | 187 | **26** |

As 6 views do portal retornam os dados seedados (verificado): `finding`=509, `ops_finding_kpis`=2
tenants, `ops_agent_status_view`=2 agentes, `ops_audit_trail_view`=51, `v_home_dashboard_kpis`=1
(12 ativos alugados, 30% utilização, R$22.248 receita do período). RLS segue habilitada nas 15
tabelas-núcleo. O teste de contrato (`test_supabase_api_access_contract.py`) foi ajustado para o
núcleo, e o CI (`ci.yml`) foi reapontado de `frontend/` para `frontend-portal/`.

### Não incluído (follow-up consciente)
- **Código Wynne no `temporal/` worker** (accounting/journal, conectores, procurement,
  dispatch…): agora órfão do schema, mas o worker está *escalado a 0* com schedules desabilitadas
  (kill-switch), então nada quebra em runtime. Re-domínio do worker é trabalho separado.
- **Migrations 1–176 permanecem** como histórico append-only (replay em dev/UAT já deployados);
  o `db reset` constrói o schema Wynne e a poda o reduz ao núcleo. Consolidar num baseline limpo é
  opcional e fora do escopo desta revisão.
- **Docs herdadas** (README/ADRs/specs) que descrevem o domínio rental são registros históricos;
  só as referências carregadas/quebradas (repo-map, tabela de testes, AGENTS.md) foram atualizadas.
</content>
</invoke>
