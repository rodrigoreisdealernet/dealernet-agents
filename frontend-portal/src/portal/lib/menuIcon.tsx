// Resolve o ícone de uma tela a partir da classe que vem do menu (Menu_ClasseIcone,
// ex.: "menu-icon fas fa-users"). O backend manda Font Awesome; aqui mapeamos os nomes
// mais comuns para lucide-react (já usado no portal). Não-mapeados caem num fallback —
// assim toda aba/tela tem UM ícone, e o texto diferencia o resto.

import {
  AppWindow,
  ArrowLeftRight,
  BarChart3,
  Bell,
  Boxes,
  Briefcase,
  Building2,
  Calendar,
  Car,
  ChartPie,
  CheckCircle,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Cog,
  CreditCard,
  Database,
  DollarSign,
  FileText,
  Folder,
  Gauge,
  Home,
  Lightbulb,
  ListChecks,
  Mail,
  MapPin,
  Megaphone,
  MessageSquare,
  Package,
  Palette,
  Settings,
  Shield,
  ShoppingCart,
  Tag,
  Target,
  Truck,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'

// FA (sem o prefixo "fa-") → lucide. Cobrem os ícones mais frequentes da tabela Menu.
const FA_TO_LUCIDE: Record<string, LucideIcon> = {
  home: Home,
  tasks: ListChecks,
  'calendar-check': Calendar,
  'calendar-day': Calendar,
  compass: MapPin,
  lightbulb: Lightbulb,
  bolt: Zap,
  briefcase: Briefcase,
  bullhorn: Megaphone,
  bullseye: Target,
  car: Car,
  'car-side': Car,
  'chart-line': BarChart3,
  'chart-pie': ChartPie,
  'check-circle': CheckCircle,
  'check-square': CheckSquare,
  'clipboard-check': ClipboardCheck,
  'clipboard-list': ClipboardList,
  cogs: Cog,
  cog: Settings,
  comments: MessageSquare,
  'credit-card': CreditCard,
  database: Database,
  'dollar-sign': DollarSign,
  'shopping-cart': ShoppingCart,
  'envelope-open-text': Mail,
  envelope: Mail,
  users: Users,
  user: Users,
  building: Building2,
  warehouse: Package,
  boxes: Boxes,
  box: Package,
  tools: Wrench,
  wrench: Wrench,
  shield: Shield,
  bell: Bell,
  clock: Clock,
  gauge: Gauge,
  tachometer: Gauge,
  'file-alt': FileText,
  file: FileText,
  folder: Folder,
  truck: Truck,
  tag: Tag,
}

/**
 * Extrai o nome FA de uma string de classe e devolve o componente lucide.
 * Aceita também nomes lucide diretos (ex.: "Users") por compatibilidade com o
 * mock e telas nativas. Fallback = AppWindow (genérico de tela).
 */
export function resolveMenuIcon(raw?: string): LucideIcon {
  if (!raw) return AppWindow
  // FA: pega o token "fa-xxxx" e usa "xxxx".
  const fa = raw.match(/fa-([a-z0-9-]+)/i)
  if (fa) {
    return FA_TO_LUCIDE[fa[1].toLowerCase()] ?? AppWindow
  }
  // Nome lucide direto (mock/telas nativas e EXTRA_MENU do real). Cobre os nomes que
  // os menus enviam como ícone lucide (não-FA); o resto cai no fallback AppWindow.
  const direct: Record<string, LucideIcon> = {
    Users, BarChart3, Boxes, Home, Database, Building2,
    ShoppingCart, FileText, Tag, Palette, ArrowLeftRight,
    Settings, Shield, Briefcase, Wrench, Car, Package, Gauge,
  }
  return direct[raw] ?? AppWindow
}

/** Componente pronto: <MenuIcon name="fas fa-users" size={14} /> */
export function MenuIcon({ name, size = 14, className, style }: {
  name?: string
  size?: number
  className?: string
  style?: React.CSSProperties
}) {
  const Icon = resolveMenuIcon(name)
  return <Icon size={size} className={className} style={style} />
}
