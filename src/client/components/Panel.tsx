/**
 * The full page: tree, detail, overview and the review flow.
 *
 * It owns no data beyond which row is selected. The tree, the workspaces and the
 * reading log each come from their own composable, so the panel and the right
 * rail cannot disagree about what exists.
 */

import { useCallback, useState } from 'react';

import { useTree } from '../composables/useTree.js';
import { useWorkspaces } from '../composables/useWorkspaces.js';
import { cn } from '../lib/utils.js';
import { ActiveStrip } from './ActiveStrip.js';
import { ContractDetail } from './ContractDetail.js';
import { ContractTree } from './ContractTree.js';
import { Overview } from './Overview.js';
import { ReviewPanel } from './ReviewPanel.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Segmented } from './ui/switch.js';

type Mode = 'tree' | 'review';
type Scope = 'active' | 'all';

/** The reading log is served by the same Host route the strip uses. */
function useReadingLog(): { read: ReadonlySet<string>; note: (module: string | null) => void } {
  const [read, setRead] = useState<Set<string>>(new Set());
  const note = useCallback((module: string | null) => {
    setRead((current) => new Set(current).add(String(module)));
  }, []);
  return { read, note };
}

export function Panel() {
  const workspaces = useWorkspaces();
  const tree = useTree(workspaces.root);
  const reading = useReadingLog();
  const [mode, setMode] = useState<Mode>('tree');
  const [scope, setScope] = useState<Scope>('all');
  const [selected, setSelected] = useState<string | null | undefined>('overview');

  if (workspaces.error !== null && tree.state === null) {
    return (
      <div className="archctrl-root items-center justify-center p-6 text-xs text-destructive">
        archctrl: {workspaces.error}
      </div>
    );
  }
  if (tree.state === null) {
    const detail =
      workspaces.root === ''
        ? workspaces.items.length === 0
          ? `no workspace could be resolved (registry ${workspaces.source?.registry ?? 0}, sessions ${workspaces.source?.sessions ?? 0})`
          : 'no workspace selected'
        : `reading ${workspaces.root}`;
    return <div className="archctrl-root items-center justify-center p-6 text-xs text-muted-foreground">{detail}</div>;
  }

  const state = tree.state;
  const activeCount = state.contracts.filter((c) => reading.read.has(String(c.module))).length;

  return (
    <div className="archctrl-root">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="text-[13px] font-semibold">Architecture</span>

        {workspaces.items.length > 1 ? (
          <select
            value={workspaces.root}
            onChange={(event) => workspaces.select(event.target.value)}
            className="h-6 max-w-72 rounded border border-border-strong bg-card px-1.5 text-[11px] text-foreground outline-none focus:border-primary"
            title="Repository to read contracts from"
          >
            {workspaces.items.map((item) => (
              <option key={item.id} value={item.path}>
                {item.title} — {item.path}
              </option>
            ))}
          </select>
        ) : (
          <span className="truncate text-[11px] text-muted-foreground">{state.root}</span>
        )}

        <span className="text-[11px] tabular-nums text-muted-foreground">
          {state.totals.contracts} contracts · {state.totals.tokens} tok
        </span>
        {state.totals.errors > 0 ? <Badge tone="danger">{state.totals.errors} error</Badge> : null}
        {state.totals.warnings > 0 ? <Badge tone="warning">{state.totals.warnings} warning</Badge> : null}

        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" onClick={() => setMode(mode === 'review' ? 'tree' : 'review')}>
            {mode === 'review' ? 'Back to tree' : 'Review before commit'}
          </Button>
          <Button size="sm" variant="primary" onClick={tree.reload} disabled={tree.loading}>
            {tree.loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {mode === 'review' ? (
        <div className="archctrl-scroll min-h-0 flex-1">
          <ReviewPanel root={workspaces.root} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-64 shrink-0 flex-col border-r border-border">
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
              <Segmented
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'active', label: 'Active', count: activeCount },
                  { value: 'all', label: 'All', count: state.contracts.length },
                ]}
              />
            </div>
            <div className="archctrl-scroll min-h-0 flex-1">
              {scope === 'active' && activeCount === 0 ? (
                <p className="px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                  This conversation has not read a contract yet. Call <code>arch_impact</code>, or
                  switch to All.
                </p>
              ) : (
                <ContractTree
                  state={
                    scope === 'active'
                      ? { ...state, contracts: state.contracts.filter((c) => reading.read.has(String(c.module))) }
                      : state
                  }
                  selected={selected}
                  onSelect={setSelected}
                  read={reading.read}
                />
              )}
            </div>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className={cn('min-h-0 flex-1 overflow-auto')}>
              {selected === 'overview' || selected === undefined ? (
                <Overview state={state} />
              ) : (
                <ContractDetail
                  root={workspaces.root}
                  state={state}
                  module={selected}
                  onRead={reading.note}
                  onClose={() => setSelected('overview')}
                />
              )}
            </div>
            <div className="border-t border-border">
              <ActiveStrip />
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
