/**
 * Image Component - Renders an equipment or product image with graceful fallback
 */

import { useState } from 'react';
import {
  Package,
  Truck,
  Wrench,
  Building2,
  HardHat,
  Scissors,
  Forklift,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EngineComponentProps } from '@/engine/types';

/** Curated allowlist of placeholder icons for equipment images. */
const PLACEHOLDER_ICON_MAP: Record<string, LucideIcon> = {
  Package,
  Truck,
  Wrench,
  Building2,
  HardHat,
  Scissors,
  Forklift,
};

interface EngineImageProps extends EngineComponentProps {
  src?: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
  fallbackText?: string;
  placeholderIcon?: string;
  objectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';
  className?: string;
}

export function EngineImage({
  src,
  alt = '',
  width,
  height,
  fallbackText,
  placeholderIcon = 'Package',
  objectFit = 'contain',
  className,
}: EngineImageProps) {
  const [errored, setErrored] = useState(false);

  const containerStyle: React.CSSProperties = {
    width: width ?? '100%',
    height: height ?? 200,
  };

  if (!src || errored) {
    const Icon: LucideIcon = PLACEHOLDER_ICON_MAP[placeholderIcon] ?? Package;
    const label = fallbackText ?? alt ?? 'No image';
    return (
      <div
        aria-label={label}
        role="img"
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-md bg-gradient-to-br from-primary/5 to-primary/10',
          className
        )}
        style={containerStyle}
      >
        <Icon aria-hidden="true" className="h-10 w-10 text-primary/40" />
        {label && (
          <span aria-hidden="true" className="text-xs font-medium text-muted-foreground text-center px-3 leading-tight line-clamp-2">
            {label}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={cn('overflow-hidden rounded-md bg-muted', className)} style={containerStyle}>
      <img
        src={src}
        alt={alt}
        className="w-full h-full"
        style={{ objectFit }}
        onError={() => setErrored(true)}
      />
    </div>
  );
}
