// agentsApi.ts — camada de dados NOVA da POC.
// Conecta o shell Portal DMS ao backend Supabase do dealernet-agents (Operations
// Factory). Espelha o contrato do dia-frontend (frontend/src/data/supabase.ts +
// frontend/src/pages/ops-*.json) e o endpoint de decisão da ops-api
// (temporal/src/ops_api/app.py → POST /api/ops/findings/decision). Sem GeneXus,
// sem TanStack Query — leituras simples por view + polling trivial nas telas.
//
// Charter: "agents propose; humans dispose" — leitura é direta via RLS (Bearer JWT);
// a ESCRITA (decisão) NUNCA vai ao PostgREST: passa pela ops-api (fonte da verdade).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const ENV = import.meta.env as unknown as Record<string, string | undefined>

// ── Cliente Supabase (singleton) — espelha frontend/src/data/supabase.ts ──
const SUPABASE_URL = ENV.VITE_SUPABASE_URL || 'http://127.0.0.1:54331'
const SUPABASE_ANON_KEY = ENV.VITE_SUPABASE_ANON_KEY || ''

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
})

// ── Auth POC: login programático do usuário demo (ver PRD §4) ──
export function signInDemo() {
  return supabase.auth.signInWithPassword({
    email: ENV.VITE_DEMO_EMAIL || 'admin@dia-rental.dev',
    password: ENV.VITE_DEMO_PASSWORD || '',
  })
}

export async function hasSession(): Promise<boolean> {
  const { data } = await supabase.auth.getSession()
  return Boolean(data.session)
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export function signOut() {
  return supabase.auth.signOut()
}

// ── Tipos leves (shapes vindos das views) ──
export interface AgentStatus {
  tenant_id: string
  agent_key: string
  enabled: boolean
  last_run_id: string | null
  last_run_started_at: string | null
  last_run_finished_at: string | null
  last_run_status: string | null
  next_run_at: string | null
  total_runs: number
  succeeded_runs: number
  failed_runs: number
  pending_findings: number
  has_pending_badge: boolean
  identified_delta: number | null
  reporting_currency_code?: string | null
}

export interface FindingKpis {
  tenant_id?: string
  pending_count: number
  recoverable_delta: number
  approved_this_cycle: number
  findings_last_24h: number
  reporting_currency_code?: string | null
}

export interface FindingRow {
  id: string
  agent_key: string
  finding_type: string
  severity: string
  status: string
  contract_label: string | null
  line_item_label: string | null
  customer_name: string | null
  delta: number | null
  confidence: number | null
  created_at: string
}

export interface FindingDetail extends FindingRow {
  run_id: string | null
  workflow_id: string | null
  contract_id: string | null
  line_item_id: string | null
  expected: Record<string, unknown> | null
  expected_amount: number | null
  billed: Record<string, unknown> | null
  billed_amount: number | null
  evidence: Array<Record<string, unknown>> | null
  proposed_action: string | null
  rationale: string | null
}

export interface AuditEvent {
  row_id: string
  entity_id: string
  entity_type: string | null
  entity_name: string | null
  fact_key: string | null
  fact_label: string | null
  observed_at: string
  data_payload: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  source_id: string | null
  point_order: number | null
}

export interface HomeKpis {
  as_of: string | null
  assets_on_rent: number
  fleet_utilization_pct: number
  overdue_returns_count: number
  open_maintenance_count: number
  period_revenue: number
  prior_period_revenue: number
  available_assets: number
  unavailable_assets: number
  total_assets: number
}

interface PgResponse<T> {
  data: T | null
  error: { message: string } | null
}

function unwrap<T>(res: PgResponse<T>): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

// ── Leituras (RLS por tenant via JWT) — colunas espelham os pages/ops-*.json ──

const AGENT_STATUS_COLS =
  'tenant_id, agent_key, enabled, last_run_id, last_run_started_at, last_run_finished_at, last_run_status, next_run_at, total_runs, succeeded_runs, failed_runs, pending_findings, has_pending_badge, identified_delta'

export async function getAgentStatus(): Promise<AgentStatus[]> {
  const res = (await supabase
    .from('ops_agent_status_view')
    .select(AGENT_STATUS_COLS)
    .order('pending_findings', { ascending: false })
    .order('agent_key', { ascending: true })) as PgResponse<AgentStatus[]>
  return unwrap(res) ?? []
}

const FINDING_KPI_COLS =
  'tenant_id, pending_count, recoverable_delta, approved_this_cycle, findings_last_24h'

export async function getFindingKpis(): Promise<FindingKpis | null> {
  // 1 linha por tenant; usamos limit(1)+[0] (igual ao dia, que NÃO usa .single()).
  const res = (await supabase
    .from('ops_finding_kpis')
    .select(FINDING_KPI_COLS)
    .order('pending_count', { ascending: false })
    .limit(1)) as PgResponse<FindingKpis[]>
  return (unwrap(res) ?? [])[0] ?? null
}

const FINDING_LIST_COLS =
  'id, agent_key, finding_type, severity, status, contract_label, line_item_label, customer_name, delta, confidence, created_at'

export interface FindingsFilter {
  severity?: string
  status?: string
  agentKey?: string
  contract?: string
  customer?: string
  /** Teto de linhas. Há ~505 pendentes no seed — não puxar tudo de uma vez na demo. */
  limit?: number
}

const FINDINGS_DEFAULT_LIMIT = 100

export async function getFindings(f: FindingsFilter = {}): Promise<FindingRow[]> {
  let q = supabase.from('ops_findings_view').select(FINDING_LIST_COLS)
  if (f.agentKey) q = q.eq('agent_key', f.agentKey)
  if (f.severity) q = q.ilike('severity', f.severity)
  if (f.status) q = q.ilike('status', f.status)
  if (f.contract) q = q.ilike('contract_label', `%${f.contract}%`)
  if (f.customer) q = q.ilike('customer_name', `%${f.customer}%`)
  const res = (await q
    .order('delta', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(f.limit ?? FINDINGS_DEFAULT_LIMIT)) as PgResponse<FindingRow[]>
  return unwrap(res) ?? []
}

const FINDING_DETAIL_COLS =
  'id, agent_key, run_id, workflow_id, contract_id, contract_label, line_item_id, line_item_label, customer_name, finding_type, severity, status, expected, expected_amount, billed, billed_amount, delta, evidence, proposed_action, confidence, rationale, created_at'

export async function getFinding(id: string): Promise<FindingDetail> {
  const res = (await supabase
    .from('ops_findings_view')
    .select(FINDING_DETAIL_COLS)
    .eq('id', id)
    .single()) as PgResponse<FindingDetail>
  return unwrap(res)
}

const AUDIT_COLS =
  'row_id, entity_id, entity_type, entity_name, fact_key, fact_label, observed_at, data_payload, metadata, source_id, point_order'

// Atenção: a coluna de filtro é entity_id (NÃO row_id) — ver ops-audit-trail.json.
export async function getAuditTrail(entityId: string): Promise<AuditEvent[]> {
  const res = (await supabase
    .from('ops_audit_trail_view')
    .select(AUDIT_COLS)
    .eq('entity_id', entityId)
    .order('observed_at', { ascending: true })
    .order('point_order', { ascending: true })) as PgResponse<AuditEvent[]>
  return unwrap(res) ?? []
}

const HOME_KPI_COLS =
  'as_of, assets_on_rent, fleet_utilization_pct, overdue_returns_count, open_maintenance_count, period_revenue, prior_period_revenue, available_assets, unavailable_assets, total_assets'

export async function getHomeKpis(): Promise<HomeKpis> {
  const res = (await supabase
    .from('v_home_dashboard_kpis')
    .select(HOME_KPI_COLS)
    .single()) as PgResponse<HomeKpis>
  return unwrap(res)
}

// Opcional (não usado pelas 5 telas-âncora; existe no schema).
export async function getAgentConfig(agentKey: string): Promise<Record<string, unknown>[]> {
  const res = (await supabase
    .from('ops_agent_config_current')
    .select('*')
    .eq('agent_key', agentKey)) as PgResponse<Record<string, unknown>[]>
  return unwrap(res) ?? []
}

// ── Decisão (escrita) via ops-api — POST /api/ops/findings/decision (ver PRD §6.4) ──
const OPS_API_URL = ENV.VITE_OPS_API_URL || '/api/ops'

export interface DecideInput {
  findingId: string
  decision: 'approve' | 'reject'
  note?: string
  reason?: string
  workflowId?: string | null
  runId?: string | null
  approverId?: string | null
}

export interface DecideResult {
  status: string
  idempotent: boolean
}

export async function decideFinding(input: DecideInput): Promise<DecideResult> {
  if (input.decision === 'reject' && !input.reason?.trim()) {
    throw new Error('Motivo é obrigatório para rejeitar.')
  }
  const token = await getAccessToken()
  if (!token) throw new Error('Sem sessão — faça login antes de decidir.')

  const body: Record<string, unknown> = {
    finding_id: input.findingId,
    decision: input.decision,
  }
  if (input.workflowId) body.workflow_id = input.workflowId
  if (input.runId) body.run_id = input.runId
  if (input.approverId) body.approver_id = input.approverId
  if (input.decision === 'approve' && input.note) body.note = input.note
  if (input.decision === 'reject') body.reason = input.reason

  const res = await fetch(`${OPS_API_URL}/findings/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Decisão falhou (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  return (await res.json()) as DecideResult
}

// ── Adapter p/ a DataTable corporativa (modo client: omite `total`) ──
export const findingsListApi = {
  async list(q?: FindingsFilter): Promise<{ data: FindingRow[] }> {
    return { data: await getFindings(q ?? {}) }
  },
}
