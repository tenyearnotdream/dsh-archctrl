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
  /**
   * The failure itself, not just its text: the Host's stable codes are what the
   * panel translates and branches on, and flattening them to a string here
   * made "this repository has no contracts" indistinguishable from any other
   * refusal.
   */
  readonly error: Error | null;
  readonly loading: boolean;
  reload(): void;
}

export function useTree(root: string): TreeLoader {
  const [state, setState] = useState<TreeState | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (root === '') return undefined;
    let live = true;
    setLoading(true);
    // Drop the previous repository's tree the moment the target changes. Keeping
    // it until the new answer arrives would render one workspace's contracts
    // under another workspace's selector, which reads as a stale tree rather
    // than as a load in progress.
    setState((current) => (current !== null && current.root === root ? current : null));
    setError(null);
    void api
      .state(root)
      .then((next) => {
        if (!live) return;
        setState(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
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
