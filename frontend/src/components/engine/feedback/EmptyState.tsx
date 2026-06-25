import { Link } from '@tanstack/react-router';
import * as LucideIcons from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EngineComponentProps } from '@/engine/types';

interface EmptyStateProps extends EngineComponentProps {
  icon?: string;
  title: string;
  hint?: string;
  to?: string;
  linkLabel?: string;
  className?: string;
}

function resolveLucideIcon(icon: string | undefined) {
  if (!icon) return null;
  const candidate = (LucideIcons as Record<string, unknown>)[icon];
  if (typeof candidate === 'function') return candidate as LucideIcons.LucideIcon;
  if (candidate && typeof candidate === 'object' && '$$typeof' in (candidate as Record<string, unknown>)) {
    return candidate as LucideIcons.LucideIcon;
  }
  return null;
}

export function EmptyState({
  icon,
  title,
  hint,
  to,
  linkLabel,
  className,
}: EmptyStateProps) {
  const Icon = resolveLucideIcon(icon);

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-10 text-center',
        className
      )}
    >
      {Icon && <Icon aria-hidden="true" className="mb-3 h-8 w-8 text-muted-foreground" />}
      <p className="text-base font-semibold">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      {to && linkLabel && (
        <Link to={to} className="mt-4 text-sm font-medium text-primary hover:underline">
          {linkLabel} →
        </Link>
      )}
    </div>
  );
}
