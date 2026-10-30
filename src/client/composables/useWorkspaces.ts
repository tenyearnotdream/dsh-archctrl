/**
 * Which repository the panel is about.
 *
 * A `main` panel has no Session, so the repository is a choice rather than a
 * fact. The list is ordered with contract-bearing workspaces first, because that
 * is the one the plugin can actually show.
 */

import { useCallback, useEffect, useState } from 'react';

import type { WorkspaceOption } from '../../shared/contracts.js';
import { api } from '../lib/api.js';

export interface WorkspaceLoader {
  readonly items: readonly WorkspaceOption[];
  readonly root: string;
  readonly error: string | null;
  readonly source: { registry: number; sessions: number } | null;
  select(path: string): void;
}

export function useWorkspaces(preferred = ''): WorkspaceLoader {
  const [items, setItems] = useState<readonly WorkspaceOption[]>([]);
  const [root, setRoot] = useState(preferred);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{ registry: number; sessions: number } | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .workspaces()
      .then((answer) => {
        if (!live) return;
        const ordered = [...answer.items].sort(
          (a, b) => Number(b.hasContracts) - Number(a.hasContracts),
        );
        setItems(ordered);
        setSource(answer.source);
        setRoot((current) => {
          if (current !== '' && ordered.some((item) => item.path === current)) return current;
          return ordered.find((item) => item.hasContracts)?.path ?? ordered[0]?.path ?? '';
        });
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, []);

  const select = useCallback((path: string) => setRoot(path), []);

  return { items, root, error, source, select };
}
