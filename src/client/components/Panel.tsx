/**
 * The full page: tree, detail, overview and the review flow.
 *
 * It owns no data beyond which row is selected. The tree, the workspaces and the
 * reading log each come from their own composable, so the panel and the right
 * rail cannot disagree about what exists.
 */

import { useCallback, useState, type ReactNode } from 'react';

import type { WorkspaceLoader } from '../composables/useWorkspaces.js';
import { useTree } from '../composables/useTree.js';
import { useWorkspaces } from '../composables/useWorkspaces.js';
import { ApiError } from '../lib/api.js';
import { describeError } from '../lib/errors.js';
import { cn } from '../lib/utils.js';
import { ActiveStrip } from './ActiveStrip.js';
import { ContractDetail } from './ContractDetail.js';
import { ContractTree } from './ContractTree.js';
import { Overview } from './Overview.js';
import { Onboarding } from './Onboarding.js';
import { ReviewPanel } from './ReviewPanel.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Segmented } from './ui/switch.js';
import { t } from '../locale/index.js';

type Mode = 'tree' | 'review' | 'onboard';
type Scope = 'active' | 'all';

/** The reading log is served by the same Host route the strip uses. */
function useReadingLog(): { read: ReadonlySet<string>; note: (module: string | null) => void } {
  const [read, setRead] = useState<Set<string>>(new Set());
  const note = useCallback((module: string | null) => {
    // Returning the same Set when the entry is already present keeps React from
    // re-rendering: an identity change with identical content is still a change.
    setRead((current) => (current.has(String(module)) ? current : new Set(current).add(String(module))));
  }, []);
  return { read, note };
}

/**
 * The repository chooser.
 *
 * It has to survive a repository with no contracts: that refusal is one of the
 * states the panel can be in, and a reader stranded there with no selector
 * cannot get back to the tree of a repository that does have one.
 */
function RepositoryPicker({ loader }: { loader: WorkspaceLoader }) {
  if (loader.items.length <= 1) {
    return <span className="truncate text-[11px] text-muted-foreground">{loader.root}</span>;
  }
  return (
    <select
      value={loader.root}
      onChange={(event) => loader.select(event.target.value)}
      className="h-6 max-w-72 rounded border border-border-strong bg-card px-1.5 text-[11px] text-foreground outline-none focus:border-primary"
      title={t('header.repository')}
    >
      {loader.items.map((item) => (
        <option key={item.id} value={item.path}>
          {item.title} — {item.path}
        </option>
      ))}
    </select>
  );
}

/** A whole-panel state that is not a tree: reading, empty, refused. */
function StateScreen({
  loader,
  message,
  tone = 'muted',
  actions,
}: {
  loader: WorkspaceLoader;
  message: string;
  tone?: 'muted' | 'danger';
  actions?: ReactNode;
}) {
  return (
    <div className="archctrl-root">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="text-[13px] font-semibold">{t('panel.title')}</span>
        <RepositoryPicker loader={loader} />
      </header>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs',
          tone === 'danger' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        <p className="max-w-96 break-words">{message}</p>
        {actions === undefined ? null : <div className="flex items-center gap-1">{actions}</div>}
      </div>
    </div>
  );
}

/** Onboarding, for a repository that has no tree yet. */
function SetupScreen({
  loader,
  onDone,
  onClose,
}: {
  loader: WorkspaceLoader;
  onDone: () => void;
  onClose: () => void;
}) {
  return (
    <div className="archctrl-root">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="text-[13px] font-semibold">{t('onboard.title')}</span>
        <RepositoryPicker loader={loader} />
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" onClick={onClose}>
            {t('detail.close')}
          </Button>
        </div>
      </header>
      <div className="archctrl-scroll min-h-0 flex-1">
        <Onboarding key={loader.root} root={loader.root} onDone={onDone} />
      </div>
    </div>
  );
}

export function Panel() {
  const workspaces = useWorkspaces();
  const tree = useTree(workspaces.root);
  const reading = useReadingLog();
  const [mode, setMode] = useState<Mode>('tree');
  const [scope, setScope] = useState<Scope>('all');
  // `undefined` means "nothing selected" (Overview); `null` is the root index,
  // which is a real document like any other. Using a string such as 'overview'
  // would collide with a module named that and hide the root contract.
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  // A repository with no `.archctrl` has no tree to render, and that is exactly
  // the repository onboarding exists for. The flag keeps the flow open while it
  // runs; the refusal itself clears on the next read.
  const [setup, setSetup] = useState(false);

  if (workspaces.error !== null && tree.state === null) {
    return (
      <StateScreen
        loader={workspaces}
        tone="danger"
        message={t('state.error', { message: workspaces.error })}
      />
    );
  }

  if (tree.state === null) {
    if (tree.error !== null) {
      const missing = tree.error instanceof ApiError && tree.error.code === 'no-archctrl';
      if (missing && setup) {
        return (
          <SetupScreen
            loader={workspaces}
            onClose={() => setSetup(false)}
            onDone={() => {
              setSetup(false);
              tree.reload();
            }}
          />
        );
      }
      // The refusal is an answer, not a pending read. Without this branch the
      // panel says "Reading <root>…" forever, because a failed read leaves no
      // tree behind.
      return (
        <StateScreen
          loader={workspaces}
          tone="danger"
          message={t('state.error', { message: describeError(tree.error) })}
          actions={
            <>
              {missing ? (
                <Button size="sm" variant="primary" onClick={() => setSetup(true)}>
                  {t('onboard.title')}
                </Button>
              ) : null}
              <Button size="sm" onClick={tree.reload} disabled={tree.loading}>
                {tree.loading ? t('header.refreshing') : t('header.refresh')}
              </Button>
            </>
          }
        />
      );
    }

    const detail =
      workspaces.root === ''
        ? workspaces.items.length === 0
          ? t('state.no-workspace', {
              registry: workspaces.source?.registry ?? 0,
              sessions: workspaces.source?.sessions ?? 0,
            })
          : t('state.no-selection')
        : t('state.reading', { root: workspaces.root });
    return <StateScreen loader={workspaces} message={detail} />;
  }

  const state = tree.state;
  const activeCount = state.contracts.filter((c) => reading.read.has(String(c.module))).length;
  // A tree that exists but never stated its scope is the one state a reader
  // cannot see from the tree itself: the documents look complete.
  const undeclared = state.contracts.filter((c) => c.owns.length === 0).length;

  return (
    <div className="archctrl-root">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="text-[13px] font-semibold">{t('panel.title')}</span>

        <RepositoryPicker loader={workspaces} />

        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t('header.contracts', { count: state.totals.contracts, tokens: state.totals.tokens })}
        </span>
        {state.totals.errors > 0 ? <Badge tone="danger">{t('header.errors', { count: state.totals.errors })}</Badge> : null}
        {state.totals.warnings > 0 ? <Badge tone="warning">{t('header.warnings', { count: state.totals.warnings })}</Badge> : null}

        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" onClick={() => setMode(mode === 'review' ? 'tree' : 'review')}>
            {mode === 'review' ? t('review.back-to-tree') : t('review.title')}
          </Button>
          <Button
            size="sm"
            variant={undeclared > 0 ? 'danger' : 'secondary'}
            onClick={() => setMode(mode === 'onboard' ? 'tree' : 'onboard')}
          >
            {mode === 'onboard' ? t('review.back-to-tree') : t('onboard.title')}
          </Button>
          <Button size="sm" variant="primary" onClick={tree.reload} disabled={tree.loading}>
            {tree.loading ? t('header.refreshing') : t('header.refresh')}
          </Button>
        </div>
      </header>

      {mode === 'onboard' ? (
        <div className="archctrl-scroll min-h-0 flex-1">
          <Onboarding
            key={workspaces.root}
            root={workspaces.root}
            onDone={() => {
              tree.reload();
              setMode('tree');
            }}
          />
        </div>
      ) : mode === 'review' ? (
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
                  { value: 'active', label: t('scope.active'), count: activeCount },
                  { value: 'all', label: t('scope.all'), count: state.contracts.length },
                ]}
              />
            </div>
            <div className="archctrl-scroll min-h-0 flex-1">
              {scope === 'active' && activeCount === 0 ? (
                <p className="px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                  {t('scope.empty')}
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
              {selected === undefined ? (
                <Overview state={state} />
              ) : (
                <ContractDetail
                  root={workspaces.root}
                  state={state}
                  module={selected}
                  onRead={reading.note}
                  onClose={() => setSelected(undefined)}
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
