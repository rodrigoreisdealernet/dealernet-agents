// Comunicação com o backend do portal (GeneXus /api/v1).
// Mesmo padrão do DealernetFrontEnd: fetch com credentials:'include' via proxy /rest.
//
// POC: os endpoints /api/v1/portal/* ainda não existem (ver doc §11), então
// config/menu/workspaces vêm de MOCKS locais. Quando o backend existir, basta
// trocar o corpo de cada função por um request() real — a assinatura não muda.

import type {
  Cargo,
  Departamento,
  Empresa,
  EmpresaCadastro,
  Equipe,
  GrupoAcesso,
  GrupoEmpresa,
  LoginRequest,
  LoginResponse,
  MenuItem,
  PerfilAcesso,
  PortalConfig,
  SetorServico,
  SolucaoDMS,
  Usuario,
  UsuarioEmpresa,
  UsuarioGrupoAcesso,
  UsuarioPerfilAcesso,
  TemaPortal,
  Workspace,
  WorkspaceData,
  WorkspaceMeta,
} from '@/portal/types'
import type { ListQuery, ListResult } from '@/portal/components/datatable/types'
import { portalApiReal } from '@/portal/lib/portalApiReal'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/rest/api/v1'

// Mantido para quando os endpoints existirem (mesma forma do lib/api.ts do DFE).
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) throw new Error(`Erro ${res.status} em ${path}`)
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// MOCKS (POC). Trocar por request('/portal/...') quando o backend existir.
// ---------------------------------------------------------------------------

const MOCK_CONFIG: PortalConfig = {
  portalName: 'DIA — Dealernet Intelligence Agents',
  userName: 'Usuário Demo',
  // Em produção virá do backend; na POC só a própria origem + um exemplo externo.
  // localhost:8083 = DealernetProduto (telas React de IA: Compras/Requisições/Pedidos) em dev.
  allowedOrigins: ['https://www.example.com', 'http://localhost:8083'],
  // Curto na POC para dá pra ver o timer agir; o real vem do SDT (minutos).
  tempoSessao: 10,
  endpoints: {
    logout: '/logout',
    changeCompany: '/api/v1/portal/empresa/atual',
    alteraSenha: 'mock/aspx-lead.html',
  },
}

const MOCK_EMPRESAS: Empresa[] = [
  { id: 'gm-1', nome: 'GM Filial 1', grupo: 'GM' },
  { id: 'gm-2', nome: 'GM Filial 2', grupo: 'GM' },
  { id: 'dn-1', nome: 'DEALERNET Empresa 1', grupo: 'DEALERNET', ativa: true },
  { id: 'dn-2', nome: 'DEALERNET Empresa 2', grupo: 'DEALERNET' },
]

// POC — IA proativa (Operations Factory) como cidadã de primeira classe no topo.
// Ver docs/PRD-portal-dms-frontend-acoplamento.md §8. Ícones limitados ao que o
// resolvedor (menuIcon.tsx) reconhece: 6 nomes lucide diretos + tokens fa-*.
const MOCK_MENU: MenuItem[] = [
  {
    id: 'ai-ops',
    text: 'AI Operations',
    icon: 'fa-bolt',
    children: [
      {
        id: 'ai-agents-dashboard',
        text: 'Agent Dashboard',
        icon: 'fa-gauge',
        spec: { title: 'Agent Dashboard', kind: 'component', componentKey: 'agents-dashboard' },
      },
      {
        id: 'ai-morning-queue',
        text: 'Morning Queue',
        icon: 'fa-tasks',
        spec: { title: 'Fila de Findings', kind: 'component', componentKey: 'findings-queue' },
      },
      {
        id: 'ai-audit-trail',
        text: 'Audit Trail',
        icon: 'fa-clipboard-check',
        spec: { title: 'Auditoria', kind: 'component', componentKey: 'audit-trail' },
      },
    ],
  },
  {
    id: 'insights',
    text: 'Insights',
    icon: 'BarChart3',
    children: [
      {
        id: 'insights-executive-pack',
        text: 'Executive Pack',
        icon: 'Building2',
        spec: { title: 'Painel do Dono', kind: 'component', componentKey: 'executive-pack' },
      },
    ],
  },
  // DIA dealership domain (issue #4) — cadastro de estoque de veículos.
  {
    id: 'dealership',
    text: 'Concessionária',
    icon: 'fa-car',
    children: [
      {
        id: 'dealership-vehicles',
        text: 'Estoque de Veículos',
        icon: 'fa-car',
        spec: { title: 'Estoque de Veículos', kind: 'component', componentKey: 'dia-vehicles' },
      },
      {
        id: 'dealership-companies',
        text: 'Empresas',
        icon: 'fa-building',
        spec: { title: 'Empresas', kind: 'component', componentKey: 'dia-companies' },
      },
      {
        id: 'dealership-brands',
        text: 'Marcas',
        icon: 'fa-tag',
        spec: { title: 'Marcas', kind: 'component', componentKey: 'dia-brands' },
      },
      // DIA dealership domain (issue #7) — Oficina / ordens de serviço (/dia/service-orders).
      {
        id: 'dealership-service-orders',
        text: 'Ordens de Serviço',
        icon: 'fa-wrench',
        spec: { title: 'Ordens de Serviço', kind: 'component', componentKey: 'dia-service-orders' },
      },
      // DIA dealership domain (issue #8) — Estoque de peças (/dia/parts).
      {
        id: 'dealership-parts',
        text: 'Estoque de Peças',
        icon: 'fa-cog',
        spec: { title: 'Estoque de Peças', kind: 'component', componentKey: 'dia-parts' },
      },
    ],
  },
  // Administração (issue #6) — gestão de usuários/perfis; visível só para admin.
  {
    id: 'admin',
    text: 'Administração',
    icon: 'Users',
    requiredRole: 'admin',
    children: [
      {
        id: 'admin-users',
        text: 'Usuários',
        icon: 'UserPlus',
        requiredRole: 'admin',
        spec: { title: 'Usuários', kind: 'component', componentKey: 'admin-users' },
      },
    ],
  },
]

const delay = <T>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 120))

// ---------------------------------------------------------------------------
// Workspaces — CRUD com FALLBACK localStorage (a DHI ainda não expõe as APIs).
// Quando o backend existir, trocar cada função pelo request() comentado ao lado.
// O contrato (assinatura) NÃO muda — só o corpo.
// ---------------------------------------------------------------------------

const WS_STORE_KEY = 'dealernet-portal-workspaces'

interface WsRepo {
  list: WorkspaceMeta[]
  data: Record<string, WorkspaceData>
}

function loadRepo(): WsRepo {
  try {
    const raw = localStorage.getItem(WS_STORE_KEY)
    if (raw) return JSON.parse(raw) as WsRepo
  } catch {
    // ignora corrupção; recria
  }
  // Semente: um workspace padrão vazio na primeira execução.
  const seed: WsRepo = {
    list: [{ id: 'ws-default', name: 'Área de Trabalho' }],
    data: { 'ws-default': { windows: [], bookmarks: [] } },
  }
  saveRepo(seed)
  return seed
}

function saveRepo(repo: WsRepo) {
  try {
    localStorage.setItem(WS_STORE_KEY, JSON.stringify(repo))
  } catch {
    // ignora cota cheia
  }
}

// IDs determinísticos (Date.now/Math.random não disponíveis no ambiente de skill);
// usa um contador derivado do maior id existente.
function nextWsId(repo: WsRepo): string {
  let max = 0
  for (const w of repo.list) {
    const n = Number(w.id.replace(/\D/g, ''))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `ws-${max + 1}`
}

// Fábrica de CRUD mock (localStorage) — mesma interface do crudReal (list/save/remove),
// p/ as telas de cadastro funcionarem sem backend. Soft delete = ativo:false.
function crudMock<T extends { codigo: number; ativo: boolean }>(storeKey: string, seed: T[]) {
  const persist = (list: T[]) => {
    try {
      localStorage.setItem(storeKey, JSON.stringify(list))
    } catch {
      // ignora cota
    }
  }
  const load = (): T[] => {
    try {
      const raw = localStorage.getItem(storeKey)
      if (raw) return JSON.parse(raw) as T[]
    } catch {
      // recria
    }
    persist(seed)
    return [...seed]
  }
  return {
    // Simula o BFF v2 (paginado): aplica busca/filtros/sort e devolve `total` —
    // o DataTable detecta e opera em modo server, igual ao backend real.
    list: (q?: ListQuery): Promise<ListResult<T>> => {
      let rows = load().slice().sort((a, b) => a.codigo - b.codigo)
      if (q?.busca?.trim()) {
        const termo = q.busca.trim().toLowerCase()
        rows = rows.filter((r) =>
          Object.values(r as Record<string, unknown>).some(
            (v) => typeof v === 'string' && v.toLowerCase().includes(termo),
          ),
        )
      }
      for (const [col, raw] of Object.entries(q?.filters ?? {})) {
        const valor = raw.slice(raw.indexOf(':') + 1)
        if (valor.includes(',')) continue // multi-select com todos = sem filtro
        rows = rows.filter((r) => String((r as Record<string, unknown>)[col]) === valor)
      }
      if (q?.sort) {
        const [colKey, dir] = q.sort.split(':')
        const mult = dir === 'desc' ? -1 : 1
        rows = rows.slice().sort((a, b) => {
          const va = (a as Record<string, unknown>)[colKey]
          const vb = (b as Record<string, unknown>)[colKey]
          if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult
          return String(va ?? '').localeCompare(String(vb ?? ''), 'pt-BR') * mult
        })
      }
      const total = rows.length
      const page = q?.page ?? 1
      const size = q?.size ?? 50
      return delay({ data: rows.slice((page - 1) * size, page * size), total })
    },
    save: (item: T): Promise<{ ok: boolean; mensagem?: string }> => {
      const list = load()
      if (item.codigo === 0) {
        const codigo = list.reduce((m, x) => Math.max(m, x.codigo), 0) + 1
        list.push({ ...item, codigo })
      } else {
        const found = list.find((x) => x.codigo === item.codigo)
        if (!found) return delay({ ok: false, mensagem: 'Registro não encontrado.' })
        Object.assign(found, item)
      }
      persist(list)
      return delay({ ok: true })
    },
    // Lean: remove recebe o registro inteiro (soft delete = ativo:false).
    remove: (item: T): Promise<{ ok: boolean; mensagem?: string }> => {
      const list = load()
      const found = list.find((x) => x.codigo === item.codigo)
      if (!found) return delay({ ok: false, mensagem: 'Registro não encontrado.' })
      found.ativo = false
      persist(list)
      return delay({ ok: true })
    },
  }
}

const cadastrosMock = {
  cargo: crudMock<Cargo>('dealernet-portal-cargos', [
    { codigo: 1, descricao: 'Gerente de Vendas', ativo: true },
    { codigo: 2, descricao: 'Consultor de Vendas', ativo: true },
    { codigo: 3, descricao: 'Mecânico', ativo: true },
    { codigo: 4, descricao: 'Recepcionista', ativo: false },
  ]),
  departamento: crudMock<Departamento>('dealernet-portal-departamentos', [
    { codigo: 1, descricao: 'Vendas', ativo: true },
    { codigo: 2, descricao: 'Oficina', ativo: true },
    { codigo: 3, descricao: 'Peças', ativo: true },
  ]),
  grupoAcesso: crudMock<GrupoAcesso>('dealernet-portal-gruposacesso', [
    { codigo: 1, descricao: 'Administradores', observacao: 'Acesso total ao sistema', ativo: true },
    { codigo: 2, descricao: 'Operadores', observacao: '', ativo: true },
  ]),
  grupoEmpresa: crudMock<GrupoEmpresa>('dealernet-portal-gruposempresa', [
    { codigo: 1, nome: 'Grupo Dealernet', metodoAutenticacao: '', validaGrupoFinanceiro: false, dealerNet: false, googleAnalytics: '', googleAds: '', reCaptchaSiteKey: '', reCaptchaSecretKey: '', ativo: true },
    { codigo: 2, nome: 'Grupo GM', metodoAutenticacao: '', validaGrupoFinanceiro: false, dealerNet: false, googleAnalytics: '', googleAds: '', reCaptchaSiteKey: '', reCaptchaSecretKey: '', ativo: true },
  ]),
  perfilAcesso: crudMock<PerfilAcesso>('dealernet-portal-perfisacesso', [
    { codigo: 1, descricao: 'Administrador', tipo: 'ADM', prioridade: 1, permiteSMS: '', diasPrevisaoEntrega: 0, diasLimiteCredito: 0, ativo: true },
    { codigo: 2, descricao: 'Vendedor', tipo: 'VND', prioridade: 5, permiteSMS: '', diasPrevisaoEntrega: 0, diasLimiteCredito: 0, ativo: true },
  ]),
  empresa: crudMock<EmpresaCadastro>('dealernet-portal-empresas-cad', [
    { codigo: 1, nome: 'Dealernet Matriz LTDA', nomeFantasia: 'Dealernet Matriz', docIdentificador: '00.000.000/0001-00', grupoEmpresaCod: 0, grupoEmpresaNome: '', regimeTributaria: '', segmento: '', centroDistribuicao: false, dealerNet: false, urlImagem: '', pessoaCod: 0, pessoaNom: '', ativo: true },
    { codigo: 2, nome: 'Dealernet Filial LTDA', nomeFantasia: 'Dealernet Filial', docIdentificador: '00.000.000/0002-00', grupoEmpresaCod: 0, grupoEmpresaNome: '', regimeTributaria: '', segmento: '', centroDistribuicao: false, dealerNet: false, urlImagem: '', pessoaCod: 0, pessoaNom: '', ativo: true },
  ]),
  equipe: crudMock<Equipe>('dealernet-portal-equipes', [
    { codigo: 1, descricao: 'Consultor Técnico', cor: '', ativoAgendamento: false, ativo: true },
    { codigo: 2, descricao: 'Vendas', cor: '', ativoAgendamento: false, ativo: true },
    { codigo: 9, descricao: 'Administração', cor: '', ativoAgendamento: false, ativo: true },
  ]),
  setorServico: crudMock<SetorServico>('dealernet-portal-setores', [
    { codigo: 1, descricao: 'Mecânica', tipo: '', ativo: true },
    { codigo: 2, descricao: 'Funilaria', tipo: '', ativo: true },
    { codigo: 3, descricao: 'Elétrica', tipo: '', ativo: true },
  ]),
  usuario: crudMock<Usuario>('dealernet-portal-usuarios-cad', [
    {
      codigo: 1, nome: 'Usuário Demo', identificador: 'demo', identificadorAlternativo: '',
      email: 'demo@dealernet.com.br', tipoAcesso: 'SI', empresaCodDefault: 1, equipe: 1,
      equipeDescricao: '', cargo: 1, cargoDescricao: '', setorServico: 1, setorServicoDescricao: '',
      pessoaCod: 0, pessoaNom: '', pessoaDoc: '', administrador: false, dataAdmissao: '', dataDemissao: '',
      diasExpiracaoSenha: 0, autenticaLocal: false, ativo: true,
    },
  ]),
}

const portalApiMock = {
  // --- Auth (mock; trocar por POST /api/v1/portal/identity/auth quando existir) ---
  // No real, o backend emite cookie de sessão HttpOnly; aqui só simulamos a regra.
  auth: (req: LoginRequest): Promise<LoginResponse> => {
    if (!req.usuario.trim() || !req.senha) {
      return delay({ status: 'INVALID_CREDENTIALS', mensagem: 'Usuário e senha são obrigatórios.' })
    }
    // POC: qualquer credencial não-vazia entra (senha "erro" simula falha p/ testar erro).
    if (req.senha.toLowerCase() === 'erro') {
      return delay({ status: 'INVALID_CREDENTIALS', mensagem: 'Usuário ou senha inválidos.' })
    }
    return delay({ status: 'OK', usuario: req.usuario.trim(), nome: req.usuario.trim() })
  },
  logout: (): Promise<{ ok: boolean }> => delay({ ok: true }),

  // Alterar senha (logado). Mock; trocar por POST /api/v1/portal/identity/alterar-senha.
  // No real, a DHI valida a senha atual e grava a nova em UsuarioSenha.
  alterarSenha: (atual: string, nova: string): Promise<{ ok: boolean; mensagem?: string }> => {
    if (!atual || !nova) return delay({ ok: false, mensagem: 'Preencha todos os campos.' })
    if (atual.toLowerCase() === 'erro') {
      return delay({ ok: false, mensagem: 'Senha atual incorreta.' })
    }
    return delay({ ok: true })
  },

  getConfig: (): Promise<PortalConfig> => delay(MOCK_CONFIG),
  getMenu: (): Promise<MenuItem[]> => delay(MOCK_MENU),
  // Mock: não há Bridge real — abre a própria tela (sem token de sessão).
  abrirTelaBridge: (
    tela: string,
    engine: 'EV2' | 'GX18' = 'EV2',
  ): Promise<{ ok: boolean; url?: string; token?: string; mensagem?: string }> =>
    delay({ ok: true, url: `${engine === 'GX18' ? '/DealernetWFNetCore' : '/DealerNetWF'}/${tela}`, token: 'mock-token' }),
  getEmpresas: (): Promise<Empresa[]> => delay(MOCK_EMPRESAS),
  // No real: POST /api/v1/portal/empresa/atual { id } e o backend troca a sessão.
  setEmpresa: (id: string): Promise<{ ok: boolean }> => delay({ ok: !!id }),

  // Mock de temas por marca (no real: GET /tema/list?Filtros={Marca}).
  getTemas: (_marcaCod?: number): Promise<TemaPortal[]> =>
    delay([
      { codigo: 1, descricao: 'Vermelho FIAT', corPrimaria: '#C8102E', posicao: 1 },
      { codigo: 2, descricao: 'Azul GM', corPrimaria: '#0072CE', posicao: 2 },
    ]),

  // GET /api/v1/portal/workspaces
  getWorkspaces: (): Promise<WorkspaceMeta[]> => delay(loadRepo().list),

  // GET /api/v1/portal/workspaces/{id}
  getWorkspace: (id: string): Promise<Workspace | null> => {
    const repo = loadRepo()
    const meta = repo.list.find((w) => w.id === id)
    if (!meta) return delay(null)
    return delay({ ...meta, data: repo.data[id] ?? { windows: [], bookmarks: [] } })
  },

  // POST /api/v1/portal/workspaces  → cria e devolve o meta (com id do servidor)
  createWorkspace: (name: string, data: WorkspaceData): Promise<WorkspaceMeta> => {
    const repo = loadRepo()
    const id = nextWsId(repo)
    const meta: WorkspaceMeta = { id, name }
    repo.list.push(meta)
    repo.data[id] = data
    saveRepo(repo)
    return delay(meta)
  },

  // PUT /api/v1/portal/workspaces/{id}  → salva conteúdo (e nome, se mudou)
  saveWorkspace: (id: string, name: string, data: WorkspaceData): Promise<{ ok: boolean }> => {
    const repo = loadRepo()
    const meta = repo.list.find((w) => w.id === id)
    if (meta) meta.name = name
    repo.data[id] = data
    saveRepo(repo)
    return delay({ ok: !!meta })
  },

  // DELETE /api/v1/portal/workspaces/{id}
  deleteWorkspace: (id: string): Promise<{ ok: boolean }> => {
    const repo = loadRepo()
    repo.list = repo.list.filter((w) => w.id !== id)
    delete repo.data[id]
    saveRepo(repo)
    return delay({ ok: true })
  },

  // CRUDs de cadastro (mesma interface do real).
  cadastros: cadastrosMock,

  // SolucaoDMS — mock sob medida (PK char tipoProduto), em localStorage.
  solucaoDMS: (() => {
    const KEY = 'dealernet-portal-solucoesdms'
    const seed: SolucaoDMS[] = [
      { tipoProduto: 'DWF', nome: 'Dealernet Workflow', urlBase: 'http://erp/dwf', urlBaseSpa: '', classeIcone: 'Boxes', sequencia: 1, ativo: true },
      { tipoProduto: 'DCRM', nome: 'Dealernet CRM', urlBase: 'http://erp/crm', urlBaseSpa: '', classeIcone: 'Users', sequencia: 2, ativo: true },
      { tipoProduto: 'DHI', nome: 'Hub Integration', urlBase: 'http://erp/dhi', urlBaseSpa: '', classeIcone: 'Cable', sequencia: 3, ativo: true },
    ]
    const load = (): SolucaoDMS[] => {
      try { const r = localStorage.getItem(KEY); if (r) return JSON.parse(r) as SolucaoDMS[] } catch { /* recria */ }
      localStorage.setItem(KEY, JSON.stringify(seed)); return [...seed]
    }
    const save = (l: SolucaoDMS[]) => { try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* cota */ } }
    return {
      list: (q?: ListQuery): Promise<ListResult<SolucaoDMS>> => {
        let rows = load().slice().sort((a, b) => a.sequencia - b.sequencia)
        if (q?.busca?.trim()) {
          const t = q.busca.trim().toLowerCase()
          rows = rows.filter((r) => r.nome.toLowerCase().includes(t) || r.tipoProduto.toLowerCase().includes(t))
        }
        return delay({ data: rows, total: rows.length })
      },
      // Lean: Save upsert (Insert/Update detectado pela PK).
      save: (s: SolucaoDMS): Promise<{ ok: boolean; mensagem?: string }> => {
        const l = load()
        const i = l.findIndex((x) => x.tipoProduto === s.tipoProduto)
        if (i >= 0) l[i] = s
        else l.push(s)
        save(l)
        return delay({ ok: true })
      },
      // Soft delete = save com ativo=false (sem rota Delete no lean).
      remove: (s: SolucaoDMS): Promise<{ ok: boolean; mensagem?: string }> => {
        const l = load()
        const found = l.find((x) => x.tipoProduto === s.tipoProduto)
        if (!found) return delay({ ok: false, mensagem: 'Não encontrado.' })
        found.ativo = false
        save(l)
        return delay({ ok: true })
      },
    }
  })(),

  // Vínculos Usuário×Empresa (N:N) — mock em localStorage. Campos ro da empresa resolvidos
  // do próprio mock de empresas (cadastro). Mesma interface do real (list por usuário/save/remove).
  usuarioEmpresa: (() => {
    const KEY = 'dealernet-portal-usuario-empresa'
    type Vinc = { usuarioCodigo: number; empresaCod: number; tarefa: boolean; permiteAgendamento: boolean; permiteAgendamentoOnline: boolean }
    const load = (): Vinc[] => {
      try { const r = localStorage.getItem(KEY); if (r) return JSON.parse(r) as Vinc[] } catch { /* recria */ }
      const seed: Vinc[] = [{ usuarioCodigo: 1, empresaCod: 1, tarefa: true, permiteAgendamento: false, permiteAgendamentoOnline: false }]
      localStorage.setItem(KEY, JSON.stringify(seed)); return [...seed]
    }
    const persist = (l: Vinc[]) => { try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* cota */ } }
    // Resolve os campos read-only da empresa (do cadastro de empresas mock).
    const enriquecer = async (v: Vinc): Promise<UsuarioEmpresa> => {
      const emp = (await cadastrosMock.empresa.list({ page: 1, size: 1000 })).data.find((e) => e.codigo === v.empresaCod)
      return {
        usuarioCodigo: v.usuarioCodigo,
        empresaCod: v.empresaCod,
        empresaNomFantasia: emp?.nomeFantasia ?? `Empresa #${v.empresaCod}`,
        empresaNom: emp?.nome ?? '',
        empresaMarcaSgl: emp?.grupoEmpresaNome ?? '',
        empresaAtivo: emp?.ativo ?? true,
        tarefa: v.tarefa,
        permiteAgendamento: v.permiteAgendamento,
        permiteAgendamentoOnline: v.permiteAgendamentoOnline,
      }
    }
    return {
      list: async (usuarioCodigo: number): Promise<UsuarioEmpresa[]> => {
        if (!usuarioCodigo) return delay([])
        const rows = load().filter((v) => v.usuarioCodigo === usuarioCodigo)
        return delay(await Promise.all(rows.map(enriquecer)))
      },
      save: (v: UsuarioEmpresa): Promise<{ ok: boolean; mensagem?: string }> => {
        const l = load()
        const i = l.findIndex((x) => x.usuarioCodigo === v.usuarioCodigo && x.empresaCod === v.empresaCod)
        const reg: Vinc = {
          usuarioCodigo: v.usuarioCodigo, empresaCod: v.empresaCod,
          tarefa: v.tarefa, permiteAgendamento: v.permiteAgendamento, permiteAgendamentoOnline: v.permiteAgendamentoOnline,
        }
        if (i >= 0) l[i] = reg
        else l.push(reg)
        persist(l)
        return delay({ ok: true })
      },
      remove: (v: UsuarioEmpresa): Promise<{ ok: boolean; mensagem?: string }> => {
        const l = load().filter((x) => !(x.usuarioCodigo === v.usuarioCodigo && x.empresaCod === v.empresaCod))
        persist(l)
        return delay({ ok: true })
      },
    }
  })(),

  // Vínculos Usuário×PerfilAcesso (N:N) — mock em localStorage. Descrição/tipo do perfil resolvidos
  // do próprio mock de perfis (cadastro). Mesma interface do real (list por usuário/save/remove).
  usuarioPerfil: (() => {
    const KEY = 'dealernet-portal-usuario-perfil'
    type Vinc = { usuarioCodigo: number; perfilCod: number; ativo: boolean }
    const load = (): Vinc[] => {
      try { const r = localStorage.getItem(KEY); if (r) return JSON.parse(r) as Vinc[] } catch { /* recria */ }
      const seed: Vinc[] = [{ usuarioCodigo: 1, perfilCod: 1, ativo: true }]
      localStorage.setItem(KEY, JSON.stringify(seed)); return [...seed]
    }
    const persist = (l: Vinc[]) => { try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* cota */ } }
    // Resolve os campos read-only do perfil (do cadastro de perfis mock).
    const enriquecer = async (v: Vinc): Promise<UsuarioPerfilAcesso> => {
      const p = (await cadastrosMock.perfilAcesso.list({ page: 1, size: 1000 })).data.find((x) => x.codigo === v.perfilCod)
      return {
        usuarioCodigo: v.usuarioCodigo,
        perfilCod: v.perfilCod,
        perfilDescricao: p?.descricao ?? `Perfil #${v.perfilCod}`,
        perfilTipo: p?.tipo ?? '',
        ativo: v.ativo,
      }
    }
    return {
      list: async (usuarioCodigo: number): Promise<UsuarioPerfilAcesso[]> => {
        if (!usuarioCodigo) return delay([])
        const rows = load().filter((v) => v.usuarioCodigo === usuarioCodigo)
        return delay(await Promise.all(rows.map(enriquecer)))
      },
      save: (v: UsuarioPerfilAcesso): Promise<{ ok: boolean; mensagem?: string }> => {
        const l = load()
        const i = l.findIndex((x) => x.usuarioCodigo === v.usuarioCodigo && x.perfilCod === v.perfilCod)
        const reg: Vinc = { usuarioCodigo: v.usuarioCodigo, perfilCod: v.perfilCod, ativo: v.ativo }
        if (i >= 0) l[i] = reg
        else l.push(reg)
        persist(l)
        return delay({ ok: true })
      },
      remove: (v: UsuarioPerfilAcesso): Promise<{ ok: boolean; mensagem?: string }> => {
        const l = load().filter((x) => !(x.usuarioCodigo === v.usuarioCodigo && x.perfilCod === v.perfilCod))
        persist(l)
        return delay({ ok: true })
      },
    }
  })(),

  // Vínculos Usuário×GrupoAcesso (N:N) — mock em localStorage. Descrição do grupo resolvida
  // do próprio mock de grupos (cadastro). Mesma interface do real (list por usuário/save/remove).
  usuarioGrupo: (() => {
    const KEY = 'dealernet-portal-usuario-grupo'
    type Vinc = { usuarioCodigo: number; grupoCod: number; ativo: boolean }
    const load = (): Vinc[] => {
      try { const r = localStorage.getItem(KEY); if (r) return JSON.parse(r) as Vinc[] } catch { /* recria */ }
      const seed: Vinc[] = [{ usuarioCodigo: 1, grupoCod: 1, ativo: true }]
      localStorage.setItem(KEY, JSON.stringify(seed)); return [...seed]
    }
    const persist = (l: Vinc[]) => { try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* cota */ } }
    // Resolve a descrição read-only do grupo (do cadastro de grupos de acesso mock).
    const enriquecer = async (v: Vinc): Promise<UsuarioGrupoAcesso> => {
      const g = (await cadastrosMock.grupoAcesso.list({ page: 1, size: 1000 })).data.find((x) => x.codigo === v.grupoCod)
      return {
        usuarioCodigo: v.usuarioCodigo,
        grupoCod: v.grupoCod,
        grupoDescricao: g?.descricao ?? `Grupo #${v.grupoCod}`,
        ativo: v.ativo,
      }
    }
    return {
      list: async (usuarioCodigo: number): Promise<UsuarioGrupoAcesso[]> => {
        if (!usuarioCodigo) return delay([])
        const rows = load().filter((v) => v.usuarioCodigo === usuarioCodigo)
        return delay(await Promise.all(rows.map(enriquecer)))
      },
      save: (v: UsuarioGrupoAcesso): Promise<{ ok: boolean; mensagem?: string }> => {
        const l = load()
        const i = l.findIndex((x) => x.usuarioCodigo === v.usuarioCodigo && x.grupoCod === v.grupoCod)
        const reg: Vinc = { usuarioCodigo: v.usuarioCodigo, grupoCod: v.grupoCod, ativo: v.ativo }
        if (i >= 0) l[i] = reg
        else l.push(reg)
        persist(l)
        return delay({ ok: true })
      },
      remove: (v: UsuarioGrupoAcesso): Promise<{ ok: boolean; mensagem?: string }> => {
        const l = load().filter((x) => !(x.usuarioCodigo === v.usuarioCodigo && x.grupoCod === v.grupoCod))
        persist(l)
        return delay({ ok: true })
      },
    }
  })(),

  // Senha provisória (mock: aceita qualquer senha ≥6 chars).
  setSenhaUsuario: (_codigo: number, senha: string): Promise<{ ok: boolean; mensagem?: string }> =>
    delay(senha.length >= 6 ? { ok: true } : { ok: false, mensagem: 'Mínimo de 6 caracteres.' }),

  // Opções de domínio enum (mock: alguns domínios comuns).
  buscarDominio: (nome: string): Promise<{ value: string; label: string }[]> => {
    const m: Record<string, { value: string; label: string }[]> = {
      DomUsuarioTipoAcesso: [
        { value: 'SI', label: 'Sistema' },
        { value: 'WS', label: 'Web Service' },
        { value: 'FO', label: 'Fornecedor' },
      ],
      SimNao: [
        { value: 'S', label: 'Sim' },
        { value: 'N', label: 'Não' },
      ],
    }
    return delay(m[nome] ?? [])
  },

  // Busca de Pessoa (mock: alguns registros fake filtrados pelo termo).
  buscarPessoa: (termo: string): Promise<{ codigo: number; nome: string; documento: string }[]> => {
    const base = [
      { codigo: 1, nome: 'AMILTON RIZZI', documento: '12345678900' },
      { codigo: 2, nome: 'MARIA SILVA', documento: '98765432100' },
    ]
    const t = termo.trim().toLowerCase()
    return delay(t ? base.filter((p) => p.nome.toLowerCase().includes(t) || p.documento.includes(t)) : [])
  },
}

// Escolhe a API real (backend GeneXus) ou os mocks locais, via flag de ambiente.
// VITE_USE_REAL_API=true → fala com a KB DealernetHubIntegration. (default: mock)
const USE_REAL = import.meta.env.VITE_USE_REAL_API === 'true'

export const portalApi = USE_REAL ? portalApiReal : portalApiMock
