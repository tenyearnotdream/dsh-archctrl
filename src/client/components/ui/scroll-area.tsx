/** A scroll container that keeps the Host's scrollbar chrome out of the way. */

import type { ReactNode } from 'react';

import { cn } from '../../lib/utils.js';

export function ScrollArea({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('archctrl-scroll min-h-0 flex-1', className)}>{children}</div>;
}
