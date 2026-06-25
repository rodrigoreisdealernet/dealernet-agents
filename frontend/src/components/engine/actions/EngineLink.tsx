/**
 * Link Component - Navigation link
 */

import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { EngineComponentProps } from '@/engine/types';

interface EngineLinkProps extends EngineComponentProps {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  external?: boolean;
  appearance?: 'inline' | 'action' | 'button';
  className?: string;
}

export function EngineLink({
  to,
  params,
  search,
  external = false,
  appearance = 'inline',
  className,
  children,
}: EngineLinkProps) {
  const isAction = appearance === 'action';
  const isButton = appearance === 'button';
  const linkClasses = cn(
    isAction
      ? 'inline-flex items-center text-sm font-medium text-primary hover:underline'
      : 'text-primary underline-offset-4 hover:underline',
    className
  );

  const content = (
    <>
      {children}
      {isAction && <span aria-hidden="true"> →</span>}
    </>
  );

  if (external) {
    if (isButton) {
      return (
        <Button asChild>
          <a href={to} target="_blank" rel="noopener noreferrer" className={className}>
            {children}
          </a>
        </Button>
      );
    }
    return (
      <a
        href={to}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClasses}
      >
        {content}
      </a>
    );
  }

  if (isButton) {
    return (
      <Button asChild>
        <Link to={to} params={params} search={search} className={className}>
          {children}
        </Link>
      </Button>
    );
  }

  return (
    <Link to={to} params={params} search={search} className={linkClasses}>
      {content}
    </Link>
  );
}
