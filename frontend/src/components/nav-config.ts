import type { ComponentType } from 'react';
import {
  Home,
  BookOpen,
  ShoppingCart,
  Smartphone,
  Truck,
  ClipboardList,
  ScrollText,
  CreditCard,
  Undo2,
  Calculator,
  SearchCheck,
  CalendarDays,
  LayoutDashboard,
  Map,
  ChartColumnIncreasing,
  Building2,
  Factory,
  Bot,
  Sparkles,
  FolderOpen,
  Package,
  UsersRound,
  UserCircle,
  ClipboardCheck,
  FileText,
  FileSignature,
  Repeat,
  ShieldCheck,
  Wrench,
  Archive,
  ArrowLeftRight,
  ClipboardPen,
  Briefcase,
  SquareKanban,
  BarChart3,
} from 'lucide-react';

export interface NavVisibilityContext {
  canWrite: boolean;
  showGeneralLedger: boolean;
  showAccountingExportConfig: boolean;
}

interface NavMatchContext {
  pathname: string;
  searchParams: URLSearchParams;
}

export interface NavItemConfig {
  to: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  search?: Record<string, string>;
  show?: (context: NavVisibilityContext) => boolean;
  isActive?: (context: NavMatchContext) => boolean;
}

export interface NavSectionConfig {
  label?: string;
  items: NavItemConfig[];
}

const startsWith = (prefix: string) => ({ pathname }: NavMatchContext) => pathname.startsWith(prefix);
const findingsWorkflow = (workflow: string) => ({ pathname, searchParams }: NavMatchContext) =>
  pathname.startsWith('/ops/findings') && searchParams.get('workflow') === workflow;
const findingsHistory = ({ pathname, searchParams }: NavMatchContext) =>
  pathname === '/ops/findings' && !searchParams.get('workflow');

export const NAV_SECTIONS: NavSectionConfig[] = [
  {
    items: [
      { to: '/', icon: Home, label: 'Dashboard' },
      { to: '/rental/catalog', icon: BookOpen, label: 'Equipment Catalog' },
      { to: '/storefront/cart', icon: ShoppingCart, label: 'Rental Cart' },
      { to: '/field/mobile', icon: Smartphone, label: 'Field Workflows', isActive: ({ pathname }) => pathname.startsWith('/field/mobile') },
      { to: '/field/counts', icon: ClipboardCheck, label: 'RapidCount Capture', isActive: ({ pathname }) => pathname.startsWith('/field/counts') },
      { to: '/field/dispatch', icon: Truck, label: 'Driver Dispatch', isActive: ({ pathname }) => pathname.startsWith('/field/dispatch') },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/rental/orders', icon: ClipboardList, label: 'Order Intake', isActive: startsWith('/rental/orders') },
      { to: '/rental/contracts', icon: ScrollText, label: 'Contract Mgmt', isActive: startsWith('/rental/contracts') },
      { to: '/rental/counter-review', icon: ClipboardList, label: 'Counter Review', isActive: startsWith('/rental/counter-review') },
      { to: '/rental/portal-financials', icon: CreditCard, label: 'Portal Billing' },
      {
        to: '/accounting/general-ledger',
        icon: ScrollText,
        label: 'General Ledger',
        show: ({ showGeneralLedger }) => showGeneralLedger,
        isActive: startsWith('/accounting/general-ledger'),
      },
      {
        to: '/accounting/export-config',
        icon: FileText,
        label: 'Export Configuration',
        show: ({ showAccountingExportConfig }) => showAccountingExportConfig,
        isActive: startsWith('/accounting/export-config'),
      },
      { to: '/rental/returns', icon: Undo2, label: 'Returns / Check-In' },
      { to: '/rental/inspection-comparison', icon: ArrowLeftRight, label: 'Inspection Compare', isActive: startsWith('/rental/inspection-comparison') },
      {
        to: '/rental/quoting',
        icon: Calculator,
        label: 'Quote Builder',
        show: ({ canWrite }) => canWrite,
      },
      {
        to: '/rental/project-proposal',
        icon: Briefcase,
        label: 'Project Proposal',
        show: ({ canWrite }) => canWrite,
      },
      { to: '/rental/availability', icon: SearchCheck, label: 'Branch Availability' },
      { to: '/inventory/calendar', icon: CalendarDays, label: 'Fleet Calendar' },
      { to: '/inventory/items', icon: Archive, label: 'Stock Items' },
      { to: '/inventory/kits', icon: Package, label: 'Kits & Bundles' },
      { to: '/branch/ops', icon: LayoutDashboard, label: 'Branch Operations' },
      { to: '/branch/monthly-pack', icon: FileText, label: 'Monthly Branch Pack', isActive: startsWith('/branch/monthly-pack') },
      { to: '/executive/monthly-operating-pack', icon: Building2, label: 'Executive Operating Pack', isActive: startsWith('/executive/monthly-operating-pack') },
      { to: '/branch/counts', icon: ClipboardCheck, label: 'RapidCount' },
      { to: '/dispatch/live', icon: Map, label: 'Dispatch Live Ops' },
      { to: '/dispatch/predispatch', icon: ClipboardList, label: 'Predispatch Staging' },
      { to: '/dispatch/yard', icon: SquareKanban, label: 'Live Yard View' },
      { to: '/analytics/fleet', icon: ChartColumnIncreasing, label: 'Fleet Reporting' },
      { to: '/analytics/transport', icon: Truck, label: 'Transport Control Pack', isActive: ({ pathname }) => pathname.startsWith('/analytics/transport') },
      { to: '/analytics/enterprise-financials', icon: Building2, label: 'Enterprise Financials' },
      { to: '/analytics/ai-reporting', icon: BarChart3, label: 'AI Reporting', isActive: ({ pathname }) => pathname.startsWith('/analytics/ai-reporting') },
      { to: '/analytics/tax-filings', icon: ScrollText, label: 'Sales Tax Filing' },
      { to: '/analytics/dashboards', icon: LayoutDashboard, label: 'Dashboard Builder', isActive: ({ pathname }) => pathname.startsWith('/analytics/dashboards') },
    ],
  },
  {
    label: 'Agentic Operations',
    items: [
      { to: '/ops', icon: Factory, label: 'Operations Dashboard' },
      { to: '/ops/revenue-recognition', icon: BookOpen, label: 'Revenue Recognition' },
      {
        to: '/ops/findings',
        search: { workflow: 'quote-to-order-copilot' },
        icon: Bot,
        label: 'Quote Drafts',
        isActive: findingsWorkflow('quote-to-order-copilot'),
      },
      {
        to: '/ops/findings',
        search: { workflow: 'damage-returns-charge-assistant' },
        icon: Sparkles,
        label: 'Damage Charge Review',
        isActive: findingsWorkflow('damage-returns-charge-assistant'),
      },
      { to: '/ops/fleet-audits', icon: SearchCheck, label: 'Fleet Audits' },
      { to: '/ops/fleet-rebalancing', icon: Repeat, label: 'Fleet Rebalancing' },
      { to: '/ops/incident-compliance-queue', icon: ShieldCheck, label: 'Incident Compliance Queue', isActive: startsWith('/ops/incident-compliance-queue') },
      { to: '/ops/shop-morning-queue', icon: ClipboardPen, label: 'Shop Morning Queue', isActive: startsWith('/ops/shop-morning-queue') },
      { to: '/ops/technician-morning-queue', icon: Wrench, label: 'Technician Morning Queue', isActive: startsWith('/ops/technician-morning-queue') },
      { to: '/ops/billing-updates', icon: CreditCard, label: 'Billing Update Queue', isActive: startsWith('/ops/billing-updates') },
      { to: '/ops/transfers', icon: Truck, label: 'Transfer Management', isActive: startsWith('/ops/transfers') },
      { to: '/ops/compliance-readiness-queue', icon: ShieldCheck, label: 'Compliance Readiness', isActive: startsWith('/ops/compliance-readiness-queue') },
      { to: '/ops/findings', icon: ScrollText, label: 'Audit History', isActive: findingsHistory },
    ],
  },
  {
    label: 'Enterprise',
    items: [{ to: '/enterprise/org-hierarchy', icon: Building2, label: 'Org Hierarchy' }],
  },
  {
    label: 'Fleet & Customers',
    items: [
      { to: '/entities/asset', icon: Package, label: 'Assets', isActive: startsWith('/entities/asset') },
      { to: '/entities/asset_category', icon: FolderOpen, label: 'Asset Categories', isActive: startsWith('/entities/asset_category') },
      { to: '/entities/branch', icon: Building2, label: 'Branches', isActive: startsWith('/entities/branch') },
      { to: '/entities/customer', icon: UsersRound, label: 'Customers', isActive: startsWith('/entities/customer') },
      { to: '/entities/contact', icon: UserCircle, label: 'Contacts', isActive: startsWith('/entities/contact') },
      { to: '/entities/job_site', icon: ClipboardCheck, label: 'Job Sites', isActive: startsWith('/entities/job_site') },
      { to: '/entities/billing_account', icon: FileText, label: 'Billing Accounts', isActive: startsWith('/entities/billing_account') },
    ],
  },
  {
    label: 'CRM',
    items: [
      { to: '/crm/customers', icon: UsersRound, label: 'Customer Profiles', isActive: startsWith('/crm/customers') },
    ],
  },
  {
    label: 'Records',
    items: [
      { to: '/entities/rental_order', icon: ClipboardList, label: 'Rental Orders', isActive: startsWith('/entities/rental_order') },
      { to: '/entities/rental_contract', icon: FileSignature, label: 'Contracts', isActive: startsWith('/entities/rental_contract') },
      { to: '/entities/rental_contract_line', icon: Repeat, label: 'Checkouts & Returns', isActive: startsWith('/entities/rental_contract_line') },
      { to: '/entities/invoice', icon: FileText, label: 'Invoices', isActive: startsWith('/entities/invoice') },
      { to: '/entities/transfer', icon: Truck, label: 'Transfers', isActive: startsWith('/entities/transfer') },
      { to: '/entities/inspection', icon: ShieldCheck, label: 'Inspections', isActive: startsWith('/entities/inspection') },
      { to: '/entities/maintenance_record', icon: Wrench, label: 'Maintenance', isActive: startsWith('/entities/maintenance_record') },
    ],
  },
];
