/** The tree's health at a glance: totals, problems, and what lags. */

import type { TreeState } from '../../shared/contracts.js';
import { Badge } from './ui/badge.js';
import { DriftDot } from './ContractTree.js';
import { t } from '../locale/index.js';

export function Overview({ state }: { state: TreeState }) {
  const sortedHints = [...state.hints].sort((a, b) => b.commits - a.commits);
  const clean = state.errors.length === 0 && state.warnings.length === 0;

  return (
    <div className="archctrl-scroll px-3 py-2.5">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold">{t('overview.title')}</h2>
        <span className="text-[11px] text-muted-foreground">
          {t('header.contracts', { count: state.totals.contracts, tokens: state.totals.tokens })}
        </span>
      </div>

      <div className="mb-3 grid gap-0.5 font-mono text-[11px] text-muted-foreground">
        <div className="truncate">{state.root}</div>
      </div>

      {state.errors.length === 0 ? null : (
        <section className="mb-3">
          <h3 className="mb-1 text-[11.5px] font-semibold text-destructive">{t('overview.errors')}</h3>
          {state.errors.map((issue) => (
            <div
              key={`${issue.rule}:${issue.message}`}
              className="mb-1 flex items-start gap-1.5 rounded-md border border-destructive/50 px-2.5 py-1.5 text-[11.5px] leading-5"
            >
              <span className="mt-1.5">
                <DriftDot status="error" />
              </span>
              <span className="min-w-0 break-words">
                <code className="text-[10.5px] text-muted-foreground">{issue.contract ?? issue.path}</code>{' '}
                {issue.message}
              </span>
            </div>
          ))}
        </section>
      )}

      {state.warnings.length === 0 ? null : (
        <section className="mb-3">
          <h3 className="mb-1 text-[11.5px] font-semibold text-warning">{t('overview.warnings')}</h3>
          {state.warnings.map((issue) => (
            <div
              key={`${issue.rule}:${issue.message}`}
              className="mb-1 flex items-start gap-1.5 rounded-md border border-warning/50 px-2.5 py-1.5 text-[11.5px] leading-5"
            >
              <span className="mt-1.5">
                <DriftDot status="warn" />
              </span>
              <span className="min-w-0 break-words">{issue.message}</span>
            </div>
          ))}
        </section>
      )}

      {sortedHints.length === 0 ? null : (
        <section>
          <h3 className="mb-1 flex items-baseline gap-2 text-[11.5px] font-semibold">
            {t('overview.lagging')}
            <Badge tone="neutral">{t('overview.informational')}</Badge>
          </h3>
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            {t('overview.lagging-note')}
          </p>
          <ul className="grid gap-0.5">
            {sortedHints.map((hint) => (
              <li key={hint.contract} className="flex items-baseline gap-2 text-[11.5px] leading-5">
                <code className="min-w-0 truncate text-[11px] text-muted-foreground">{hint.contract}</code>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {t('overview.commits', { count: hint.commits })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {clean ? (
        <p className="mt-3 text-[11px] text-muted-foreground">
          {t('overview.clean')}
        </p>
      ) : null}
    </div>
  );
}
