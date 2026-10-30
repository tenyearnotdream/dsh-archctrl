/**
 * Switching repositories must not keep showing the previous one's tree.
 *
 * The panel reads one tree at a time; when the selector changes, the answer for
 * the old repository is no longer the answer to the question on screen. These
 * tests pin that the loader drops the stale tree immediately instead of waiting
 * for the new request to settle.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TreeState } from '../../../shared/contracts';

const treeFor = (root: string): TreeState => ({
  root,
  contracts: [],
  errors: [],
  warnings: [],
  hints: [],
  totals: { contracts: 0, tokens: 0, errors: 0, warnings: 0 },
});

/** Resolvers keyed by root, so each repository's answer is released on demand. */
let pending: Map<string, (state: TreeState) => void>;
let calls: string[];

vi.mock('../../lib/api.js', () => ({
  api: {
    state: (root: string) => {
      calls.push(root);
      return new Promise<TreeState>((resolve) => pending.set(root, resolve));
    },
  },
}));

const { useTree } = await import('../useTree');

describe('useTree', () => {
  beforeEach(() => {
    pending = new Map();
    calls = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('drops the previous tree as soon as the repository changes', async () => {
    const { result, rerender } = renderHook(({ root }) => useTree(root), {
      initialProps: { root: '/repo-a' },
    });

    await act(async () => {
      pending.get('/repo-a')?.(treeFor('/repo-a'));
    });
    await waitFor(() => expect(result.current.state?.root).toBe('/repo-a'));

    // Switch: the new request is still in flight, so nothing truthful can be
    // rendered about the new repository yet — least of all the old contracts.
    rerender({ root: '/repo-b' });

    expect(result.current.state).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('shows the new tree once the new repository answers', async () => {
    const { result, rerender } = renderHook(({ root }) => useTree(root), {
      initialProps: { root: '/repo-a' },
    });

    await act(async () => {
      pending.get('/repo-a')?.(treeFor('/repo-a'));
    });
    await waitFor(() => expect(result.current.state?.root).toBe('/repo-a'));

    rerender({ root: '/repo-b' });
    await act(async () => {
      pending.get('/repo-b')?.(treeFor('/repo-b'));
    });

    await waitFor(() => expect(result.current.state?.root).toBe('/repo-b'));
    expect(result.current.loading).toBe(false);
  });

  it('keeps the tree on a reload of the same repository', async () => {
    const { result } = renderHook(() => useTree('/repo-a'));

    await act(async () => {
      pending.get('/repo-a')?.(treeFor('/repo-a'));
    });
    await waitFor(() => expect(result.current.state?.root).toBe('/repo-a'));

    // A refresh asks about the same repository, so the answer already on screen
    // still answers the question; blanking the tree would only flicker.
    act(() => result.current.reload());

    expect(result.current.state?.root).toBe('/repo-a');
  });
});
