/**
 * The contracts this conversation has read, under the composer.
 *
 * The cost signal the panel cannot give at a glance: it answers "how much
 * architecture has this session loaded" while the code is being written, without
 * opening anything.
 */

import { useEffect, useState } from 'react';

import type { ActiveAnswer } from '../../shared/contracts.js';
import { api } from '../lib/api.js';
import { Badge } from './ui/badge.js';

export function ActiveStrip() {
  const [active, setActive] = useState<ActiveAnswer | null>(null);

  useEffect(() => {
    let live = true;
    const tick = async (): Promise<void> => {
      try {
        const answer = await api.active('');
        if (live) setActive(answer);
      } catch {
        if (live) setActive(null);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (active === null || active.read.length === 0) return null;
  const read = active.contracts.filter((contract) => contract.read);
  const tokens = read.reduce((sum, contract) => sum + contract.tokens, 0);

  return (
    <div
      className="flex flex-wrap items-center gap-1 px-1 py-0.5 text-[11px] text-muted-foreground"
      title="Architecture contracts this conversation has read"
    >
      <span>
        arch {read.length}/{active.contracts.length} · {tokens} tok
      </span>
      {read.map((contract) => (
        <Badge key={contract.module} tone="success">
          {contract.module}
          <span className="ml-1 tabular-nums opacity-70">{contract.tokens}</span>
        </Badge>
      ))}
    </div>
  );
}
