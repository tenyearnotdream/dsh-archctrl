/**
 * The right rail: the same tree, beside the conversation.
 *
 * Active is the default here because that is the working view — the contracts
 * this Session is currently held to. All stays a click away.
 *
 * The rail is Session-scoped, so the repository it reads is that Session's own
 * working directory. Asking the global workspace list instead made the tab
 * report on whichever repository happened to be listed first, and it kept
 * doing so after the conversation switched to another workspace.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ActiveAnswer } from '../../shared/contracts.js';
import { api } from '../lib/api.js';
import { describeError } from '../lib/errors.js';
import { useTree } from '../composables/useTree.js';
import { useWorkspaces } from '../composables/useWorkspaces.js';
import { ContractDetail } from './ContractDetail.js';
import { ContractTree } from './ContractTree.js';
import { Overview } from './Overview.js';
import { Badge } from './ui/badge.js';
import { Segmented } from './ui/switch.js';
import { t } from '../locale/index.js';

type Scope = 'active' | 'all';

/** The part of the Session list this tab reads. */
interface SessionListLike {
  readonly byId: Readonly<Record<string, { readonly cwd?: string } | undefined>>;
}

/** The selector hook the session-scoped slot supplies. */
type UseSessionsLike = <Selected>(selector: (state: SessionListLike) => Selected) => Selected;

export interface RightTabProps {
  /** Owning Session; the Host supplies this to a session-scoped slot. */
  readonly sessionId?: string;
  /** Session list selector, supplied by the same slot. */
  readonly useSessions?: UseSessionsLike;
}

const NO_SESSIONS: SessionListLike = { byId: {} };

/** Render outside a Session (tests, or a Host without the binding) without hooks. */
function selectNoSessions<Selected>(selector: (state: SessionListLike) => Selected): Selected {
  return selector(NO_SESSIONS);
}

export function RightTab({ sessionId, useSessions }: RightTabProps = {}) {
  const readSessions = useSessions ?? selectNoSessions;
  const sessionRoot = readSessions((state) =>
    sessionId === undefined ? undefined : state.byId[sessionId]?.cwd,
  );
  const workspaces = useWorkspaces();
  // A Session always names its repository. Only a rail rendered outside one
  // falls back to the workspace list, and only then may an arbitrary first
  // workspace be truthful.
  const root = sessionId === undefined ? workspaces.root : (sessionRoot ?? '');
  const tree = useTree(root);
  const [scope, setScope] = useState<Scope>('active');
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [read, setRead] = useState<ReadonlySet<string>>(new Set());

  const refreshRead = useCallback(async () => {
    try {
      const answer: ActiveAnswer = await api.active(sessionId ?? '');
      setRead(new Set(answer.read));
    } catch {
      /* the reading log is advisory; a failure must not blank the tab */
    }
  }, [sessionId]);

  useEffect(() => {
    void refreshRead();
    const timer = setInterval(() => void refreshRead(), 5000);
    return () => clearInterval(timer);
  }, [refreshRead]);

  // The workspace list is only a fallback; a failure to list it must not hide
  // the tree of the Session this tab is actually showing.
  if (sessionId === undefined && workspaces.error !== null && tree.state === null) {
    return (
      <div className="archctrl-root p-3 text-xs text-destructive">
        {t('state.error', { message: workspaces.error })}
      </div>
    );
  }
  if (tree.state === null) {
    // A failed read is a settled answer. Calling it "reading" hides the reason
    // the rail is empty and leaves it empty forever.
    if (tree.error !== null) {
      return (
        <div className="archctrl-root p-3 text-xs text-destructive">
          {t('state.error', { message: describeError(tree.error) })}
        </div>
      );
    }
    return (
      <div className="archctrl-root p-3 text-xs text-muted-foreground">
        {root === ''
          ? sessionId === undefined
            ? t('state.no-contracts')
            : t('state.locating')
          : t('state.reading', { root })}
      </div>
    );
  }

  const state = tree.state;
  const activeContracts = state.contracts.filter((c) => read.has(String(c.module)));

  return (
    <div className="archctrl-root">
      <header className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'active', label: t('scope.active'), count: activeContracts.length },
            { value: 'all', label: t('scope.all'), count: state.contracts.length },
          ]}
        />
        {state.totals.errors > 0 ? <Badge tone="danger">{state.totals.errors}</Badge> : null}
        <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
          {state.totals.tokens} tok
        </span>
      </header>

      <div className="archctrl-scroll max-h-72 shrink-0 border-b border-border">
        {scope === 'active' && activeContracts.length === 0 ? (
          <p className="px-3 py-2 text-[11px] leading-5 text-muted-foreground">
            {t('scope.empty-rail')}
          </p>
        ) : (
          <ContractTree
            state={scope === 'active' ? { ...state, contracts: activeContracts } : state}
            selected={selected}
            onSelect={setSelected}
            read={read}
            flat
          />
        )}
      </div>

      <div className="archctrl-scroll min-h-0 flex-1">
        {selected === undefined ? (
          <Overview state={state} />
        ) : (
          <ContractDetail
            root={root}
            state={state}
            module={selected}
            onRead={(module) =>
              setRead((current) =>
                current.has(String(module)) ? current : new Set(current).add(String(module)),
              )
            }
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
    </div>
  );
}
