/**
 * One contract, in full: what it governs, what holds it, and its text.
 *
 * The body is fetched when selected rather than shipped with the tree: fifteen
 * documents in one payload would move ~36 KB to render one at a time.
 */

import { useEffect, useState } from 'react';

import type { ContractRecord, TreeState } from '../../shared/contracts.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { DriftDot, statusOf } from './ContractTree.js';

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

  useEffect(() => {
    if (contract === undefined) return undefined;
    let live = true;
    setText(null);
    setError(null);
    void api
      .contract(root, module)
      .then((answer) => {
        if (!live) return;
        const value = answer as { text: string };
        setText(value.text);
        onRead(module);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [root, module, contract, onRead]);

  if (contract === undefined) {
    return <div className="p-4 text-xs text-muted-foreground">No contract for this module.</div>;
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
              Close
            </Button>
          )}
        </div>
      </header>

      <div className="archctrl-scroll px-3 py-2.5">
        <section className="mb-3 grid gap-0.5">
          {contract.lastCommit === null ? null : (
            <Meta label="updated" value={contract.lastCommit.subject} />
          )}
          {contract.owns.length === 0 ? null : <Meta label="owns" value={contract.owns.join(', ')} />}
          {contract.depends.length === 0 ? null : (
            <Meta label="depends" value={contract.depends.join(', ')} />
          )}
          {contract.verifies.length === 0 ? null : (
            <Meta label="verifies" value={contract.verifies.join(', ')} />
          )}
        </section>

        {hint === undefined ? null : (
          <div className="mb-3 rounded-md border border-warning/50 px-2.5 py-2 text-[11.5px] leading-5">
            <span className="font-medium text-warning">Lagging</span>
            <span className="text-muted-foreground">
              {' '}
              — {hint.commits} code commit(s) after this contract was updated.
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
          <h3 className="mb-1 text-[11.5px] font-semibold">Cited paths</h3>
          {contract.refs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">This contract cites no repository paths.</p>
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
          <h3 className="mb-1 text-[11.5px] font-semibold">Contract</h3>
          {error !== null ? (
            <p className="text-[11.5px] text-destructive">{error}</p>
          ) : text === null ? (
            <p className="text-[11.5px] text-muted-foreground">Reading…</p>
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
