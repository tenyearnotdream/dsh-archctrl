/**
 * The right rail: the same tree, beside the conversation.
 *
 * Active is the default here because that is the working view — the contracts
 * this Session is currently held to. All stays a click away.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ActiveAnswer } from '../../shared/contracts.js';
import { api } from '../lib/api.js';
import { useTree } from '../composables/useTree.js';
import { useWorkspaces } from '../composables/useWorkspaces.js';
import { ContractDetail } from './ContractDetail.js';
import { ContractTree } from './ContractTree.js';
import { Overview } from './Overview.js';
import { Badge } from './ui/badge.js';
import { Segmented } from './ui/switch.js';
import { t } from '../locale/index.js';

type Scope = 'active' | 'all';

export function RightTab() {
  const workspaces = useWorkspaces();
  const tree = useTree(workspaces.root);
  const [scope, setScope] = useState<Scope>('active');
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [read, setRead] = useState<ReadonlySet<string>>(new Set());

  const refreshRead = useCallback(async () => {
    try {
      const answer: ActiveAnswer = await api.active('');
      setRead(new Set(answer.read));
    } catch {
      /* the reading log is advisory; a failure must not blank the tab */
    }
  }, []);

  useEffect(() => {
    void refreshRead();
    const timer = setInterval(() => void refreshRead(), 5000);
    return () => clearInterval(timer);
  }, [refreshRead]);

  if (workspaces.error !== null && tree.state === null) {
    return <div className="archctrl-root p-3 text-xs text-destructive">archctrl: {workspaces.error}</div>;
  }
  if (tree.state === null) {
    return (
      <div className="archctrl-root p-3 text-xs text-muted-foreground">
        {workspaces.root === '' ? 'no workspace with .archctrl contracts' : `reading ${workspaces.root}`}
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
            root={workspaces.root}
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
