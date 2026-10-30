/**
 * The contract tree, always fully expanded.
 *
 * The hierarchy is fixed and shallow — a module and its submodules — so
 * collapsing it would hide the sibling a reader is comparing against. Depth
 * comes from the directory layout, not a stored parent link: a module whose
 * parent has no contract is a top-level module, so an uneven tree still renders.
 */

import { useMemo } from 'react';

import type { ContractRecord, TreeState } from '../../shared/contracts.js';
import { cn } from '../lib/utils.js';
import { t } from '../locale/index.js';

export interface TreeRow {
  readonly contract: ContractRecord;
  readonly depth: number;
}

const parentOf = (module: string | null): string | null =>
  module !== null && module.includes('/') ? module.slice(0, module.lastIndexOf('/')) : null;

/** Every contract in tree order, with the depth its position implies. */
export function flatten(state: TreeState): TreeRow[] {
  const root = state.contracts.find((c) => c.module === null) ?? null;
  const modules = state.contracts.filter((c) => c.module !== null);
  const byModule = new Map(modules.map((c) => [c.module, c]));

  const depthOf = (module: string): number => {
    let depth = 1;
    let cursor = parentOf(module);
    while (cursor !== null && byModule.has(cursor)) {
      depth += 1;
      cursor = parentOf(cursor);
    }
    return depth;
  };

  const rows: TreeRow[] = [];
  if (root !== null) rows.push({ contract: root, depth: 0 });
  for (const contract of [...modules].sort((a, b) => String(a.module).localeCompare(String(b.module)))) {
    rows.push({ contract, depth: depthOf(String(contract.module)) });
  }
  return rows;
}

export type DriftStatus = 'error' | 'warn' | 'lag' | 'ok';

/** A contract's drift state, most severe first. */
export function statusOf(state: TreeState, module: string | null): DriftStatus {
  const contract = state.contracts.find((c) => c.module === module);
  if (contract === undefined) return 'ok';
  if (contract.problem !== undefined) return 'error';
  if (state.errors.some((issue) => issue.contract === contract.path || issue.path === contract.path)) {
    return 'error';
  }
  if (state.warnings.some((issue) => issue.contract === contract.path)) return 'warn';
  if (state.hints.some((hint) => hint.contract === contract.path)) return 'lag';
  return 'ok';
}

const DOT_CLASS: Record<DriftStatus, string> = {
  error: 'bg-destructive',
  warn: 'bg-warning',
  lag: 'bg-idle',
  ok: 'bg-success',
};

export function DriftDot({ status }: { status: DriftStatus }) {
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[status])}
      title={t(`drift.${status}`)}
      aria-label={t(`drift.${status}`)}
    />
  );
}

export interface ContractTreeProps {
  readonly state: TreeState;
  readonly selected: string | null | undefined;
  readonly onSelect: (module: string | null | undefined) => void;
  readonly read: ReadonlySet<string>;
  /** Skip indentation, for the narrow right rail. */
  readonly flat?: boolean;
}

export function ContractTree({ state, selected, onSelect, read, flat = false }: ContractTreeProps) {
  const rows = useMemo(() => flatten(state), [state]);

  return (
    <ul role="tree" className="py-1">
      {rows.map((row) => {
        const module = row.contract.module;
        const label = module ?? 'arch.md';
        const isRead = read.has(String(module));
        const active = selected === module;
        return (
          <li key={String(module)} role="treeitem" aria-selected={active}>
            <button
              type="button"
              onClick={() => onSelect(module)}
              style={{ paddingLeft: flat ? 12 : 10 + row.depth * 14 }}
              className={cn(
                'group flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs leading-5 transition-colors',
                'border-l-2 border-transparent',
                active
                  ? 'border-primary bg-muted text-foreground'
                  : 'text-foreground/90 hover:bg-muted/70',
              )}
            >
              <DriftDot status={statusOf(state, module)} />
              <span className="truncate" title={row.contract.path}>
                {label}
              </span>
              {isRead ? (
                <span className="shrink-0 text-[10px] text-success" title={t('detail.read-in-session')}>
                  ✓
                </span>
              ) : null}
              <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                {row.contract.tokens}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
