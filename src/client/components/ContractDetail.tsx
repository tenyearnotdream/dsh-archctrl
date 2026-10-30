/**
 * One contract, in full: what it governs, what holds it, and its text.
 *
 * The body is fetched when selected rather than shipped with the tree: fifteen
 * documents in one payload would move ~36 KB to render one at a time.
 */

import { useEffect, useRef, useState } from 'react';

import type { ContractRecord, TreeState } from '../../shared/contracts.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { DriftDot, statusOf } from './ContractTree.js';
import { t } from '../locale/index.js';
import { describeError } from '../lib/errors.js';

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-[11.5px] leading-5">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

export interface ContractDetailProps {
  readonly root: string;
  readonly state: TreeState;
  readonly module: string | null;
  readonly onRead: (module: string | null) => void;
  readonly onClose?: () => void;
}

export function ContractDetail({ root, state, module, onRead, onClose }: ContractDetailProps) {
  const contract: ContractRecord | undefined = state.contracts.find((c) => c.module === module);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The read notice goes through a ref. A caller almost always passes an inline
  // arrow, which is a new identity on every render; putting it in the dependency
  // list would re-run this effect forever — re-fetching the body, resetting it to
  // null, and bumping the reading counter on every cycle.
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  // The repository and the module are the whole identity of this request. The
  // contract object is derived from the tree and changes on every refresh, so
  // depending on it would refetch a body that has not changed.
  const contractPath = contract?.path;

  useEffect(() => {
    if (contractPath === undefined) return undefined;
    let live = true;
    setText(null);
    setError(null);
    void api
      .contract(root, module)
      .then((answer) => {
        if (!live) return;
        setText((answer as { text: string }).text);
        onReadRef.current(module);
      })
      .catch((cause: unknown) => {
        if (live) setError(describeError(cause));
      });
    return () => {
      live = false;
    };
  }, [root, module, contractPath]);

  if (contract === undefined) {
    return <div className="p-4 text-xs text-muted-foreground">{t('detail.none')}</div>;
  }

  const hint = state.hints.find((h) => h.contract === contract.path);
  const issues = state.errors.filter((e) => e.contract === contract.path);

  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <DriftDot status={statusOf(state, module)} />
        <span className="truncate text-[13px] font-semibold">{module ?? '.archctrl/arch.md'}</span>
        <Badge>{contract.contract}</Badge>
        <span className="text-[10.5px] tabular-nums text-muted-foreground">{contract.tokens} tok</span>
        <div className="ml-auto flex items-center gap-1">
          {onClose === undefined ? null : (
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('detail.close')}
            </Button>
          )}
        </div>
      </header>

      <div className="archctrl-scroll px-3 py-2.5">
        <section className="mb-3 grid gap-0.5">
          {contract.lastCommit === null ? null : (
            <Meta label={t('detail.updated')} value={contract.lastCommit.subject} />
          )}
          {contract.owns.length === 0 ? null : <Meta label={t('detail.owns')} value={contract.owns.join(', ')} />}
          {contract.depends.length === 0 ? null : (
            <Meta label={t('detail.depends')} value={contract.depends.join(', ')} />
          )}
          {contract.verifies.length === 0 ? null : (
            <Meta label={t('detail.verifies')} value={contract.verifies.join(', ')} />
          )}
        </section>

        {hint === undefined ? null : (
          <div className="mb-3 rounded-md border border-warning/50 px-2.5 py-2 text-[11.5px] leading-5">
            <span className="font-medium text-warning">{t('detail.lagging')}</span>
            <span className="text-muted-foreground">
              {' '}
              {' '}{t('detail.lagging-note', { count: hint.commits })}
            </span>
          </div>
        )}

        {issues.length === 0 ? null : (
          <section className="mb-3">
            {issues.map((issue) => (
              <div
                key={`${issue.rule}:${issue.message}`}
                className="mb-1 rounded-md border border-destructive/50 px-2.5 py-1.5 text-[11.5px] leading-5 text-destructive"
              >
                {issue.message}
              </div>
            ))}
          </section>
        )}

        <section className="mb-3">
          <h3 className="mb-1 text-[11.5px] font-semibold">{t('detail.cited-paths')}</h3>
          {contract.refs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t('detail.no-cited-paths')}</p>
          ) : (
            <ul className="grid gap-0.5">
              {contract.refs.map((ref) => (
                <li key={ref} className="truncate font-mono text-[11px] text-muted-foreground">
                  {ref}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-[11.5px] font-semibold">{t('detail.contract')}</h3>
          {error !== null ? (
            <p className="text-[11.5px] text-destructive">{error}</p>
          ) : text === null ? (
            <p className="text-[11.5px] text-muted-foreground">{t('detail.reading')}</p>
          ) : (
            <pre
              className={cn(
                'whitespace-pre-wrap break-words rounded-md border border-border bg-card',
                'p-2.5 font-mono text-[11.5px] leading-[1.7] text-foreground/90',
              )}
            >
              {text}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}
