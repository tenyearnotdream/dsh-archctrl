/**
 * The button primitive, in the shadcn shape: a variant table separated from the
 * element so a call site states intent (`variant="primary"`) rather than colours.
 *
 * It references only theme tokens, so light and dark come for free.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../../lib/utils.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground border border-transparent hover:opacity-90',
  secondary:
    'bg-card text-foreground border border-border-strong hover:bg-muted',
  ghost: 'bg-transparent text-muted-foreground border border-transparent hover:bg-muted hover:text-foreground',
  danger: 'bg-transparent text-destructive border border-destructive/60 hover:bg-muted',
};

const SIZES: Record<Size, string> = {
  sm: 'h-6 px-2 text-[11px] rounded-md gap-1',
  md: 'h-7 px-3 text-xs rounded-md gap-1.5',
  icon: 'h-6 w-6 rounded-md justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex select-none items-center whitespace-nowrap font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
