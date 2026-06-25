/**
 * Card Component - Content container with optional title and description
 */

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { EngineComponentProps } from '@/engine/types';
import { EngineErrorBoundary } from '@/engine/EngineErrorBoundary';

interface EngineCardProps extends EngineComponentProps {
  title?: string;
  description?: string;
  footer?: React.ReactNode;
  interactive?: boolean;
  padding?: 'default' | 'compact';
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
}

export function EngineCard({
  title,
  description,
  footer,
  interactive = false,
  padding = 'default',
  className,
  headerClassName,
  contentClassName,
  footerClassName,
  children,
}: EngineCardProps) {
  const hasHeader = title || description;
  const compact = padding === 'compact';

  return (
    <Card
      className={cn(
        interactive
          && 'transition-shadow duration-150 hover:shadow-[0_4px_12px_rgba(10,42,43,0.10)]',
        interactive && 'hover:border-primary/30',
        className
      )}
    >
      {hasHeader && (
        <CardHeader className={cn(compact ? 'p-4' : 'p-6', headerClassName)}>
          {title && <CardTitle className="text-base font-semibold">{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
      )}
      <CardContent
        className={cn(
          compact ? 'p-4' : 'p-6',
          !hasHeader && (compact ? 'pt-4' : 'pt-6'),
          hasHeader && 'pt-0',
          contentClassName
        )}
      >
        <EngineErrorBoundary>
          {children}
        </EngineErrorBoundary>
      </CardContent>
      {footer && (
        <CardFooter className={cn(compact ? 'p-4 pt-0' : 'p-6 pt-0', footerClassName)}>
          {footer}
        </CardFooter>
      )}
    </Card>
  );
}
