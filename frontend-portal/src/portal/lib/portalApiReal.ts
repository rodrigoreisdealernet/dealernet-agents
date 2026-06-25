// Camada REAL de API — fala com a KB DealernetHubIntegration (.NET Core) via REST.
// Contratos conforme os OpenAPI gerados pelo GeneXus (NETCoreSQL/Web/API.API_Portal_*.yaml).
// Mesmas assinaturas do mock (portalApi) → o portalApi só escolhe entre os dois.
//
// Base: VITE_API_BASE = /DealernetHubIntegration/api/v1/portal (via proxy Vite).
// Sessão por cookie HttpOnly → todas as chamadas usam credentials:'include'.

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
  TemaPortal,
  Usuario,
  WindowSpec,
  Workspace,
  WorkspaceData,
  WorkspaceMeta,
} from '@/portal/types'
import type { ListQuery, ListResult } from '@/portal/components/datatable/types'
import { notifySessionExpired } from '@/portal/lib/sessionEvents'

const BASE = import.meta.env.VITE_API_BASE ?? '/DealernetHubIntegration/api/v1/portal'

// Erro de rede/servidor SEM corpo de negócio (fetch falhou, 5xx sem JSON).
// Distingue-se de uma resposta de negócio (ex.: 401 com {autenticado:false}).
export class NetworkError extends Error {}

// A mensagem de falha do login indica problema TÉCNICO (não credencial)? Usada p/
// decidir retry (cold start do WS de autenticação) e p/ classificar SERVICE_UNAVAILABLE.
function pareceTimeout(msg?: string): boolean {
  const raw = (msg || '').toLowerCase()
  return (
    /\b5\d\d\b/.test(raw) ||
    raw.includes('internal server') ||
    raw.includes('remote server') ||
    raw.includes('servidor remoto') ||
    raw.includes('host') ||
    raw.includes('timeout') ||
    raw.includes('time out') ||
    raw.includes('canceled') ||
    raw.includes('conex') ||
    raw.includes('indispon') ||
    raw.includes('workflow') ||
    raw.includes('aspx') ||
    raw.includes('http')
  )
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init?.headers },
      ...init,
    })
  } catch {
    // fetch lançou → realmente não conectou (rede/CORS/servidor fora)
    throw new NetworkError(`Sem conexão com o servidor em ${path}`)
  }

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  // Resposta de NEGÓCIO da DHI: JSON de objeto (mesmo com 401/400, os API objects
  // GeneXus usam {autenticado:false,...} / envelope {StatusCode,...} como negócio).
  // Em status 2xx aceitamos o corpo direto.
  const isJsonObject = body !== null && typeof body === 'object'

  // Sessão expirada/inválida: chamada AUTENTICADA (não o próprio login) voltou
  // autenticado:false ou envelope StatusCode 401 → avisa o portal (SessionGuard).
  // /identity/auth e /bridge/validar tratam o próprio "não autenticado" (credencial/token).
  const ehAuthEndpoint = path.includes('/identity/auth') || path.includes('/bridge/validar')
  if (isJsonObject && !ehAuthEndpoint) {
    const o = body as Record<string, unknown>
    const naoAutenticado =
      o.autenticado === false || Number(o.StatusCode ?? 0) === 401
    if (naoAutenticado) notifySessionExpired('A sessão expirou ou é inválida.')
  }

  if (res.ok && isJsonObject) return body as T

  // Status de erro (4xx/5xx): só é negócio se o JSON tiver a "cara" do contrato da DHI
  // (campos conhecidos). Caso contrário — 404 de rota inexistente, página de erro do
  // IIS, gateway 502/503 — é FALHA DE COMUNICAÇÃO com a DHI, não resposta de negócio.
  if (!res.ok) {
    const looksBusiness =
      isJsonObject &&
      ('autenticado' in (body as object) ||
        'StatusCode' in (body as object) ||
        'mensagem' in (body as object) ||
        'ErrorMessage' in (body as object))
    if (looksBusiness) return body as T
    throw new NetworkError(`Falha de comunicação com a DHI (HTTP ${res.status}) em ${path}`)
  }
  return body as T
}

// ---- Padrão BFF LEAN v3 (resposta única SDT_DHI_ApiResponse {StatusCode, Content, ErrorMessage}) ----
// Toda API lean responde esse envelope. Content = JSON string da lista (List) ou do registro (Save).
interface DhiApiResponse {
  // GeneXus serializa StatusCode como string ("200"); Content como string JSON. Tolerar ambos.
  StatusCode?: number | string
  Content?: string | unknown
  ErrorMessage?: string
}

// ---- Shapes do backend (GeneXus) ----
interface AuthOutput {
  autenticado: boolean
  mensagem?: string
  SDT_Usuario?: { Usuario_Identificador?: string; Usuario_Nome?: string }
}
interface MeOutput {
  autenticado: boolean
  SDT_Usuario?: {
    Usuario_Identificador?: string
    Usuario_Nome?: string
    Usuario_EmpresaCodDefault?: number
    Usuario_EmpresaNomDefault?: string
    Empresa?: { EmpresaItems?: EmpresaItem[] }
  }
}
interface EmpresaItem {
  UsuarioEmp_EmpresaCod: number
  UsuarioEmp_EmpresaNomFantasia: string
  UsuarioEmp_EmpresaMarcaSgl: string
}
interface ConfigOutput {
  autenticado: boolean
  SDT_PortalConfig?: {
    portalName?: string
    userName?: string
    tempoSessao?: number
    accent?: string
    theme?: string
    logoUrl?: string
    allowedOrigins?: string
    logoutUrl?: string
    alteraSenhaUrl?: string
    changeCompanyUrl?: string
  }
}
// Nó da árvore JÁ MONTADA pela SP_DealernetCRM_Menu (formato DVelop_Menu).
// A SP devolve a árvore pronta (recursiva via subItems), já filtrada por permissão
// e por idioma — o front só traduz para MenuItem, não monta hierarquia.
interface SpMenuNode {
  id?: string
  caption?: string
  link?: string
  linkTarget?: string
  iconClass?: string
  tooltip?: string
  subItems?: SpMenuNode[]
}
// Cada produto (módulo do DMS) vem com a árvore como JSON cru (menuJson).
interface PortalMenuItemRaw {
  produto?: string
  label?: string
  menuJson?: string
}
interface WsItem {
  text?: string // nome
  id?: string // Workspace_Codigo (string)
  src?: string // Json
}
interface ListOutput {
  autenticado: boolean
  SDT_Workspace?: WsItem[]
}
interface GetOutput {
  autenticado: boolean
  encontrado: boolean
  Json?: string
}
interface SaveOutput {
  autenticado: boolean
  ok: boolean
  Workspace_CodigoOut?: number
  mensagem?: string
}
interface DeleteOutput {
  autenticado: boolean
  ok: boolean
  mensagem?: string
}

// ---- Fábrica de CRUD de cadastro — padrão BFF LEAN v3 (único Dealernet) ----
// API: GET List(&Codigo,&Filtros), POST Insert(item), PUT Update(item).
// Resposta única SDT_DHI_ApiResponse {StatusCode, Content(JSON), ErrorMessage}.
// Sem Get/Delete: Get = List com &Codigo; soft delete = Save com ativo:false.
interface CrudShapes {
  rota: string
  /** Campo do registro que carrega a PK (p/ Save saber Insert vs Update e p/ soft delete). */
  pkField: string
  /** Mapa coluna→Campo do SDT_Filtro (ex.: { ativo: 'Ativo', nome: 'Nome' }). Default: usa a própria coluna. */
  filtroCampos?: Record<string, string>
  /** Campo de busca textual da entidade no backend. Cargo/Departamento/Equipe/Setor = 'Descricao';
   * Empresa/GrupoEmpresa/Usuario = 'Nome'. Default 'Nome'. */
  buscaCampo?: string
  /** PK char (ex. SolucaoDMS.TipoProduto): na LISTAGEM, &Codigo deve ir VAZIO (não '0').
   * '0' vira um código literal inexistente → lista vazia. PK numérica usa '0' = listar. */
  pkChar?: boolean
}

// Lean: monta o JSON do SDT_Filtro a partir do ListQuery (busca + filtros de coluna).
// ⚠️ Só inclui filtros que o backend SUPORTA (Campo mapeado em filtroCampos OU a busca textual).
// Colunas sem mapeamento NÃO viram filtro server (o List responde 400 "filtro nao suportado");
// elas são refinadas no cliente pelo DataTable.
function montarFiltros(cfg: CrudShapes, q?: ListQuery): string {
  const filtros: { Campo: string; Valor: string }[] = []
  if (q?.busca?.trim()) filtros.push({ Campo: cfg.buscaCampo ?? 'Nome', Valor: q.busca.trim() })
  for (const [col, raw] of Object.entries(q?.filters ?? {})) {
    // só manda ao server o que está explicitamente mapeado (evita 400 por filtro não suportado)
    const campo = cfg.filtroCampos?.[col]
    if (!campo) continue
    const valor = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
    if (valor && !valor.includes(',')) filtros.push({ Campo: campo, Valor: valor })
  }
  return JSON.stringify({ Page: q?.page ?? 1, Size: q?.size ?? 50, Filtros: filtros })
}

// O GeneXus serializa SDT_DHI_ApiResponse.StatusCode como STRING ("200"/"401") — coagir p/ número.
function statusNum(resp: DhiApiResponse): number {
  return Number(resp?.StatusCode ?? 0) || 0
}
// Content vem como STRING JSON (lista) — mas tolera objeto/array já parseado.
function parseContent(resp: DhiApiResponse): Record<string, unknown>[] {
  const c = resp?.Content
  if (!c) return []
  if (Array.isArray(c)) return c as Record<string, unknown>[]
  if (typeof c === 'string') {
    try {
      const v = JSON.parse(c)
      return Array.isArray(v) ? v : v ? [v] : []
    } catch {
      return []
    }
  }
  return [c as Record<string, unknown>]
}

function crudReal<T>(
  cfg: CrudShapes,
  toApi: (t: T) => Record<string, unknown>,
  fromApi: (r: Record<string, unknown>) => T,
) {
  return {
    list: async (q?: ListQuery): Promise<ListResult<T>> => {
      const filtros = encodeURIComponent(montarFiltros(cfg, q))
      // PK char: OMITIR &Codigo da query = listagem. Mandar Codigo VAZIO ('?Codigo=&...') dá HTTP 400
      //          (o binding do GeneXus rejeita string vazia explícita num parâmetro char).
      // PK num:  &Codigo=0 = listagem (vazio também daria 400 no binding numérico).
      const qs = cfg.pkChar ? `Filtros=${filtros}` : `Codigo=0&Filtros=${filtros}`
      const out = await req<DhiApiResponse>(`/${cfg.rota}/list?${qs}`)
      const st = statusNum(out)
      if (st >= 400) throw new NetworkError(out.ErrorMessage || `Erro ${st}`)
      const arr = parseContent(out)
      return { data: arr.map(fromApi), total: arr.length }
    },
    // Save = porta única. PK vazia/0 → POST /insert; senão → PUT /update. Soft delete = ativo:false via /update.
    // O método REST do GeneXus expõe Insert/Update como /<rota>/insert e /<rota>/update (NÃO POST/PUT na raiz),
    // e recebe o parm `in:&Item` → o corpo TEM de ser { "Item": { ...campos... } } (não o objeto plano).
    save: async (t: T): Promise<{ ok: boolean; mensagem?: string }> => {
      const pk = (t as Record<string, unknown>)[cfg.pkField]
      const novo = pk === 0 || pk === '' || pk === undefined || pk === null
      const out = await req<DhiApiResponse>(`/${cfg.rota}/${novo ? 'insert' : 'update'}`, {
        method: novo ? 'POST' : 'PUT',
        body: JSON.stringify({ Item: toApi(t) }),
      })
      const st = statusNum(out)
      return { ok: st < 400, mensagem: st < 400 ? undefined : out.ErrorMessage }
    },
    // Soft delete: o front passa o registro; aqui marca ativo:false e faz Update (/update com { Item }).
    remove: async (item: T): Promise<{ ok: boolean; mensagem?: string }> => {
      const out = await req<DhiApiResponse>(`/${cfg.rota}/update`, {
        method: 'PUT',
        body: JSON.stringify({ Item: { ...toApi(item), Ativo: false } }),
      })
      const st = statusNum(out)
      return { ok: st < 400, mensagem: st < 400 ? undefined : out.ErrorMessage }
    },
  }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)
// Converte para string. number/boolean viram texto (o backend manda PK char como number quando
// o valor é numérico, ex. Codigo "1"); só null/undefined viram ''.
const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v))
const bool = (v: unknown): boolean => v === true

const cadastrosReal = {
  cargo: crudReal<Cargo>(
    { rota: 'cargo', pkField: 'codigo', buscaCampo: 'Descricao', filtroCampos: { descricao: 'Descricao', ativo: 'Ativo' } },
    (t) => ({ Codigo: t.codigo, Descricao: t.descricao, Ativo: t.ativo }),
    (r) => ({ codigo: num(r.Codigo), descricao: str(r.Descricao), ativo: bool(r.Ativo) }),
  ),
  departamento: crudReal<Departamento>(
    { rota: 'departamento', pkField: 'codigo', buscaCampo: 'Descricao', filtroCampos: { descricao: 'Descricao', ativo: 'Ativo' } },
    (t) => ({ Codigo: t.codigo, Descricao: t.descricao, Ativo: t.ativo }),
    (r) => ({ codigo: num(r.Codigo), descricao: str(r.Descricao), ativo: bool(r.Ativo) }),
  ),
  grupoAcesso: crudReal<GrupoAcesso>(
    { rota: 'grupoacesso', pkField: 'codigo', buscaCampo: 'Descricao', filtroCampos: { descricao: 'Descricao', ativo: 'Ativo' } },
    (t) => ({ Codigo: t.codigo, Descricao: t.descricao, Observacao: t.observacao, Ativo: t.ativo }),
    (r) => ({ codigo: num(r.Codigo), descricao: str(r.Descricao), observacao: str(r.Observacao), ativo: bool(r.Ativo) }),
  ),
  grupoEmpresa: crudReal<GrupoEmpresa>(
    { rota: 'grupoempresa', pkField: 'codigo', filtroCampos: { nome: 'Nome', metodoAutenticacao: 'MetodoAutenticacao', ativo: 'Ativo' } },
    (t) => ({
      Codigo: t.codigo, Nome: t.nome, MetodoAutenticacao: t.metodoAutenticacao,
      ValidaGrupoFinanceiro: t.validaGrupoFinanceiro, DealerNet: t.dealerNet,
      GoogleAnalytics: t.googleAnalytics, GoogleAds: t.googleAds,
      ReCaptchaSiteKey: t.reCaptchaSiteKey, ReCaptchaSecretKey: t.reCaptchaSecretKey, Ativo: t.ativo,
    }),
    (r) => ({
      codigo: num(r.Codigo), nome: str(r.Nome), metodoAutenticacao: str(r.MetodoAutenticacao),
      validaGrupoFinanceiro: bool(r.ValidaGrupoFinanceiro), dealerNet: bool(r.DealerNet),
      googleAnalytics: str(r.GoogleAnalytics), googleAds: str(r.GoogleAds),
      reCaptchaSiteKey: str(r.ReCaptchaSiteKey), reCaptchaSecretKey: str(r.ReCaptchaSecretKey), ativo: bool(r.Ativo),
    }),
  ),
  perfilAcesso: crudReal<PerfilAcesso>(
    { rota: 'perfilacesso', pkField: 'codigo', filtroCampos: { descricao: 'Descricao', tipo: 'Tipo', ativo: 'Ativo' } },
    (t) => ({
      Codigo: t.codigo, Descricao: t.descricao, Tipo: t.tipo, Prioridade: t.prioridade,
      PermiteSMS: t.permiteSMS, DiasPrevisaoEntrega: t.diasPrevisaoEntrega, DiasLimiteCredito: t.diasLimiteCredito, Ativo: t.ativo,
    }),
    (r) => ({
      codigo: num(r.Codigo),
      descricao: str(r.Descricao),
      tipo: str(r.Tipo),
      prioridade: num(r.Prioridade),
      permiteSMS: str(r.PermiteSMS),
      diasPrevisaoEntrega: num(r.DiasPrevisaoEntrega),
      diasLimiteCredito: num(r.DiasLimiteCredito),
      ativo: bool(r.Ativo),
    }),
  ),
  empresa: crudReal<EmpresaCadastro>(
    { rota: 'empresa', pkField: 'codigo', filtroCampos: { nome: 'Nome', nomeFantasia: 'NomeFantasia', segmento: 'Segmento', ativo: 'Ativo' } },
    // DocIdentificador/GrupoEmpresaNome/PessoaNom = ro (não vão no Save; o backend ignora/infere).
    (t) => ({
      Codigo: t.codigo, Nome: t.nome, NomeFantasia: t.nomeFantasia,
      GrupoEmpresaCod: t.grupoEmpresaCod, RegimeTributaria: t.regimeTributaria, Segmento: t.segmento,
      CentroDistribuicao: t.centroDistribuicao, DealerNet: t.dealerNet, URLImagem: t.urlImagem,
      PessoaCod: t.pessoaCod, Ativo: t.ativo,
    }),
    (r) => ({
      codigo: num(r.Codigo),
      nome: str(r.Nome),
      nomeFantasia: str(r.NomeFantasia),
      docIdentificador: str(r.DocIdentificador),
      grupoEmpresaCod: num(r.GrupoEmpresaCod),
      grupoEmpresaNome: str(r.GrupoEmpresaNome),
      regimeTributaria: str(r.RegimeTributaria),
      segmento: str(r.Segmento),
      centroDistribuicao: bool(r.CentroDistribuicao),
      dealerNet: bool(r.DealerNet),
      urlImagem: str(r.URLImagem),
      pessoaCod: num(r.PessoaCod),
      pessoaNom: str(r.PessoaNom),
      ativo: bool(r.Ativo),
    }),
  ),
  equipe: crudReal<Equipe>(
    { rota: 'equipe', pkField: 'codigo', buscaCampo: 'Descricao', filtroCampos: { descricao: 'Descricao', ativo: 'Ativo' } },
    (t) => ({ Codigo: t.codigo, Descricao: t.descricao, Cor: t.cor, AtivoAgendamento: t.ativoAgendamento, Ativo: t.ativo }),
    (r) => ({ codigo: num(r.Codigo), descricao: str(r.Descricao), cor: str(r.Cor), ativoAgendamento: bool(r.AtivoAgendamento), ativo: bool(r.Ativo) }),
  ),
  setorServico: crudReal<SetorServico>(
    { rota: 'setorservico', pkField: 'codigo', buscaCampo: 'Descricao', filtroCampos: { descricao: 'Descricao', tipo: 'Tipo', ativo: 'Ativo' } },
    (t) => ({ Codigo: t.codigo, Descricao: t.descricao, Tipo: t.tipo, Ativo: t.ativo }),
    (r) => ({ codigo: num(r.Codigo), descricao: str(r.Descricao), tipo: str(r.Tipo), ativo: bool(r.Ativo) }),
  ),
  usuario: crudReal<Usuario>(
    { rota: 'usuario', pkField: 'codigo', filtroCampos: { nome: 'Nome', tipoAcesso: 'TipoAcesso', ativo: 'Ativo' } },
    (t) => ({
      Codigo: t.codigo,
      Nome: t.nome,
      Identificador: t.identificador,
      IdentificadorAlternativo: t.identificadorAlternativo,
      Email: t.email,
      TipoAcesso: t.tipoAcesso,
      EmpresaCodDefault: t.empresaCodDefault,
      Equipe: t.equipe,
      Cargo: t.cargo,
      SetorServico: t.setorServico,
      PessoaCod: t.pessoaCod,
      Administrador: t.administrador,
      DataAdmissao: t.dataAdmissao,
      DataDemissao: t.dataDemissao,
      DiasExpiracaoSenha: t.diasExpiracaoSenha,
      AutenticaLocal: t.autenticaLocal,
      Ativo: t.ativo,
    }),
    // displays FK (*_Descricao/Pessoa*) = ro: vêm no fromApi p/ exibir, não vão no toApi.
    (r) => ({
      codigo: num(r.Codigo),
      nome: str(r.Nome),
      identificador: str(r.Identificador),
      identificadorAlternativo: str(r.IdentificadorAlternativo),
      email: str(r.Email),
      tipoAcesso: str(r.TipoAcesso),
      empresaCodDefault: num(r.EmpresaCodDefault),
      equipe: num(r.Equipe),
      equipeDescricao: str(r.EquipeDescricao),
      cargo: num(r.Cargo),
      cargoDescricao: str(r.CargoDescricao),
      setorServico: num(r.SetorServico),
      setorServicoDescricao: str(r.SetorServicoDescricao),
      pessoaCod: num(r.PessoaCod),
      pessoaNom: str(r.PessoaNom),
      pessoaDoc: str(r.PessoaDoc),
      administrador: bool(r.Administrador),
      dataAdmissao: str(r.DataAdmissao),
      dataDemissao: str(r.DataDemissao),
      diasExpiracaoSenha: num(r.DiasExpiracaoSenha),
      autenticaLocal: bool(r.AutenticaLocal),
      ativo: bool(r.Ativo),
    }),
  ),
}


// SolucaoDMS — CRUD LEAN (PK char tipoProduto). Usa a fatory genérica como os demais.
const solucaoDMSReal = crudReal<SolucaoDMS>(
  { rota: 'solucaodms', pkField: 'tipoProduto', pkChar: true, filtroCampos: { nome: 'Nome', tipoProduto: 'TipoProduto', ativo: 'Ativo' } },
  (t) => ({
    TipoProduto: t.tipoProduto,
    Nome: t.nome,
    UrlBase: t.urlBase,
    UrlBaseSpa: t.urlBaseSpa,
    ClasseIcone: t.classeIcone,
    Sequencia: t.sequencia,
    Ativo: t.ativo,
  }),
  (r) => ({
    tipoProduto: str(r.TipoProduto),
    nome: str(r.Nome),
    urlBase: str(r.UrlBase),
    urlBaseSpa: str(r.UrlBaseSpa),
    classeIcone: str(r.ClasseIcone),
    sequencia: num(r.Sequencia),
    ativo: bool(r.Ativo),
  }),
)

// ---- Vínculos Usuário×Empresa (N:N) — API_Portal_UsuarioEmpresa (PK composta) ----
// List filtra pelo PAI: GET /usuarioempresa/list?Codigo=<usuarioCodigo>&Filtros=... (Codigo = Usuario_Codigo).
// Save upsert: POST/PUT com as 2 chaves + flags. Delete FÍSICO: DELETE com as 2 chaves (query).
import type { UsuarioEmpresa, UsuarioGrupoAcesso, UsuarioPerfilAcesso } from '@/portal/types'

const ueToApi = (t: UsuarioEmpresa): Record<string, unknown> => ({
  UsuarioCodigo: t.usuarioCodigo,
  EmpresaCod: t.empresaCod,
  Tarefa: t.tarefa,
  PermiteAgendamento: t.permiteAgendamento,
  PermiteAgendamentoOnline: t.permiteAgendamentoOnline,
})
const ueFromApi = (r: Record<string, unknown>): UsuarioEmpresa => ({
  usuarioCodigo: num(r.UsuarioCodigo),
  empresaCod: num(r.EmpresaCod),
  empresaNomFantasia: str(r.EmpresaNomFantasia),
  empresaNom: str(r.EmpresaNom),
  empresaMarcaSgl: str(r.EmpresaMarcaSgl),
  empresaAtivo: bool(r.EmpresaAtivo),
  tarefa: bool(r.Tarefa),
  permiteAgendamento: bool(r.PermiteAgendamento),
  permiteAgendamentoOnline: bool(r.PermiteAgendamentoOnline),
})

// ---- Vínculos Usuário×PerfilAcesso (N:N) — API_Portal_UsuarioPerfil (PK composta) ----
// List filtra pelo PAI: GET /usuarioperfil/list?Codigo=<usuarioCodigo>&Filtros=... (Codigo = Usuario_Codigo).
// Save upsert: PUT com as 2 chaves. Delete FÍSICO: DELETE com as 2 chaves (query). Perfil ro.
const upToApi = (t: UsuarioPerfilAcesso): Record<string, unknown> => ({
  UsuarioCodigo: t.usuarioCodigo,
  PerfilCod: t.perfilCod,
  Ativo: t.ativo,
})
const upFromApi = (r: Record<string, unknown>): UsuarioPerfilAcesso => ({
  usuarioCodigo: num(r.UsuarioCodigo),
  perfilCod: num(r.PerfilCod),
  perfilDescricao: str(r.PerfilDescricao),
  perfilTipo: str(r.PerfilTipo),
  ativo: bool(r.Ativo),
})

const usuarioPerfilReal = {
  // Lista os perfis de um usuário (Codigo = Usuario_Codigo do pai). Codigo 0/inexistente → 400 no backend.
  list: async (usuarioCodigo: number): Promise<UsuarioPerfilAcesso[]> => {
    if (!usuarioCodigo) return []
    const out = await req<DhiApiResponse>(`/usuarioperfil/list?Codigo=${usuarioCodigo}&Filtros=`)
    if (statusNum(out) >= 400) throw new NetworkError(out.ErrorMessage || 'Erro ao listar perfis')
    return parseContent(out).map(upFromApi)
  },
  // Upsert do vínculo (Insert se novo, Update se existe — o BC detecta pela PK composta no Load).
  // Rota GeneXus = /update (PUT), corpo { Item: {...} } (parm in:&Item). Idempotente p/ insert/update.
  save: async (v: UsuarioPerfilAcesso): Promise<{ ok: boolean; mensagem?: string }> => {
    const out = await req<DhiApiResponse>('/usuarioperfil/update', {
      method: 'PUT',
      body: JSON.stringify({ Item: upToApi(v) }),
    })
    const st = statusNum(out)
    return { ok: st < 400, mensagem: st < 400 ? undefined : out.ErrorMessage }
  },
  // Remoção FÍSICA do vínculo (par usuário+perfil). Método REST GeneXus = /delete, chaves via query.
  remove: async (v: UsuarioPerfilAcesso): Promise<{ ok: boolean; mensagem?: string }> => {
    const out = await req<DhiApiResponse>(
      `/usuarioperfil/delete?UsuarioCodigo=${v.usuarioCodigo}&PerfilCod=${v.perfilCod}`,
      { method: 'DELETE' },
    )
    const st = statusNum(out)
    return { ok: st < 400, mensagem: st < 400 ? undefined : out.ErrorMessage }
  },
}

// ---- Vínculos Usuário×GrupoAcesso (N:N) — API_Portal_UsuarioGrupo (PK composta) ----
// List filtra pelo PAI: GET /usuariogrupo/list?Codigo=<usuarioCodigo>&Filtros=... (Codigo = Usuario_Codigo).
// Save upsert: PUT com as 2 chaves. Delete FÍSICO: DELETE com as 2 chaves (query). Grupo ro.
const ugToApi = (t: UsuarioGrupoAcesso): Record<string, unknown> => ({
  UsuarioCodigo: t.usuarioCodigo,
  GrupoCod: t.grupoCod,
  Ativo: t.ativo,
})
const ugFromApi = (r: Record<string, unknown>): UsuarioGrupoAcesso => ({
  usuarioCodigo: num(r.UsuarioCodigo),
  grupoCod: num(r.GrupoCod),
  grupoDescricao: str(r.GrupoDescricao),
  ativo: bool(r.Ativo),
})

const usuarioGrupoReal = {
  // Lista os grupos de um usuário (Codigo = Usuario_Codigo do pai). Codigo 0/inexistente → 400 no backend.
  list: async (usuarioCodigo: number): Promise<UsuarioGrupoAcesso[]> => {
    if (!usuarioCodigo) return []
    const out = await req<DhiApiResponse>(`/usuariogrupo/list?Codigo=${usuarioCodigo}&Filtros=`)
    if (statusNum(out) >= 400) throw new NetworkError(out.ErrorMessage || 'Erro ao listar grupos')
    return parseContent(out).map(ugFromApi)
  },
  // Upsert do vínculo (Insert se novo, Update se existe — o BC detecta pela PK composta no Load).
  // Rota GeneXus = /update (PUT), corpo { Item: {...} } (parm in:&Item). Idempotente p/ insert/update.
  save: async (v: UsuarioGrupoAcesso): Promise<{ ok: boolean; mensagem?: string }> => {
    const out = await req<DhiApiResponse>('/usuariogrupo/update', {
      method: 'PUT',
      body: JSON.stringify({ Item: ugToApi(v) }),
    })
    const st = statusNum(out)
    return { ok: st < 400, mensagem: st < 400 ? undefined : out.ErrorMessage }
  },
  // Remoção FÍSICA do vínculo (par usuário+grupo). Método REST GeneXus = /delete, chaves via query.
  remove: async (v: UsuarioGrupoAcesso): Promise<{ ok: boolean; mensagem?: string }> => {
    const out = await req<DhiApiResponse>(
      `/usuariogrupo/delete?UsuarioCodigo=${v.usuarioCodigo}&GrupoCod=${v.grupoCod}`,
      { method: 'DELETE' },
    )
    const st = statusNum(out)
    return { ok: st < 400, mensagem: st < 400 ? undefined : out.ErrorMessage }
  },
}

const usuarioEmpresaReal = {
  // Lista os vínculos de um usuário (Codigo = Usuario_Codigo do pai). Codigo 0/inexistente → 400 no backend.
  list: async (usuarioCodigo: number): Promise<UsuarioEmpresa[]> => {
    if (!usuarioCodigo) return []
    const out = await req<DhiApiResponse>(`/usuarioempresa/list?Codigo=${usuarioCodigo}&Filtros=`)
    if (statusNum(out) >= 400) throw new NetworkError(out.ErrorMessage || 'Erro ao listar vínculos')
    return parseContent(out).map(ueFromApi)
  },
  // Upsert do vínculo (Insert se novo, Update se existe — o BC detecta pela PK composta no Load).
  // Rota GeneXus = /update (PUT), corpo { Item: {...} } (parm in:&Item). Idempotente p/ insert/update.
  save: async (v: UsuarioEmpresa): Promise<{ ok: boolean; mensagem?: string }> => {
    const out = await req<DhiApiResponse>('/usuarioempresa/update', {
      method: 'PUT',
      body: JSON.stringify({ Item: ueToApi(v) }),
    })
    const st = statusNum(out)
    return { ok: st < 400, mensagem: st < 400 ? undefined : out.ErrorMessage }
  },
  // Remoção FÍSICA do vínculo (par usuário+empresa). Método REST GeneXus = /delete, chaves via query.
  remove: async (v: UsuarioEmpresa): Promise<{ ok: boolean; mensagem?: string }> => {
    const out = await req<DhiApiResponse>(
      `/usuarioempresa/delete?UsuarioCodigo=${v.usuarioCodigo}&EmpresaCod=${v.empresaCod}`,
      { method: 'DELETE' },
    )
    const st = statusNum(out)
    return { ok: st < 400, mensagem: st < 400 ? undefined : out.ErrorMessage }
  },
}

// ---- API de Domínios: opções (value+label) de um domínio enum da KB ----
// GET dominio/list?Nome=<Dom> → SDT_DHI_ApiResponse com Content = JSON [{value,label}].
// Cache em memória por domínio (são estáticos por sessão).
const _domCache = new Map<string, { value: string; label: string }[]>()
async function buscarDominioReal(nome: string): Promise<{ value: string; label: string }[]> {
  if (_domCache.has(nome)) return _domCache.get(nome)!
  const out = await req<DhiApiResponse>(`/dominio/list?Nome=${encodeURIComponent(nome)}`)
  if (statusNum(out) >= 400) return []
  const arr = parseContent(out) as unknown as { value: string; label: string }[]
  const opts = arr.map((o) => ({ value: str(o.value), label: str(o.label) }))
  _domCache.set(nome, opts)
  return opts
}

// ---- Busca server-side de Pessoa (tabela grande → typeahead, não combo) ----
// GET pessoa/busca?Termo=<x>&Size=20 → [{codigo,nome,documento}]. Para autocomplete.
export interface PessoaBusca {
  codigo: number
  nome: string
  documento: string
}
async function buscarPessoaReal(termo: string, size = 20): Promise<PessoaBusca[]> {
  if (!termo?.trim()) return []
  const out = await req<DhiApiResponse>(
    `/pessoa/busca?Termo=${encodeURIComponent(termo.trim())}&Size=${size}`,
  )
  if (statusNum(out) >= 400) return []
  return parseContent(out).map((r) => ({
    codigo: num(r.codigo),
    nome: str(r.nome),
    documento: str(r.documento),
  }))
}

// Define senha provisória do usuário (API_Portal_UsuarioSenha → /usuariosenha/setsenha).
async function setSenhaReal(
  usuarioCodigo: number,
  senha: string,
): Promise<{ ok: boolean; mensagem?: string }> {
  const out = await req<{ ok?: boolean; mensagem?: string }>('/usuariosenha/setsenha', {
    method: 'POST',
    body: JSON.stringify({ Usuario_Codigo: usuarioCodigo, SenhaProvisoria: senha }),
  })
  return { ok: !!out.ok, mensagem: out.mensagem }
}

// Rótulos amigáveis dos produtos/módulos do DMS (enum PacoteProduto da KB).
// Fallback: usa o próprio código quando não mapeado.
const PRODUTO_LABEL: Record<string, string> = {
  DWF: 'Dealernet WF',
  DWIN: 'Dealernet WIN',
  DNWA: 'Fast Service',
  FASTRENTAL: 'Fast Rental',
  FASTREPORT: 'Fast Report',
  FANDI: 'F&I',
  MONITORNFE: 'Monitor NF-e/NFS-e',
  DHI: 'Hub Integration',
}

// Deriva a janela a abrir a partir do `link` que a SP devolve.
// - http(s)://...      → iframe externo (sujeito à allowlist de origem)
// - termina em .aspx   → tela legada WWP/ASPX, servida pelo ERP (mesma origem): '../<link>'
// - rota simples (ex.: 'home', 'leads') → rota React do próprio ERP: '../<link>'
// (folha = sem subItems e com link não vazio)
function specFromLink(caption: string, link: string, icon?: string): WindowSpec | undefined {
  const url = (link ?? '').trim()
  if (!url) return undefined
  if (/^https?:\/\//i.test(url)) {
    return { title: caption, kind: 'iframe-external', src: url, icon }
  }
  return { title: caption, kind: 'iframe-aspx', src: `../${url}`, icon }
}

// Converte um nó da árvore da SP (caption/link/subItems) em MenuItem do portal.
function spNodeToItem(n: SpMenuNode, prefix: string): MenuItem {
  const caption = (n.caption ?? '').trim()
  const id = `${prefix}-${n.id ?? caption}`
  const kids = Array.isArray(n.subItems) ? n.subItems : []
  const isGroup = kids.length > 0
  const icon = n.iconClass || undefined
  return {
    id,
    text: caption,
    icon,
    // a janela/aba herda o ícone da tela (não só o do tipo).
    spec: isGroup ? undefined : specFromLink(caption, n.link ?? '', icon),
    children: isGroup ? kids.map((k) => spNodeToItem(k, id)) : undefined,
  }
}

// Monta o menu do DMS: PRODUTO no 1º nível; dentro, a ÁRVORE pronta da SP.
// `items` = SDT_PortalMenu (1 entrada por produto, cada uma com a árvore em menuJson).
function buildMenuTree(items: PortalMenuItemRaw[]): MenuItem[] {
  const out: MenuItem[] = []
  for (const it of items) {
    const prod = (it.produto ?? '').trim()
    if (!prod) continue
    let tree: SpMenuNode[] = []
    try {
      const parsed = it.menuJson ? JSON.parse(it.menuJson) : []
      tree = Array.isArray(parsed) ? parsed : []
    } catch {
      tree = []
    }
    if (tree.length === 0) continue
    out.push({
      id: `produto-${prod}`,
      text: PRODUTO_LABEL[prod] ?? it.label?.trim() ?? prod,
      children: tree.map((n) => spNodeToItem(n, `produto-${prod}`)),
    })
  }
  return out
}

// Itens de menu injetados em DEV (VITE_MOCK_MENU_EXTRA=true), para abrir telas
// nativas novas antes da SP de menu publicá-las. Removível sem impacto.
// Menu FAKE de DEV (VITE_MOCK_MENU_EXTRA=true) — testa hierarquia MULTI-NÍVEL:
// Sistema "Dealernet Workflow" → Administração → Segurança/Empresarial → cadastros.
// Espelha a estrutura real do ERP (tabela Menu: Administração 01 > Segurança 0102 / Empresarial 0103).

// URL pública do DHI Front. Em dev local = localhost:5175 (hardcoded nos itens abaixo).
// Para demo via túnel (ngrok), defina VITE_DHI_FRONT_URL=https://<sub>.ngrok-free.app e
// reescrevemos os src dos cadastros para essa origem (reescreverMenuDhi).
const DHI_FRONT_LOCAL = 'http://localhost:5175'
const DHI_FRONT_URL = (import.meta.env.VITE_DHI_FRONT_URL || '').trim().replace(/\/$/, '')

// Reescreve recursivamente os src que apontam p/ o DHI Front local → URL pública (ngrok).
function reescreverMenuDhi(items: MenuItem[]): MenuItem[] {
  if (!DHI_FRONT_URL || DHI_FRONT_URL === DHI_FRONT_LOCAL) return items
  const fix = (it: MenuItem): MenuItem => ({
    ...it,
    spec: it.spec?.src?.includes(DHI_FRONT_LOCAL)
      ? { ...it.spec, src: it.spec.src.replace(DHI_FRONT_LOCAL, DHI_FRONT_URL) }
      : it.spec,
    children: it.children ? it.children.map(fix) : undefined,
  })
  return items.map(fix)
}

const EXTRA_MENU: MenuItem[] = [
  // Compras (telas React do DealernetFrontEnd, outra SPA) — abertas via iframe-external.
  // Demonstra o Portal DMS hospedando tela de outro front-end (allowlist: localhost:5173).
  {
    id: 'compras',
    text: 'Compras',
    icon: 'ShoppingCart',
    children: [
      {
        id: 'compras-requisicoes',
        text: 'Requisições (React/IA)',
        icon: 'FileText',
        spec: { title: 'Requisições de Compra', kind: 'iframe-aspx', src: 'http://localhost:5173/?tela=requisicoes&embed=1' },
      },
      {
        id: 'compras-pedidos',
        text: 'Pedidos (React/IA)',
        icon: 'ShoppingCart',
        spec: { title: 'Pedidos de Compra', kind: 'iframe-aspx', src: 'http://localhost:5173/?tela=pedidos&embed=1' },
      },
    ],
  },
  {
    id: 'sis-dwf',
    text: 'Dealernet Workflow',
    icon: 'Boxes',
    children: [
      {
        id: 'dwf-admin',
        text: 'Administração',
        icon: 'Settings',
        children: [
          {
            id: 'dwf-seguranca',
            text: 'Segurança',
            icon: 'ShieldCheck',
            children: [
              { id: 'cad-usuario', text: 'Usuários', icon: 'Users', spec: { title: 'Cadastro de Usuários', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=usuario&embed=1' } },
              { id: 'cad-perfilacesso', text: 'Perfis de Acesso', icon: 'Shield', spec: { title: 'Cadastro de Perfis de Acesso', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=perfilacesso&embed=1' } },
              { id: 'cad-equipe', text: 'Equipes', icon: 'UsersRound', spec: { title: 'Cadastro de Equipes', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=equipe&embed=1' } },
              { id: 'cad-cargo', text: 'Cargos', icon: 'Briefcase', spec: { title: 'Cadastro de Cargos', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=cargo&embed=1' } },
              { id: 'cad-grupoacesso', text: 'Grupos de Acesso', icon: 'ShieldCheck', spec: { title: 'Cadastro de Grupos de Acesso', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=grupoacesso&embed=1' } },
            ],
          },
          {
            id: 'dwf-empresarial',
            text: 'Empresarial',
            icon: 'Building2',
            children: [
              { id: 'cad-empresa', text: 'Empresas', icon: 'Building', spec: { title: 'Cadastro de Empresas', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=empresa&embed=1' } },
              { id: 'cad-grupoempresa', text: 'Grupos de Empresa', icon: 'Network', spec: { title: 'Cadastro de Grupos de Empresa', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=grupoempresa&embed=1' } },
              { id: 'cad-departamento', text: 'Departamentos', icon: 'Building2', spec: { title: 'Cadastro de Departamentos', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=departamento&embed=1' } },
              { id: 'cad-setorservico', text: 'Setores de Serviço', icon: 'Wrench', spec: { title: 'Cadastro de Setores de Serviço', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=setorservico&embed=1' } },
              { id: 'cad-solucaodms', text: 'Soluções DMS', icon: 'Boxes', spec: { title: 'Cadastro de Soluções DMS', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=solucaodms&embed=1' } },
              { id: 'cad-agrupamento', text: 'Agrupamentos', icon: 'Boxes', spec: { title: 'Cadastro de Agrupamentos', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=agrupamento&embed=1' } },
              { id: 'cad-marca', text: 'Marcas', icon: 'Tag', spec: { title: 'Cadastro de Marcas', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=marca&embed=1' } },
              { id: 'cad-tema', text: 'Temas', icon: 'Palette', spec: { title: 'Cadastro de Temas', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=tema&embed=1' } },
              { id: 'cad-depara', text: 'De/Para', icon: 'ArrowLeftRight', spec: { title: 'Cadastro De/Para', kind: 'iframe-aspx', src: 'http://localhost:5175/?tela=depara&embed=1' } },
            ],
          },
          {
            // POC: tela LEGADA EV2 real, embutida via iframe-aspx. Demonstra o portal
            // hospedando tela .aspx do WF. (Sem contexto compartilhado, o WF pode
            // redirecionar ao login — esperado; valida o mecanismo de embutir EV2.)
            id: 'dwf-ev2',
            text: 'Telas Legadas (EV2)',
            icon: 'fas fa-window-restore',
            children: [
              {
                id: 'ev2-feriado',
                text: 'Feriados (EV2)',
                icon: 'fas fa-calendar-day',
                spec: {
                  // Mesma origem (via proxy do Vite → WF na :80) p/ o cookie de sessão
                  // do WF valer no iframe. Em produção: reverse proxy sob o mesmo domínio.
                  title: 'Feriados (EV2)',
                  kind: 'iframe-aspx',
                  src: '/DealerNetWF/wwferiado.aspx',
                  icon: 'fas fa-calendar-day',
                },
              },
            ],
          },
        ],
      },
    ],
  },
]

function parseWsData(json?: string): WorkspaceData {
  try {
    const o = json ? JSON.parse(json) : null
    return { windows: o?.windows ?? [], bookmarks: o?.bookmarks ?? [] }
  } catch {
    return { windows: [], bookmarks: [] }
  }
}

export const portalApiReal = {
  // POST /identity/auth → estabelece sessão (cookie). autenticado=true = OK.
  auth: async (r: LoginRequest): Promise<LoginResponse> => {
    const body = JSON.stringify({
      Usuario_Identificador: r.usuario,
      UsuarioSenha_Senha: r.senha,
      Empresa_Codigo: r.empresaCod ?? 0,
    })
    // O WS de autenticação do ERP tem COLD START (1ª chamada pode estourar o timeout
    // de 30s). Como o 1º timeout não é erro de credencial, tentamos +1 vez (aquecido).
    const tentarAuth = () => req<AuthOutput>('/identity/auth', { method: 'POST', body })
    let out: AuthOutput
    try {
      out = await tentarAuth()
      // Timeout/técnico vindo COMO corpo de negócio → 1 retry antes de desistir.
      if (!out.autenticado && pareceTimeout(out.mensagem)) {
        await new Promise((res) => setTimeout(res, 1500))
        out = await tentarAuth()
      }
    } catch (e) {
      // NetworkError (sem corpo) = serviço indisponível. Tenta +1 vez (cold start).
      if (e instanceof NetworkError) {
        try {
          await new Promise((res) => setTimeout(res, 1500))
          out = await tentarAuth()
        } catch (e2) {
          if (e2 instanceof NetworkError) return { status: 'SERVICE_UNAVAILABLE', mensagem: e2.message }
          throw e2
        }
      } else {
        throw e
      }
    }
    if (!out.autenticado) {
      // Login falhou COM corpo de negócio. Distinguir falha técnica (WF/serviço
      // de autenticação fora) de credencial inválida, pela mensagem do backend.
      if (pareceTimeout(out.mensagem)) {
        return { status: 'SERVICE_UNAVAILABLE', mensagem: out.mensagem }
      }
      return { status: 'INVALID_CREDENTIALS', mensagem: out.mensagem || 'Usuário ou senha inválidos.' }
    }
    return {
      status: 'OK',
      usuario: out.SDT_Usuario?.Usuario_Identificador ?? r.usuario,
      nome: out.SDT_Usuario?.Usuario_Nome ?? out.SDT_Usuario?.Usuario_Identificador ?? r.usuario,
    }
  },

  logout: async (): Promise<{ ok: boolean }> => {
    await req('/identity/logout', { method: 'POST', body: '{}' })
    return { ok: true }
  },

  // Alterar senha ainda não tem endpoint na KB — placeholder até existir.
  alterarSenha: async (): Promise<{ ok: boolean; mensagem?: string }> => {
    return { ok: false, mensagem: 'Alteração de senha indisponível no momento.' }
  },

  getConfig: async (): Promise<PortalConfig> => {
    const out = await req<ConfigOutput>('/config/config')
    const c = out.SDT_PortalConfig ?? {}
    return {
      portalName: c.portalName || 'DIA — Dealernet Intelligence Agents',
      userName: c.userName || '',
      tempoSessao: c.tempoSessao || 10,
      allowedOrigins: [
        ...(c.allowedOrigins || '').split(',').map((s) => s.trim()).filter(Boolean),
        // DEV: libera o DealernetFrontEnd (5173), o DHI Front (5175, cadastros) e o WF EV2 na 80 (POC iframe-aspx).
        ...(import.meta.env.VITE_MOCK_MENU_EXTRA === 'true' ? ['http://localhost:5173', 'http://localhost:5175', 'http://localhost'] : []),
        // Demo via túnel: libera a origem pública do DHI Front (ngrok) p/ o iframe.
        ...(DHI_FRONT_URL && DHI_FRONT_URL !== DHI_FRONT_LOCAL ? [DHI_FRONT_URL] : []),
      ],
      logo: c.logoUrl || undefined,
      endpoints: {
        logout: c.logoutUrl || undefined,
        changeCompany: c.changeCompanyUrl || undefined,
        alteraSenha: c.alteraSenhaUrl || undefined,
      },
    }
  },

  // GET /menu/menus → 1 entrada por produto, cada uma com a árvore pronta (SP) em menuJson.
  getMenu: async (): Promise<MenuItem[]> => {
    // Menu real (SP): rota /menu/list (envelope lean v3; Content = JSON da árvore por
    // produto). Pode vir vazio ([]) enquanto a SP não estiver populada. Resiliente: se
    // falhar, NÃO derruba o menu — o EXTRA_MENU (mockado) ainda é exibido.
    let tree: MenuItem[] = []
    try {
      const out = await req<DhiApiResponse>('/menu/list')
      const raw = parseContent(out) as unknown as PortalMenuItemRaw[]
      tree = buildMenuTree(raw ?? [])
    } catch {
      tree = []
    }
    // DEV: injeta itens de menu ainda não publicados pela SP (telas nativas novas em
    // teste). Liga com VITE_MOCK_MENU_EXTRA=true no .env — sem efeito em produção.
    return import.meta.env.VITE_MOCK_MENU_EXTRA === 'true'
      ? [...reescreverMenuDhi(EXTRA_MENU), ...tree]
      : tree
  },

  // GET /portal/bridge/abrir?tela=<x> → gera token de sessão (TRN Sessao) e devolve a
  // URL da Bridge (/DealerNetWF/bridge.aspx?token=...&tela=...) que abre a tela legada
  // EV2 já AUTENTICADA. Ver design/18-bridge-sso-telas-legadas.
  abrirTelaBridge: async (
    tela: string,
    engine: 'EV2' | 'GX18' = 'EV2',
  ): Promise<{ ok: boolean; url?: string; token?: string; mensagem?: string }> => {
    const out = await req<{ autenticado: boolean; token?: string; url?: string; mensagem?: string }>(
      `/bridge/abrir?tela=${encodeURIComponent(tela)}&engine=${encodeURIComponent(engine)}`,
    )
    if (!out.autenticado || !out.url) {
      return { ok: false, mensagem: out.mensagem || 'Não foi possível gerar a sessão da tela.' }
    }
    // token também é exposto: fronts SPA próprios (ex.: DHI Front) trocam o token
    // por sessão própria via /bridge/validar, em vez de usar a URL aspx da Bridge.
    return { ok: true, url: out.url, token: out.token }
  },

  // GET /identity/me → usa as empresas do usuário (EmpresaItems).
  getEmpresas: async (): Promise<Empresa[]> => {
    const out = await req<MeOutput>('/identity/me')
    const items = out.SDT_Usuario?.Empresa?.EmpresaItems ?? []
    const defaultCod = out.SDT_Usuario?.Usuario_EmpresaCodDefault
    return items.map((e) => ({
      id: String(e.UsuarioEmp_EmpresaCod),
      nome: e.UsuarioEmp_EmpresaNomFantasia,
      grupo: e.UsuarioEmp_EmpresaMarcaSgl || undefined,
      ativa: e.UsuarioEmp_EmpresaCod === defaultCod,
    }))
  },

  setEmpresa: async (id: string): Promise<{ ok: boolean }> => {
    // Endpoint de troca de empresa (/empresa/atual) ainda não gerado — placeholder.
    return { ok: !!id }
  },

  // GET /tema/list?Codigo=0&Filtros={Filtros:[{Campo:'Marca',Valor:<cod>}]} → temas ATIVOS da marca.
  // Cada tema tem CorPrimaria (hex) que pinta o portal. Usado pelo seletor de tema por marca.
  // marcaCod opcional: se informado, filtra por marca; senão lista todos os ativos (admin/fallback).
  getTemas: async (marcaCod?: number): Promise<TemaPortal[]> => {
    const filtros = marcaCod
      ? { Page: 1, Size: 100, Filtros: [{ Campo: 'Marca', Valor: String(marcaCod) }] }
      : { Page: 1, Size: 100, Filtros: [] as { Campo: string; Valor: string }[] }
    const f = encodeURIComponent(JSON.stringify(filtros))
    const out = await req<DhiApiResponse>(`/tema/list?Codigo=0&Filtros=${f}`)
    if (statusNum(out) >= 400) return []
    return parseContent(out)
      .map((r) => ({
        codigo: Number(r.Codigo) || 0,
        descricao: String(r.Descricao ?? ''),
        corPrimaria: String(r.CorPrimaria ?? '').trim(),
        posicao: Number(r.PosicaoMenu) || 0,
      }))
      .filter((t) => /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t.corPrimaria))
      .sort((a, b) => a.posicao - b.posicao)
  },

  // GET /workspace/list → SDT_Workspace[] (com src = Json embutido).
  getWorkspaces: async (): Promise<WorkspaceMeta[]> => {
    const out = await req<ListOutput>('/workspace/list')
    return (out.SDT_Workspace ?? []).map((w) => ({ id: String(w.id ?? ''), name: w.text ?? '' }))
  },

  // GET /workspace/get?Workspace_Codigo=
  getWorkspace: async (id: string): Promise<Workspace | null> => {
    const out = await req<GetOutput>(`/workspace/get?Workspace_Codigo=${encodeURIComponent(id)}`)
    if (!out.encontrado) return null
    return { id, name: '', data: parseWsData(out.Json) }
  },

  // POST /workspace/save (INS: Workspace_Codigo 0) → devolve Workspace_CodigoOut.
  createWorkspace: async (name: string, data: WorkspaceData): Promise<WorkspaceMeta> => {
    const out = await req<SaveOutput>('/workspace/save', {
      method: 'POST',
      body: JSON.stringify({ Workspace_Codigo: 0, Workspace_Nome: name, Workspace_Json: JSON.stringify(data) }),
    })
    return { id: String(out.Workspace_CodigoOut ?? ''), name }
  },

  // POST /workspace/save (UPD: Workspace_Codigo informado).
  saveWorkspace: async (id: string, name: string, data: WorkspaceData): Promise<{ ok: boolean }> => {
    const out = await req<SaveOutput>('/workspace/save', {
      method: 'POST',
      body: JSON.stringify({ Workspace_Codigo: Number(id), Workspace_Nome: name, Workspace_Json: JSON.stringify(data) }),
    })
    return { ok: out.ok }
  },

  // DELETE /workspace/delete?Workspace_Codigo=
  deleteWorkspace: async (id: string): Promise<{ ok: boolean }> => {
    const out = await req<DeleteOutput>(`/workspace/delete?Workspace_Codigo=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    return { ok: out.ok }
  },

  // CRUDs de cadastro (Cargo, Departamento, GrupoEmpresa, PerfilAcesso, Empresa, Equipe,
  // SetorServico, Usuario).
  cadastros: cadastrosReal,

  // SolucaoDMS — CRUD sob medida (PK char).
  solucaoDMS: solucaoDMSReal,

  // Vínculos Usuário×Empresa (aba Empresas do CadastroUsuario) — list por usuário + upsert + delete físico.
  usuarioEmpresa: usuarioEmpresaReal,

  // Vínculos Usuário×PerfilAcesso (aba Perfis do CadastroUsuario) — list por usuário + upsert + delete físico.
  usuarioPerfil: usuarioPerfilReal,

  // Vínculos Usuário×GrupoAcesso (aba Grupos do CadastroUsuario) — list por usuário + upsert + delete físico.
  usuarioGrupo: usuarioGrupoReal,

  // Senha provisória do usuário (aba Senha do CadastroUsuario).
  setSenhaUsuario: setSenhaReal,

  // Opções de um domínio enum da KB (combos/badges dinâmicos).
  buscarDominio: buscarDominioReal,

  // Busca server-side de Pessoa (typeahead — tabela grande).
  buscarPessoa: buscarPessoaReal,
}
