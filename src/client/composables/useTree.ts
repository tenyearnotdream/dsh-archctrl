/**
 * Reading one repository's contract tree.
 *
 * The tree is re-fetched rather than cached across edits: a panel that shows a
 * contract the user just changed on disk would be worse than a slower one.
 */

import { useCallback, useEffect, useState } from 'react';

import type { TreeState } from '../../shared/contracts.js';
import { api } from '../lib/api.js';

export interface TreeLoader {
  readonly state: TreeState | null;
  readonly error: string | null;
  readonly loading: boolean;
  reload(): void;
}

export function useTree(root: string): TreeLoader {
  const [state, setState] = useState<TreeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (root === '') return undefined;
    let live = true;
    setLoading(true);
    void api
      .state(root)
      .then((next) => {
        if (!live) return;
        setState(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [root, tick]);

  return { state, error, loading, reload };
}
