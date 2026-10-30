/** A small status pill. Tone is semantic, never a raw colour. */

import type { ReactNode } from 'react';

import { cn } from '../../lib/utils.js';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand';

const TONES: Record<Tone, string> = {
  neutral: 'border-border text-muted-foreground',
  success: 'border-success/60 text-success',
  warning: 'border-warning/60 text-warning',
  danger: 'border-destructive/60 text-destructive',
  brand: 'border-primary/60 text-primary',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-px text-[10.5px] leading-4',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
