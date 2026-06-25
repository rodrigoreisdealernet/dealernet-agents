// Tipos centrais do Portal MDI. Ver docs/portal-mdi-arquitetura.md §7.

export type WindowKind = 'iframe-aspx' | 'iframe-external' | 'component'

/** Estado completo de uma janela aberta no MDI. Serializável -> vira workspace. */
export interface PortalWindow {
  id: string
  title: string
  titleKey?: string
  kind: WindowKind
  /** Nome do ícone da tela (vindo do menu, ex. Font Awesome "fas fa-users"). */
  icon?: string
  /** URL embutida (kind iframe-*). Relativa ao ERP ou allowlisted. */
  src?: string
  /** Chave da tela nativa (kind component) -> resolvida no registry. */
  componentKey?: string
  /** Parâmetros da tela nativa (POC: { findingId } | { agentKey } | { entityId }). */
  params?: Record<string, unknown>
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  minimized: boolean
  zIndex: number
  /** Geometria anterior à maximização, para restaurar ao tamanho/posição certos. */
  prevRect?: { x: number; y: number; width: number; height: number }
}

/** Especificação para abrir uma janela (posição/tamanho/z são preenchidos pelo store). */
export interface WindowSpec {
  title: string
  titleKey?: string
  kind: WindowKind
  /** Nome do ícone da tela (do menu); herdado pela janela/aba. */
  icon?: string
  src?: string
  componentKey?: string
  /** Parâmetros passados à tela nativa (POC: findingId/agentKey/entityId). */
  params?: Record<string, unknown>
  width?: number
  height?: number
}

export interface Bookmark {
  text: string
  textKey?: string
  spec: WindowSpec
}

export interface MenuItem {
  id: string
  text: string
  labelKey?: string
  icon?: string
  spec?: WindowSpec
  children?: MenuItem[]
  /** Role mínima (app_role) exigida para ver o item; ausente = visível a todos. */
  requiredRole?: string
}

export interface WorkspaceMeta {
  id: string
  name: string
}

/** Conteúdo serializável de um workspace (janelas + favoritos). Compatível com o
 *  JSON do W5Portal antigo: { windows: [...], bookmarks: [...] }. */
export interface WorkspaceData {
  windows: PortalWindow[]
  bookmarks: Bookmark[]
}

export interface Workspace extends WorkspaceMeta {
  data: WorkspaceData
}

// Autenticação (contrato do API_Portal_Auth: POST /auth → cookie de sessão).
export interface LoginRequest {
  usuario: string
  senha: string
  empresaCod?: number
}

/**
 * Resposta do /auth.
 * - 'OK' = logado (cookie emitido)
 * - '2FA_REQUIRED' = pede 2º fator
 * - 'INVALID_CREDENTIALS' = usuário/senha errados
 * - 'SERVICE_UNAVAILABLE' = serviço de login/WF indisponível (não é erro de credencial)
 */
export interface LoginResponse {
  status: 'OK' | '2FA_REQUIRED' | 'INVALID_CREDENTIALS' | 'SERVICE_UNAVAILABLE'
  /** Identificador do usuário (eco) para exibir; a sessão real é o cookie HttpOnly. */
  usuario?: string
  nome?: string
  challengeId?: string
  mensagem?: string
}

// Cargo (cadastro) — contrato do API_Portal_Cargo (CRUD BFF na KB DHI).
// Espelha SDT_PortalCargo.Item: Codigo (int), Descricao (string), Ativo (bool).
export interface Cargo {
  codigo: number
  descricao: string
  ativo: boolean
}

// GrupoAcesso (cadastro) — contrato do API_Portal_GrupoAcesso (CRUD BFF na KB DHI).
// Espelha SDT_PortalGrupoAcesso.Item: Codigo (int), Descricao (string), Observacao (string), Ativo (bool).
export interface GrupoAcesso {
  codigo: number
  descricao: string
  observacao: string
  ativo: boolean
}

// Cadastros CRUD — contratos dos API_Portal_* (BFF na KB DHI), espelham os SDTs publicados.
export interface Departamento {
  codigo: number
  descricao: string
  ativo: boolean
}

export interface GrupoEmpresa {
  codigo: number
  nome: string
  metodoAutenticacao: string
  validaGrupoFinanceiro: boolean
  dealerNet: boolean
  googleAnalytics: string
  googleAds: string
  reCaptchaSiteKey: string
  reCaptchaSecretKey: string
  ativo: boolean
}

export interface PerfilAcesso {
  codigo: number
  descricao: string
  tipo: string
  prioridade: number
  permiteSMS: string
  diasPrevisaoEntrega: number
  diasLimiteCredito: number
  ativo: boolean
}

/** Cadastro de Empresa (CRUD). Distinto de `Empresa` (item do seletor de empresa da sessão). */
export interface EmpresaCadastro {
  codigo: number
  nome: string
  nomeFantasia: string
  docIdentificador: string
  grupoEmpresaCod: number
  grupoEmpresaNome: string
  regimeTributaria: string
  segmento: string
  centroDistribuicao: boolean
  dealerNet: boolean
  urlImagem: string
  pessoaCod: number
  pessoaNom: string
  ativo: boolean
}

// Solução DMS (catálogo de soluções/sistemas) — espelha SDT_PortalSolucaoDMS.
// PK é char (TipoProduto = enum PacoteProduto) → tela sob medida (não usa o CRUD genérico).
export interface SolucaoDMS {
  tipoProduto: string
  nome: string
  urlBase: string
  urlBaseSpa: string
  classeIcone: string
  sequencia: number
  ativo: boolean
}

// Catálogos para combos (espelham SDT_PortalEquipe / SDT_PortalSetorServico).
export interface Equipe {
  codigo: number
  descricao: string
  cor: string
  ativoAgendamento: boolean
  ativo: boolean
}

export interface SetorServico {
  codigo: number
  descricao: string
  tipo: string
  ativo: boolean
}

// Usuário (cadastro completo) — espelha SDT_PortalUsuario (16 campos). FKs (empresaCodDefault,
// equipe, cargo, setorServico) viram combo na tela; tipoAcesso é enum fixo (SI/WS/FO).
export interface Usuario {
  codigo: number
  nome: string
  identificador: string
  identificadorAlternativo: string
  email: string
  tipoAcesso: string
  empresaCodDefault: number
  equipe: number
  equipeDescricao: string
  cargo: number
  cargoDescricao: string
  setorServico: number
  setorServicoDescricao: string
  pessoaCod: number
  pessoaNom: string
  pessoaDoc: string
  administrador: boolean
  dataAdmissao: string
  dataDemissao: string
  diasExpiracaoSenha: number
  autenticaLocal: boolean
  ativo: boolean
}

// Vínculo Usuário×Empresa (N:N) — espelha SDT_PortalUsuarioEmpresa (PK composta
// Usuario_Codigo + UsuarioEmp_EmpresaCod). Campos da Empresa (nome/marca/ativo) são
// read-only (inferidos pela TRN); flags Tarefa/Agendamento são editáveis por linha.
export interface UsuarioEmpresa {
  usuarioCodigo: number
  empresaCod: number
  empresaNomFantasia: string
  empresaNom: string
  empresaMarcaSgl: string
  empresaAtivo: boolean
  tarefa: boolean
  permiteAgendamento: boolean
  permiteAgendamentoOnline: boolean
}

// Vínculo Usuário×PerfilAcesso (N:N) — espelha SDT_PortalUsuarioPerfil (PK composta
// Usuario_Codigo + PerfilAcesso_Codigo). Descrição/tipo do perfil são read-only
// (inferidos pela TRN). Remoção é física (vínculo N:N sem histórico de inativo).
export interface UsuarioPerfilAcesso {
  usuarioCodigo: number
  perfilCod: number
  perfilDescricao: string
  perfilTipo: string
  ativo: boolean
}

// Vínculo Usuário×GrupoAcesso (N:N) — espelha SDT_PortalUsuarioGrupo (PK composta
// Usuario_Codigo + GrupoAcesso_Codigo). Descrição do grupo é read-only (inferida pela
// TRN). Remoção é física (vínculo N:N sem histórico de inativo). Sem "tipo" (≠ Perfil).
export interface UsuarioGrupoAcesso {
  usuarioCodigo: number
  grupoCod: number
  grupoDescricao: string
  ativo: boolean
}

// ---- Combos (FK/enum) — usados pelo ComboField nas telas de cadastro ----
export interface ComboOption {
  value: string
  label: string
}

/** Fonte de um combo: carrega opções (cacheável por cacheKey) e indica se tem busca/typeahead. */
export interface ComboSource {
  cacheKey: string
  load: () => Promise<ComboOption[]>
  searchable?: boolean
  /** Busca SERVER-SIDE por termo (tabela grande, ex. Pessoa). Quando presente, o typeahead
   * consulta isto a cada digitação (debounce) em vez de filtrar as opções carregadas no client. */
  searchFn?: (termo: string) => Promise<ComboOption[]>
}

// Empresa (lista vem de GET /api/v1/portal/empresas — endpoint dedicado v2).
export interface Empresa {
  id: string
  nome: string
  /** Grupo opcional (ex.: GM, DEALERNET) para o submenu hierárquico do seletor. */
  grupo?: string
  /** Marca true na empresa atualmente ativa. */
  ativa?: boolean
}

// PortalConfig = SDT_Config v2 (contrato REST limpo, a ser criado na KB GeneXus).
// Substitui o SDT_Config legado servido por aprc_wsconfig.aspx. Mantém só o que
// o portal novo usa; o resto (mostViewed, languages legadas, etc.) foi descartado.
export interface PortalConfig {
  portalName: string
  logo?: string
  /** Origins permitidos para iframes (frame-src) e validação de postMessage. */
  allowedOrigins: string[]
  userName: string
  /** Timeout de sessão por inatividade, em MINUTOS (era application.tempoSessao). */
  tempoSessao: number
  /** URLs de ação (era SDT_Config.webservices). */
  endpoints: {
    /** Destino ao expirar a sessão / logout explícito (era webservices.logout). */
    logout?: string
    /** Troca de empresa (era webservices.changeCompany). */
    changeCompany?: string
    /** Alterar senha (era webservices.alteraSenha). */
    alteraSenha?: string
  }
}

/** Tema de cor por marca (vindo de GET /tema/list). corPrimaria pinta o portal. */
export interface TemaPortal {
  codigo: number
  descricao: string
  corPrimaria: string
  posicao: number
}
