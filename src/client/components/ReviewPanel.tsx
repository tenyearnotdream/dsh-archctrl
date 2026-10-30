/**
 * The manual review, in three stages.
 *
 * Stage one and two are free and deterministic: which contracts own the change,
 * whether they were updated, and what evidence a reader needs. Stage three asks
 * this conversation's own model whether a rule actually moved — that is intent,
 * and only a model reading the contract can answer it.
 *
 * Batches run in sequence. Concurrent model calls against one provider is how a
 * batch turns into rate limits and half-finished results.
 */

import { useCallback, useRef, useState } from 'react';

import type { ApplyReceipt, ImpactModule, Judgement, ReviewResult } from '../../shared/contracts.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { DriftDot } from './ContractTree.js';

interface Entry {
  busy: boolean;
  verdict: Judgement | null;
  error: string | null;
  applied: ApplyReceipt | null;
}

const EMPTY: Entry = { busy: false, verdict: null, error: null, applied: null };

function toneOf(mod: ImpactModule) {
  if (mod.contractTouched) return 'neutral' as const;
  if (mod.commitsSinceContract > 0) return 'warning' as const;
  return 'neutral' as const;
}

function ModuleCard({
  mod,
  entry,
  onAsk,
  onAccept,
}: {
  mod: ImpactModule;
  entry: Entry;
  onAsk: () => void;
  onAccept: () => void;
}) {
  const verdict = entry.verdict;

  return (
    <section className="mb-2 rounded-md border border-border bg-card">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <DriftDot status={mod.contractTouched ? 'ok' : mod.commitsSinceContract > 0 ? 'warn' : 'lag'} />
        <span className="text-[12px] font-semibold">{mod.module}</span>
        <Badge>{mod.contract ?? 'no contract'}</Badge>
        <Badge tone={toneOf(mod)}>{mod.contractTouched ? 'updated' : 'not updated'}</Badge>
        {mod.commitsSinceContract > 0 ? <Badge>{mod.commitsSinceContract} behind</Badge> : null}
        <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
          {mod.contractTokens} tok
        </span>
      </header>

      <div className="px-2.5 py-2 text-[11.5px] leading-5 text-muted-foreground">
        <div>
          {mod.paths.length} owned path(s)
          {mod.diffStat === '' ? null : ` · ${mod.diffStat}`}
        </div>
        {mod.citesTouchedPaths.length === 0 ? null : (
          <div className="break-words">cites changed paths: {mod.citesTouchedPaths.join(', ')}</div>
        )}
        {mod.verifies.length === 0 ? null : (
          <div className="break-words">verifies: {mod.verifies.join(', ')}</div>
        )}

        {entry.applied === null ? null : (
          <div className="mt-2 rounded-md border border-success/60 px-2 py-1.5">
            <div className="font-medium text-success">committed {entry.applied.commit}</div>
            <div className="break-words">{entry.applied.path} — {entry.applied.message}</div>
            <div>Your code change is still uncommitted.</div>
          </div>
        )}

        {entry.applied !== null ? null : (
          <div className="mt-1.5">
            <Button size="sm" onClick={onAsk} disabled={entry.busy || mod.contract === null}>
              {entry.busy ? 'Asking…' : verdict === null ? 'Ask model' : 'Ask again'}
            </Button>
            <span className="ml-2 text-[10.5px]">
              {verdict === null ? 'This contract only, using the conversation’s model.' : ''}
            </span>

            {verdict === null ? null : (
              <div
                className={cn(
                  'mt-2 rounded-md border px-2 py-1.5',
                  verdict.change ? 'border-warning/60' : 'border-success/60',
                )}
              >
                <div className={cn('font-medium', verdict.change ? 'text-warning' : 'text-success')}>
                  {verdict.change ? 'contract needs an update' : 'contract still holds'}
                </div>
                {verdict.reason === '' ? null : <div className="mt-0.5">{verdict.reason}</div>}
                {verdict.basis === '' ? null : (
                  <div className="mt-0.5">basis: {verdict.basis}</div>
                )}
                {verdict.change && verdict.body !== undefined ? (
                  <>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-[11px] leading-[1.7]">
                      {verdict.body}
                    </pre>
                    <Button size="sm" variant="primary" className="mt-2" onClick={onAccept} disabled={entry.busy}>
                      {entry.busy ? 'Committing…' : 'Apply and commit'}
                    </Button>
                    <div className="mt-1 text-[10.5px]">
                      Commits only this document; your code stays uncommitted.
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </div>
        )}

        {entry.error === null ? null : <div className="mt-1.5 text-destructive">{entry.error}</div>}
      </div>
    </section>
  );
}

export interface ReviewPanelProps {
  readonly root: string;
}

export function ReviewPanel({ root }: ReviewPanelProps) {
  const [base, setBase] = useState('main');
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [batch, setBatch] = useState<{ done: number; total: number; running: boolean; changes: number; failures: number } | null>(null);

  // A ref mirrors entries so an async handler reads the latest verdict rather
  // than the value captured before its await resolved.
  const entriesRef = useRef<Record<string, Entry>>({});
  const patch = useCallback((module: string, next: Partial<Entry>) => {
    const updated = { ...entriesRef.current, [module]: { ...EMPTY, ...entriesRef.current[module], ...next } };
    entriesRef.current = updated;
    setEntries(updated);
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const next = await api.review(root, base);
      setResult(next);
      setError(null);
      // A new review describes a new change set; verdicts about the previous one
      // must not be presented beside it.
      entriesRef.current = {};
      setEntries({});
      setBatch(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [root, base]);

  const askOne = useCallback(
    async (module: string) => {
      patch(module, { busy: true, error: null });
      try {
        const verdict = await api.judge(root, module, base);
        patch(module, { verdict, busy: false });
        return { ok: true as const, verdict };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        patch(module, { error: message, busy: false });
        return { ok: false as const, message };
      }
    },
    [root, base, patch],
  );

  const acceptOne = useCallback(
    async (module: string) => {
      const body = entriesRef.current[module]?.verdict?.body;
      if (body === undefined) return;
      patch(module, { busy: true, error: null });
      try {
        patch(module, { applied: await api.apply(root, module, body), busy: false });
      } catch (cause) {
        patch(module, { error: cause instanceof Error ? cause.message : String(cause), busy: false });
      }
    },
    [root, patch],
  );

  const askAll = useCallback(async () => {
    if (result === null) return;
    const targets = result.modules.filter((mod) => mod.contract !== null);
    setBatch({ done: 0, total: targets.length, running: true, changes: 0, failures: 0 });
    let changes = 0;
    let failures = 0;
    for (const [index, mod] of targets.entries()) {
      const outcome = await askOne(mod.module);
      if (!outcome.ok) failures += 1;
      else if (outcome.verdict.change) changes += 1;
      setBatch({ done: index + 1, total: targets.length, running: true, changes, failures });
    }
    setBatch({ done: targets.length, total: targets.length, running: false, changes, failures });
  }, [result, askOne]);

  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="text-[13px] font-semibold">Review before commit</span>
        <label className="ml-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          base
          <input
            value={base}
            onChange={(event) => setBase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run();
            }}
            className="h-5 w-20 rounded border border-border-strong bg-card px-1.5 text-[11px] text-foreground outline-none focus:border-primary"
          />
        </label>
        <Button size="sm" variant="primary" onClick={() => void run()} disabled={busy}>
          {busy ? 'Checking…' : 'Check changes'}
        </Button>
        {result !== null && result.modules.length > 0 ? (
          <Button size="sm" onClick={() => void askAll()} disabled={batch?.running === true}>
            {batch?.running === true ? `Judging ${batch.done}/${batch.total}…` : 'Judge all'}
          </Button>
        ) : null}
      </header>

      <div className="archctrl-scroll px-3 py-2.5">
        <p className="mb-2 text-[11px] text-muted-foreground">
          Stages one and two are deterministic and spend no model tokens. They report which contracts
          own the change and whether they were updated; whether a rule moved is what “Ask model”
          answers.
        </p>

        {error === null ? null : (
          <div className="mb-2 rounded-md border border-destructive/50 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {error}
          </div>
        )}

        {result === null ? null : (
          <>
            <div
              className={cn(
                'mb-2 rounded-md border px-2.5 py-2 text-[12px] leading-5',
                result.verdict === 'no architectural surface changed'
                  ? 'border-success/60'
                  : 'border-warning/60',
              )}
            >
              <span className="font-medium">{result.verdict}</span>
              <div className="text-[11px] text-muted-foreground">
                {result.changedFiles} file(s) changed · {result.modules.length} module(s) involved ·
                evidence ~{result.estimate.evidenceTokens} tokens
              </div>
            </div>

            {batch !== null && !batch.running ? (
              <div
                className={cn(
                  'mb-2 rounded-md border px-2.5 py-1.5 text-[11.5px]',
                  batch.changes > 0 ? 'border-warning/60' : 'border-success/60',
                )}
              >
                <span className="font-medium">
                  {batch.changes > 0
                    ? `${batch.changes} of ${batch.total} contract(s) need an update`
                    : `all ${batch.total} contract(s) still hold`}
                </span>
                {batch.failures > 0 ? (
                  <span className="text-muted-foreground"> · {batch.failures} could not be judged</span>
                ) : null}
              </div>
            ) : null}

            {result.modules.map((mod) => (
              <ModuleCard
                key={mod.module}
                mod={mod}
                entry={entries[mod.module] ?? EMPTY}
                onAsk={() => void askOne(mod.module)}
                onAccept={() => void acceptOne(mod.module)}
              />
            ))}

            {result.unmatched.length === 0 ? null : (
              <div className="mb-2 rounded-md border border-warning/50 px-2.5 py-1.5 text-[11.5px]">
                no module owns: {result.unmatched.slice(0, 8).join(', ')}
                {result.unmatched.length > 8 ? ' …' : ''}
              </div>
            )}

            {result.signatureLines.length === 0 ? null : (
              <section className="mt-2">
                <h3 className="mb-1 text-[11.5px] font-semibold">
                  New or changed declarations ({result.signatureLines.length})
                </h3>
                <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-[1.7]">
                  {result.signatureLines.join('\n')}
                </pre>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
