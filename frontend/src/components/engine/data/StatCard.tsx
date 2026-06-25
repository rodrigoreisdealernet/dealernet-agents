import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { EngineComponentProps, EngineTone } from '@/engine/types';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Building2,
  CalendarDays,
  ChartColumnIncreasing,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Factory,
  Package,
  SearchCheck,
  Sparkles,
  Truck,
  Undo2,
  UsersRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

type DeltaDirection = 'up' | 'down' | 'flat';

interface StatCardProps extends EngineComponentProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: string;
  tone?: Exclude<EngineTone, 'neutral'>;
  delta?: {
    direction: DeltaDirection;
    label: string;
  };
  to?: string;
  linkLabel?: string;
  className?: string;
}

const TONE_CLASSES: Record<Exclude<EngineTone, 'neutral'>, string> = {
  default: 'bg-slate-100 text-slate-700',
  success: 'bg-green-50 text-green-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
  info: 'bg-blue-50 text-blue-700',
};

const DELTA_CLASSES: Record<DeltaDirection, string> = {
  up: 'bg-green-50 text-green-700',
  down: 'bg-red-50 text-red-700',
  flat: 'bg-slate-100 text-slate-700',
};

const DELTA_PREFIX: Record<DeltaDirection, string> = {
  up: '▲',
  down: '▼',
  flat: '—',
};

/**
 * Curated icon map — a deliberate allowlist instead of `import * as LucideIcons`
 * so the bundler tree-shakes the rest of the lucide set (~600KB) out of the build.
 * Keys accept both the PascalCase export name and the kebab-case lucide id.
 * Extend this map when a page definition needs a new icon.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  AlertCircle,
  AlertTriangle,
  Bot,
  Building2,
  CalendarDays,
  ChartColumnIncreasing,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Factory,
  Package,
  SearchCheck,
  Sparkles,
  Truck,
  Undo2,
  UsersRound,
  Wrench,
};

function toPascalCase(name: string): string {
  return name
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
}

function resolveLucideIcon(icon: string | undefined): LucideIcon | null {
  if (!icon) return null;
  return ICON_MAP[icon] ?? ICON_MAP[toPascalCase(icon)] ?? null;
}

function StatCardBody({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  delta,
  to,
  linkLabel,
  className,
}: StatCardProps) {
  const Icon = resolveLucideIcon(icon);

  return (
    <Card
      className={cn(
        'border-border shadow-[0_1px_2px_rgba(10,42,43,0.06)]',
        to
          && 'transition-shadow duration-150 hover:border-primary/30 hover:shadow-[0_4px_12px_rgba(10,42,43,0.10)]',
        className
      )}
    >
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="text-3xl font-semibold tabular-nums">{value}</p>
            {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
          </div>
          {Icon && (
            <span
              className={cn(
                'inline-flex h-10 w-10 items-center justify-center rounded-full',
                TONE_CLASSES[tone]
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
          )}
        </div>
        {delta && (
          <div
            className={cn(
              'mt-4 inline-flex items-center rounded-full px-2 py-1 text-xs font-medium',
              DELTA_CLASSES[delta.direction]
            )}
          >
            <span aria-hidden="true">{DELTA_PREFIX[delta.direction]}</span>
            <span className="ml-1">{delta.label}</span>
          </div>
        )}
      </CardContent>
      {to && linkLabel && (
        <CardFooter className="p-6 pt-0">
          <span className="text-sm font-medium text-primary hover:underline">
            {linkLabel} →
          </span>
        </CardFooter>
      )}
    </Card>
  );
}

export function StatCard(props: StatCardProps) {
  if (props.to) {
    return (
      <Link to={props.to} className="block rounded-lg">
        <StatCardBody {...props} />
      </Link>
    );
  }

  return <StatCardBody {...props} />;
}
