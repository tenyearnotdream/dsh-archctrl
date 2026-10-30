/**
 * Bringing a repository into the tree.
 *
 * Three states need three answers, and the panel must say which one applies
 * before offering anything:
 *
 * - **empty** — no `.archctrl` at all. There is nothing to derive from, so the
 *   only honest proposal is a scaffold: boundaries taken from the repository's
 *   own layout, with no rules in them.
 * - **undeclared** — documents exist but never said what they govern. Their own
 *   citations are a statement of intent, so scope is derived from those; where
 *   two documents would claim one path, the model decides which one owns it.
 * - **declared** — nothing to do.
 *
 * Nothing is written until the author presses a button, and what gets written is
 * shown first. A tool that edits architecture documents on its own is a second
 * authority over the documents it is supposed to serve.
 */

import { useCallback, useState } from 'react';

import type { Diagnosis, RepairResult, ScaffoldEntry } from '../../shared/contracts.js';
import { api } from '../lib/api.js';
import { describeError } from '../lib/errors.js';
import { t } from '../locale/index.js';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';

interface RepairState {
  results: readonly RepairResult[];
  contested: number;
  resolved: number;
  modelNote?: string;
}

export function Onboarding({ root, onDone }: { root: string; onDone: () => void }) {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [repair, setRepair] = useState<RepairState | null>(null);
  const [scaffold, setScaffold] = useState<readonly ScaffoldEntry[] | null>(null);
  const [busy, setBusy] = useState<'scan' | 'repair' | 'apply' | 'scaffold' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setBusy('scan');
    setError(null);
    try {
      setDiagnosis(await api.diagnose(root));
      setRepair(null);
      setScaffold(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  }, [root]);

  const propose = useCallback(
    async (useModel: boolean) => {
      setBusy('repair');
      setError(null);
      try {
        const answer = await api.repair(root, false, useModel);
        setRepair({
          results: answer.results,
          contested: answer.contested,
          resolved: answer.resolved,
          ...(answer.modelNote === undefined ? {} : { modelNote: answer.modelNote }),
        });
      } catch (cause) {
        setError(describeError(cause));
      } finally {
        setBusy(null);
      }
    },
    [root],
  );

  const applyRepair = useCallback(async () => {
    setBusy('apply');
    setError(null);
    try {
      const answer = await api.repair(root, true, false);
      setRepair({
        results: answer.results,
        contested: answer.contested,
        resolved: answer.resolved,
      });
      onDone();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  }, [root, onDone]);

  const planScaffold = useCallback(async () => {
    setBusy('scaffold');
    setError(null);
    try {
      const answer = await api.scaffold(root, { apply: false });
      setScaffold(answer.plan);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  }, [root]);

  const applyScaffold = useCallback(async () => {
    setBusy('apply');
    setError(null);
    try {
      await api.scaffold(root, { apply: true });
      setScaffold(null);
      onDone();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(null);
    }
  }, [root, onDone]);

  const writable = (repair?.results ?? []).filter((entry) => entry.owns.length > 0 && !entry.applied);

  return (
    <div className="archctrl-scroll px-3 py-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <h2 className="text-[13px] font-semibold">{t('onboard.title')}</h2>
        <Button size="sm" onClick={() => void scan()} disabled={busy !== null}>
          {busy === 'scan' ? t('onboard.scanning') : t('onboard.scan')}
        </Button>
      </div>

      {error === null ? null : (
        <div className="mb-2 rounded-md border border-destructive/50 px-2.5 py-1.5 text-[11.5px] text-destructive">
          {error}
        </div>
      )}

      {diagnosis === null ? (
        <p className="text-[11px] text-muted-foreground">
          Scan the repository first: the plugin reports what the tree is missing before it changes
          anything.
        </p>
      ) : diagnosis.state === 'empty' ? (
        <>
          <div className="mb-2 rounded-md border border-warning/50 px-2.5 py-2 text-[11.5px] leading-5">
            {t('onboard.empty')}
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">{t('onboard.scaffold-hint')}</p>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void planScaffold()}
            disabled={busy !== null || diagnosis.modules.length === 0}
          >
            {busy === 'scaffold' ? t('onboard.scanning') : t('onboard.scaffold')}
          </Button>
          {scaffold === null ? null : (
            <>
              <ul className="mt-2 grid gap-0.5">
                {scaffold.map((entry) => (
                  <li key={entry.path} className="font-mono text-[11px] leading-5 text-muted-foreground">
                    {entry.path}
                    <span className="ml-1 opacity-70">({entry.owns.join(', ') || '—'})</span>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="primary"
                className="mt-2"
                onClick={() => void applyScaffold()}
                disabled={busy !== null}
              >
                {busy === 'apply' ? t('onboard.applying') : t('onboard.scaffold-apply', { count: scaffold.length })}
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          <div
            className={cn(
              'mb-2 rounded-md border px-2.5 py-2 text-[11.5px] leading-5',
              diagnosis.state === 'declared' ? 'border-success/60' : 'border-warning/50',
            )}
          >
            {diagnosis.state === 'declared'
              ? t('onboard.declared')
              : t('onboard.undeclared', {
                  count: diagnosis.totals?.undeclared ?? 0,
                  total: diagnosis.totals?.contracts ?? 0,
                })}
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-1">
            <Button size="sm" onClick={() => void propose(false)} disabled={busy !== null}>
              {busy === 'repair' ? t('onboard.repairing') : t('onboard.repair')}
            </Button>
            <Button size="sm" onClick={() => void propose(true)} disabled={busy !== null}>
              {t('onboard.repair-model')}
            </Button>
          </div>

          {repair === null ? null : (
            <>
              {repair.contested > 0 ? (
                <div className="mb-2 rounded-md border border-warning/50 px-2.5 py-2 text-[11.5px] leading-5">
                  <div className="font-medium text-warning">
                    {t('onboard.contested', { count: repair.contested })}
                  </div>
                  <div className="text-muted-foreground">{t('onboard.contested-hint')}</div>
                  {repair.resolved > 0 ? (
                    <div className="text-success">
                      {repair.resolved} {t('onboard.resolved-by')}
                    </div>
                  ) : null}
                  {repair.modelNote === undefined ? null : (
                    <div className="text-muted-foreground">{t('onboard.no-model')}</div>
                  )}
                </div>
              ) : null}

              {repair.results.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('onboard.no-proposals')}</p>
              ) : (
                <ul className="grid gap-1">
                  {repair.results.map((entry) => (
                    <li
                      key={entry.contract}
                      className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11.5px] leading-5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px]">{entry.contract}</span>
                        {entry.applied ? (
                          <Badge tone="success">{entry.commit ?? 'ok'}</Badge>
                        ) : (
                          <Badge>{t('onboard.derived')}</Badge>
                        )}
                      </div>
                      {entry.owns.length === 0 ? (
                        <div className="text-muted-foreground">—</div>
                      ) : (
                        <ul className="mt-0.5 grid gap-0">
                          {entry.owns.map((owned) => (
                            <li key={owned} className="font-mono text-[10.5px] text-muted-foreground">
                              {owned}
                            </li>
                          ))}
                        </ul>
                      )}
                      {entry.unresolved.length === 0 ? null : (
                        <div className="mt-0.5 text-warning">
                          {t('onboard.unresolved', { paths: entry.unresolved.join(', ') })}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {writable.length > 0 ? (
                <Button
                  size="sm"
                  variant="primary"
                  className="mt-2"
                  onClick={() => void applyRepair()}
                  disabled={busy !== null}
                >
                  {busy === 'apply' ? t('onboard.applying') : t('onboard.apply-repair')}
                </Button>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
