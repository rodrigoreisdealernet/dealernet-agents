/**
 * Badge Component - Status badges
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { EngineComponentProps, EngineTone } from '@/engine/types';

interface EngineBadgeProps extends EngineComponentProps {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline';
  status?: string;
  className?: string;
}

const STATUS_TONE_MAP: Record<string, EngineTone> = {
  available: 'success',
  active: 'success',
  approved: 'success',
  completed: 'success',
  returned: 'success',
  on_rent: 'info',
  in_transit: 'info',
  open: 'info',
  awarded: 'info',
  dispatched: 'info',
  scheduled: 'info',
  in_progress: 'info',
  maintenance: 'warning',
  triage: 'warning',
  awaiting_parts: 'warning',
  pending: 'warning',
  pending_approval: 'warning',
  'draft-review': 'warning',
  requested: 'warning',
  return_in_transit: 'warning',
  overdue: 'danger',
  failed: 'danger',
  cancelled: 'danger',
  rejected: 'danger',
  draft: 'neutral',
  closed: 'neutral',
};

const TONE_CLASSES: Record<EngineTone, string> = {
  default: 'border-border bg-muted text-muted-foreground',
  success: 'border-transparent bg-green-50 text-green-800',
  warning: 'border-transparent bg-amber-50 text-amber-800',
  danger: 'border-transparent bg-red-50 text-red-800',
  info: 'border-transparent bg-blue-50 text-blue-800',
  neutral: 'border-transparent bg-slate-100 text-slate-800',
};

export function mapStatusToTone(status: string | undefined): EngineTone {
  if (!status) return 'neutral';
  return STATUS_TONE_MAP[status.trim().toLowerCase()] ?? 'neutral';
}

export function EngineBadge({
  variant = 'default',
  status,
  className,
  children,
}: EngineBadgeProps) {
  if (status) {
    const tone = mapStatusToTone(status);
    return (
      <Badge className={cn('rounded-full font-medium', TONE_CLASSES[tone], className)}>
        {children}
      </Badge>
    );
  }

  return (
    <Badge variant={variant} className={cn(className)}>
      {children}
    </Badge>
  );
}
