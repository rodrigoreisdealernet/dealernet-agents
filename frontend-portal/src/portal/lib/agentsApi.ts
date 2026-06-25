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

// ── Veículos (DIA dealership domain, issue #4) ──────────────────────────────
// Leitura direta da view v_dia_vehicle_current (security_invoker → RLS authenticated).
// Escrita SEMPRE via RPCs endurecidas (create/update/delete_vehicle): o cliente NÃO
// faz INSERT/UPDATE direto. Mantém o charter "writes go through a guarded path".

export interface VehicleRow {
  entity_id: string
  source_record_id: string | null
  name: string | null
  condition: 'novo' | 'usado' | string
  brand: string | null
  model: string | null
  model_year: number | null
  cost: number | null
  sale_price: number | null
  purchase_date: string | null
  status: 'em_estoque' | 'vendido' | string
  store: string | null
  days_in_stock: number | null
  floor_plan_cost: number | null
}

/** Campos editáveis do veículo (payload das RPCs create/update_vehicle). */
export interface VehicleInput {
  condition: 'novo' | 'usado'
  brand: string
  model: string
  model_year?: number | null
  cost?: number | null
  sale_price?: number | null
  purchase_date?: string | null
  status?: 'em_estoque' | 'vendido'
  store?: string | null
}

const VEHICLE_COLS =
  'entity_id, source_record_id, name, condition, brand, model, model_year, cost, sale_price, purchase_date, status, store, days_in_stock, floor_plan_cost'

export async function getVehicles(): Promise<VehicleRow[]> {
  const res = (await supabase
    .from('v_dia_vehicle_current')
    .select(VEHICLE_COLS)
    .order('days_in_stock', { ascending: false })) as PgResponse<VehicleRow[]>
  return unwrap(res) ?? []
}

// Remove chaves undefined/null vazias para não sobrescrever no merge do update.
function vehiclePayload(input: VehicleInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    condition: input.condition,
    brand: input.brand,
    model: input.model,
  }
  if (input.model_year != null) p.model_year = input.model_year
  if (input.cost != null) p.cost = input.cost
  if (input.sale_price != null) p.sale_price = input.sale_price
  if (input.purchase_date) p.purchase_date = input.purchase_date
  if (input.status) p.status = input.status
  if (input.store) p.store = input.store
  return p
}

export async function createVehicle(input: VehicleInput): Promise<void> {
  const res = (await supabase.rpc('create_vehicle', {
    p_data: vehiclePayload(input),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function updateVehicle(entityId: string, input: Partial<VehicleInput>): Promise<void> {
  const res = (await supabase.rpc('update_vehicle', {
    p_entity_id: entityId,
    p_data: vehiclePayload(input as VehicleInput),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function deleteVehicle(entityId: string): Promise<void> {
  const res = (await supabase.rpc('delete_vehicle', {
    p_entity_id: entityId,
  })) as PgResponse<unknown>
  unwrap(res)
}

// ── Empresas e Marcas (DIA dealership domain, issue #5) ─────────────────────
// Leitura direta das views v_dia_company_current / v_dia_brand_current
// (security_invoker → RLS authenticated). Escrita SEMPRE via RPCs endurecidas
// (create/update/delete_company|brand): o cliente NÃO faz INSERT/UPDATE direto.

export interface CompanyRow {
  entity_id: string
  source_record_id: string | null
  name: string | null
  legal_name: string | null
  trade_name: string | null
  cnpj: string | null
  city: string | null
  state: string | null
  status: 'ativo' | 'inativo' | string
  /** FK opcional → entity_id da marca associada. */
  brand_id: string | null
  /** Nome da marca resolvido (left join à versão corrente da marca). */
  brand_name: string | null
}

/** Campos editáveis da empresa (payload das RPCs create/update_company). */
export interface CompanyInput {
  legal_name: string
  trade_name?: string | null
  cnpj: string
  city?: string | null
  state?: string | null
  status?: 'ativo' | 'inativo'
  /** FK opcional → entity_id da marca; '' ou null desassocia. */
  brand_id?: string | null
}

const COMPANY_COLS =
  'entity_id, source_record_id, name, legal_name, trade_name, cnpj, city, state, status, brand_id, brand_name'

export async function getCompanies(): Promise<CompanyRow[]> {
  const res = (await supabase
    .from('v_dia_company_current')
    .select(COMPANY_COLS)
    .order('name', { ascending: true })) as PgResponse<CompanyRow[]>
  return unwrap(res) ?? []
}

function companyPayload(input: CompanyInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    legal_name: input.legal_name,
    cnpj: input.cnpj,
  }
  if (input.trade_name) p.trade_name = input.trade_name
  if (input.city) p.city = input.city
  if (input.state) p.state = input.state
  if (input.status) p.status = input.status
  // brand_id: enviar explicitamente quando definido (inclui '' para desassociar).
  if (input.brand_id !== undefined) p.brand_id = input.brand_id || null
  return p
}

export async function createCompany(input: CompanyInput): Promise<void> {
  const res = (await supabase.rpc('create_company', {
    p_data: companyPayload(input),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function updateCompany(entityId: string, input: Partial<CompanyInput>): Promise<void> {
  const res = (await supabase.rpc('update_company', {
    p_entity_id: entityId,
    p_data: companyPayload(input as CompanyInput),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function deleteCompany(entityId: string): Promise<void> {
  const res = (await supabase.rpc('delete_company', {
    p_entity_id: entityId,
  })) as PgResponse<unknown>
  unwrap(res)
}

export interface BrandRow {
  entity_id: string
  source_record_id: string | null
  name: string | null
  segment: 'automoveis' | 'caminhoes' | 'motos' | string
  status: 'ativo' | 'inativo' | string
}

/** Campos editáveis da marca (payload das RPCs create/update_brand). */
export interface BrandInput {
  name: string
  segment: 'automoveis' | 'caminhoes' | 'motos'
  status?: 'ativo' | 'inativo'
}

const BRAND_COLS = 'entity_id, source_record_id, name, segment, status'

export async function getBrands(): Promise<BrandRow[]> {
  const res = (await supabase
    .from('v_dia_brand_current')
    .select(BRAND_COLS)
    .order('name', { ascending: true })) as PgResponse<BrandRow[]>
  return unwrap(res) ?? []
}

function brandPayload(input: BrandInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: input.name,
    segment: input.segment,
  }
  if (input.status) p.status = input.status
  return p
}

export async function createBrand(input: BrandInput): Promise<void> {
  const res = (await supabase.rpc('create_brand', {
    p_data: brandPayload(input),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function updateBrand(entityId: string, input: Partial<BrandInput>): Promise<void> {
  const res = (await supabase.rpc('update_brand', {
    p_entity_id: entityId,
    p_data: brandPayload(input as BrandInput),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function deleteBrand(entityId: string): Promise<void> {
  const res = (await supabase.rpc('delete_brand', {
    p_entity_id: entityId,
  })) as PgResponse<unknown>
  unwrap(res)
}

// ── Usuários / Perfis (gestão admin, issue #6) ──────────────────────────────
// Leitura direta de profiles (RLS: admin vê todos; demais veem só o próprio).
// Criação via Edge Function admin-create-user (service_role server-side);
// edição/inativação via RPC endurecida admin_update_profile (somente admin).

export type AppRole = 'admin' | 'branch_manager' | 'field_operator' | 'read_only'

export interface ProfileRow {
  id: string
  display_name: string | null
  role: AppRole | string
  tenant: string
  is_active: boolean
}

/** Campos do formulário de criação (Edge Function admin-create-user). */
export interface CreateUserInput {
  email: string
  password: string
  display_name: string
  role: AppRole
  tenant?: string
}

/** Campos editáveis de um perfil existente (RPC admin_update_profile). */
export interface ProfileUpdateInput {
  display_name: string | null
  role: AppRole | string
  is_active: boolean
}

const PROFILE_COLS = 'id, display_name, role, tenant, is_active'

export async function getProfiles(): Promise<ProfileRow[]> {
  const res = (await supabase
    .from('profiles')
    .select(PROFILE_COLS)
    .order('display_name', { ascending: true })) as PgResponse<ProfileRow[]>
  return unwrap(res) ?? []
}

/** Role do usuário corrente (via JWT) — usado para gating da UI. */
export async function getMyRole(): Promise<string> {
  const res = (await supabase.rpc('get_my_role')) as PgResponse<string>
  return unwrap(res) ?? 'read_only'
}

export async function createUser(input: CreateUserInput): Promise<{ user_id: string }> {
  const { data, error } = await supabase.functions.invoke('admin-create-user', {
    body: {
      email: input.email,
      password: input.password,
      display_name: input.display_name,
      role: input.role,
      tenant: input.tenant,
    },
  })
  if (error) throw new Error(error.message)
  const payload = data as { user_id?: string; error?: string }
  if (payload?.error) throw new Error(payload.error)
  return { user_id: payload?.user_id ?? '' }
}

export async function updateProfile(userId: string, input: ProfileUpdateInput): Promise<void> {
  const res = (await supabase.rpc('admin_update_profile', {
    p_user_id: userId,
    p_display_name: input.display_name,
    p_role: input.role,
    p_is_active: input.is_active,
  })) as PgResponse<unknown>
  unwrap(res)
}

// ── Ordens de Serviço / Oficina (DIA dealership domain, issue #7) ────────────
// Leitura direta da view v_dia_service_order_current (security_invoker → RLS
// authenticated). Escrita SEMPRE via RPCs endurecidas (create/update/delete_
// service_order): o cliente NÃO faz INSERT/UPDATE direto.

export type ServiceOrderStatus = 'aberta' | 'em_andamento' | 'concluida' | 'cancelada'

export interface ServiceOrderRow {
  entity_id: string
  source_record_id: string | null
  name: string | null
  order_number: string | null
  customer: string | null
  vehicle: string | null
  description: string | null
  status: ServiceOrderStatus | string
  opened_at: string | null
  closed_at: string | null
  revenue: number | null
  technician: string | null
  turnaround_hours: number | null
}

/** Campos editáveis da OS (payload das RPCs create/update_service_order). */
export interface ServiceOrderInput {
  order_number?: string | null
  customer: string
  vehicle?: string | null
  description: string
  status?: ServiceOrderStatus
  opened_at?: string | null
  closed_at?: string | null
  revenue?: number | null
  technician?: string | null
}

const SERVICE_ORDER_COLS =
  'entity_id, source_record_id, name, order_number, customer, vehicle, description, status, opened_at, closed_at, revenue, technician, turnaround_hours'

export async function getServiceOrders(): Promise<ServiceOrderRow[]> {
  const res = (await supabase
    .from('v_dia_service_order_current')
    .select(SERVICE_ORDER_COLS)
    .order('opened_at', { ascending: false })) as PgResponse<ServiceOrderRow[]>
  return unwrap(res) ?? []
}

// ── Peças (DIA dealership domain, issue #8) ─────────────────────────────────
// Leitura direta da view v_dia_part_current (security_invoker → RLS authenticated).
// Escrita SEMPRE via RPCs endurecidas (create/update/delete_part): o cliente NÃO
// faz INSERT/UPDATE direto. Mantém o charter "writes go through a guarded path".

export type PartStockStatus = 'zerado' | 'critico' | 'baixo' | 'ok' | string

export interface PartRow {
  entity_id: string
  source_record_id: string | null
  name: string | null
  part_number: string | null
  description: string | null
  manufacturer: string | null
  unit_cost: number | null
  unit_price: number | null
  quantity_in_stock: number | null
  min_stock: number | null
  reorder_point: number | null
  location: string | null
  status: 'ativo' | 'inativo' | string
  stock_value: number | null
  stock_status: PartStockStatus
}

/** Campos editáveis da peça (payload das RPCs create/update_part). */
export interface PartInput {
  part_number: string
  description: string
  manufacturer?: string | null
  unit_cost?: number | null
  unit_price?: number | null
  quantity_in_stock?: number | null
  min_stock?: number | null
  reorder_point?: number | null
  location?: string | null
  status?: 'ativo' | 'inativo'
}

const PART_COLS =
  'entity_id, source_record_id, name, part_number, description, manufacturer, unit_cost, unit_price, quantity_in_stock, min_stock, reorder_point, location, status, stock_value, stock_status'

export async function getParts(): Promise<PartRow[]> {
  const res = (await supabase
    .from('v_dia_part_current')
    .select(PART_COLS)
    .order('part_number', { ascending: true })) as PgResponse<PartRow[]>
  return unwrap(res) ?? []
}

/** Peças que precisam de reposição (baixo/critico/zerado), por criticidade. */
export async function getCriticalParts(): Promise<PartRow[]> {
  const res = (await supabase
    .from('v_dia_parts_critical')
    .select(PART_COLS)) as PgResponse<PartRow[]>
  return unwrap(res) ?? []
}

// ── Fast BI de Peças (issue #18) ────────────────────────────────────────────
// Leitura direta das views agregadas para o dashboard read-only de peças.
// v_dia_parts_summary é um UNION ALL: linhas de inventário (stock_status +
// inventory_value, com period_month/units_sold/revenue nulos) e linhas de venda
// (period_month + units_sold + revenue, com stock_status/inventory_value nulos).

export interface PartsSummaryRow {
  stock_status: string | null
  inventory_value: number | null
  period_month: string | null
  units_sold: number | null
  revenue: number | null
}

const PARTS_SUMMARY_COLS = 'stock_status, inventory_value, period_month, units_sold, revenue'

export async function getPartsSummary(): Promise<PartsSummaryRow[]> {
  const res = (await supabase
    .from('v_dia_parts_summary')
    .select(PARTS_SUMMARY_COLS)) as PgResponse<PartsSummaryRow[]>
  return unwrap(res) ?? []
}

// KPIs do dono (v_dia_owner_kpis) — linha única. Selecionamos só o que o Fast BI
// de peças usa; usamos limit(1)+[0] (igual getFindingKpis) p/ tolerar 0 linhas.
export interface DiaOwnerKpis {
  as_of: string | null
  parts_inventory_value: number | null
  parts_critical_count: number | null
}

const DIA_OWNER_KPI_COLS = 'as_of, parts_inventory_value, parts_critical_count'

export async function getDiaOwnerKpis(): Promise<DiaOwnerKpis | null> {
  const res = (await supabase
    .from('v_dia_owner_kpis')
    .select(DIA_OWNER_KPI_COLS)
    .limit(1)) as PgResponse<DiaOwnerKpis[]>
  return (unwrap(res) ?? [])[0] ?? null
}

// Remove chaves undefined/null vazias para não sobrescrever no merge do update.
function serviceOrderPayload(input: ServiceOrderInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    customer: input.customer,
    description: input.description,
  }
  if (input.order_number) p.order_number = input.order_number
  if (input.vehicle) p.vehicle = input.vehicle
  if (input.status) p.status = input.status
  if (input.opened_at) p.opened_at = input.opened_at
  if (input.closed_at) p.closed_at = input.closed_at
  if (input.revenue != null) p.revenue = input.revenue
  if (input.technician) p.technician = input.technician
  return p
}

export async function createServiceOrder(input: ServiceOrderInput): Promise<void> {
  const res = (await supabase.rpc('create_service_order', {
    p_data: serviceOrderPayload(input),
  })) as PgResponse<unknown>
  unwrap(res)
}

function partPayload(input: PartInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    part_number: input.part_number,
    description: input.description,
  }
  if (input.manufacturer) p.manufacturer = input.manufacturer
  if (input.unit_cost != null) p.unit_cost = input.unit_cost
  if (input.unit_price != null) p.unit_price = input.unit_price
  if (input.quantity_in_stock != null) p.quantity_in_stock = input.quantity_in_stock
  if (input.min_stock != null) p.min_stock = input.min_stock
  if (input.reorder_point != null) p.reorder_point = input.reorder_point
  if (input.location) p.location = input.location
  if (input.status) p.status = input.status
  return p
}

export async function createPart(input: PartInput): Promise<void> {
  const res = (await supabase.rpc('create_part', {
    p_data: partPayload(input),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function updateServiceOrder(entityId: string, input: Partial<ServiceOrderInput>): Promise<void> {
  const res = (await supabase.rpc('update_service_order', {
    p_entity_id: entityId,
    p_data: serviceOrderPayload(input as ServiceOrderInput),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function updatePart(entityId: string, input: Partial<PartInput>): Promise<void> {
  const res = (await supabase.rpc('update_part', {
    p_entity_id: entityId,
    p_data: partPayload(input as PartInput),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function deleteServiceOrder(entityId: string): Promise<void> {
  const res = (await supabase.rpc('delete_service_order', {
    p_entity_id: entityId,
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function deletePart(entityId: string): Promise<void> {
  const res = (await supabase.rpc('delete_part', {
    p_entity_id: entityId,
  })) as PgResponse<unknown>
  unwrap(res)
}

// ── Vendas de peças (DIA dealership domain, issue #10) ───────────────────────
// Leitura direta da view v_dia_part_sale_current (security_invoker → RLS
// authenticated). Escrita SEMPRE via RPCs endurecidas (create/cancel_part_sale):
// a venda é atômica e baixa o estoque da peça; o cancelamento estorna.

export interface PartSaleRow {
  entity_id: string
  source_record_id: string | null
  part_id: string | null
  part_number: string | null
  description: string | null
  quantity: number | null
  unit_price: number | null
  discount: number | null
  total: number | null
  sale_date: string | null
  customer: string | null
  salesperson: string | null
  channel: string | null
  status: string
}

/** Campos do payload da RPC create_part_sale. */
export interface PartSaleInput {
  part_id: string
  quantity: number
  unit_price: number
  discount?: number | null
  sale_date?: string | null
  customer?: string | null
  salesperson?: string | null
  channel?: string | null
}

const PART_SALE_COLS =
  'entity_id, source_record_id, part_id, part_number, description, quantity, unit_price, discount, total, sale_date, customer, salesperson, channel, status'

export async function getPartSales(): Promise<PartSaleRow[]> {
  const res = (await supabase
    .from('v_dia_part_sale_current')
    .select(PART_SALE_COLS)
    .order('sale_date', { ascending: false })) as PgResponse<PartSaleRow[]>
  return unwrap(res) ?? []
}

function partSalePayload(input: PartSaleInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    part_id: input.part_id,
    quantity: input.quantity,
    unit_price: input.unit_price,
  }
  if (input.discount != null) p.discount = input.discount
  if (input.sale_date) p.sale_date = input.sale_date
  if (input.customer) p.customer = input.customer
  if (input.salesperson) p.salesperson = input.salesperson
  if (input.channel) p.channel = input.channel
  return p
}

export async function createPartSale(input: PartSaleInput): Promise<void> {
  const res = (await supabase.rpc('create_part_sale', {
    p_data: partSalePayload(input),
  })) as PgResponse<unknown>
  unwrap(res)
}

export async function cancelPartSale(entityId: string): Promise<void> {
  const res = (await supabase.rpc('cancel_part_sale', {
    p_entity_id: entityId,
  })) as PgResponse<unknown>
  unwrap(res)
}

// ── Fast BI — Visão do Dono (issue #15) ─────────────────────────────────────
// Leitura direta das views analíticas (issue #14): v_dia_owner_kpis (linha única),
// v_dia_sales_trend (90 dias diário) e v_dia_inventory_summary (por faixa de idade).
// Somente leitura — alimenta a tela DiaOverview (KpiCards + ChartCards).

export interface OwnerKpis {
  as_of: string | null
  sales_units_month: number
  sales_revenue_month: number
  margin_month: number
  service_orders_open: number
  service_revenue_month: number
  service_avg_turnaround: number
  inventory_vehicle_value: number
  floor_plan_total: number
  avg_days_in_stock: number
  parts_inventory_value: number
  parts_critical_count: number
}

const OWNER_KPI_COLS =
  'as_of, sales_units_month, sales_revenue_month, margin_month, service_orders_open, service_revenue_month, service_avg_turnaround, inventory_vehicle_value, floor_plan_total, avg_days_in_stock, parts_inventory_value, parts_critical_count'

export async function getOwnerKpis(): Promise<OwnerKpis | null> {
  const res = (await supabase
    .from('v_dia_owner_kpis')
    .select(OWNER_KPI_COLS)
    .single()) as PgResponse<OwnerKpis>
  return unwrap(res)
}

// ── Vendas / Fast BI (issue #16) ────────────────────────────────────────────
// Leitura direta das views agregadas v_dia_sales_summary / v_dia_sales_trend
// (security_invoker → RLS authenticated). SOMENTE leitura — o dashboard de
// vendas não faz insert/update/delete/rpc.

export interface SalesSummaryRow {
  period_month: string
  condition: 'novo' | 'usado' | string
  brand: string | null
  store: string | null
  units_sold: number
  revenue: number
  margin: number
  avg_days_to_sell: number
}

export interface SalesTrendRow {
  sale_date: string
  units_sold: number
  revenue: number
}

const SALES_SUMMARY_COLS =
  'period_month, condition, brand, store, units_sold, revenue, margin, avg_days_to_sell'

export async function getSalesSummary(): Promise<SalesSummaryRow[]> {
  const res = (await supabase
    .from('v_dia_sales_summary')
    .select(SALES_SUMMARY_COLS)
    .order('period_month', { ascending: true })) as PgResponse<SalesSummaryRow[]>
  return unwrap(res) ?? []
}

const SALES_TREND_COLS = 'sale_date, units_sold, revenue'

export async function getSalesTrend(): Promise<SalesTrendRow[]> {
  const res = (await supabase
    .from('v_dia_sales_trend')
    .select(SALES_TREND_COLS)
    .order('sale_date', { ascending: true })) as PgResponse<SalesTrendRow[]>
  return unwrap(res) ?? []
}

export interface InventorySummaryRow {
  age_band: string
  brand: string
  store: string
  vehicles_count: number
  inventory_value: number
  floor_plan_cost: number
}

const INVENTORY_SUMMARY_COLS =
  'age_band, brand, store, vehicles_count, inventory_value, floor_plan_cost'

export async function getInventorySummary(): Promise<InventorySummaryRow[]> {
  const res = (await supabase
    .from('v_dia_inventory_summary')
    .select(INVENTORY_SUMMARY_COLS)) as PgResponse<InventorySummaryRow[]>
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
