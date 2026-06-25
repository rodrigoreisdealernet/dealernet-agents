// Contratos do DataTable corporativo (spec: DealernetCRM/docs/design/11-padrao-grid-filtros.md).
// O núcleo NÃO importa nada de src/portal/lib — fonte de dados é injetada (extração futura p/ DS).

export type ColTipo = 'texto' | 'numero' | 'codigo' | 'badge' | 'data' | 'bool'

export interface EnumOption {
  value: string
  label: string
}

/** Definição de coluna. `serverParam` presente = filtro vai ao servidor quando o BFF v2 estiver ativo. */
export interface DnColumn<T> {
  key: keyof T & string
  label: string
  tipo: ColTipo
  /** default true */
  filtravel?: boolean
  /** default true */
  ordenavel?: boolean
  /** default true */
  visivelDefault?: boolean
  /** opções p/ tipo 'badge' (filtro multi-select `in`) */
  enumOptions?: EnumOption[]
  width?: string
  /** Nome do query param tipado no BFF v2 (ex.: 'FiltroAtivo'). */
  serverParam?: string
}

/** Estado persistível do grid (espelha spec §5.3; URL-sync omitido — MDI sem rota própria). */
export interface GridState {
  v: 1
  sort?: string // "descricao:desc"
  page: number
  size: number
  /** { coluna: "op:valor" } — ex.: { descricao: "contains:vendas", ativo: "eq:true" } */
  filters: Record<string, string>
  busca?: string
  columns: { order: string[]; hidden: string[] }
}

export function emptyGridState(): GridState {
  return { v: 1, page: 1, size: 50, filters: {}, columns: { order: [], hidden: [] } }
}

/** Query enviada à fonte de dados (o adapter traduz p/ parms tipados do GX). */
export interface ListQuery {
  page: number
  size: number
  sort?: string
  busca?: string
  filters?: Record<string, string>
}

/** Resultado da fonte. `total` undefined = backend legado (sem paginação) → modo client. */
export interface ListResult<T> {
  data: T[]
  total?: number
}

export interface CrudListApi<T> {
  list(q?: ListQuery): Promise<ListResult<T>>
}

/** Persistência do GridState — injetada (o núcleo do DataTable não conhece a camada de API). */
export interface GridStorage {
  load(key: string): Promise<GridState | null>
  save(key: string, state: GridState): void
}

/** Parse de um filtro "op:valor" → { op, valor }. */
export function parseFilter(raw: string): { op: string; valor: string } {
  const i = raw.indexOf(':')
  if (i < 0) return { op: 'eq', valor: raw }
  return { op: raw.slice(0, i), valor: raw.slice(i + 1) }
}
