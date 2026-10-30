/**
 * The detail pane's fetch loop.
 *
 * Two bugs lived here: an inline `onRead` callback in the dependency list made
 * the effect re-run on every render (re-fetching, clearing the body, and bumping
 * the reading counter forever), and `null` — the root index — was treated as
 * "nothing selected" so the root contract never rendered its text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContractDetail } from '../ContractDetail';
import type { TreeState } from '../../../shared/contracts';

const tree = (): TreeState => ({
  root: '/repo',
  contracts: [
    {
      module: null,
      contract: 'arch.md',
      path: '.archctrl/arch.md',
      tokens: 100,
      bytes: 300,
      owns: [],
      depends: [],
      verifies: [],
      lastCommit: null,
      refs: [],
      links: [],
    },
    {
      module: 'project',
      contract: 'project/arch.md',
      path: '.archctrl/project/arch.md',
      tokens: 200,
      bytes: 600,
      owns: ['internal/logic/project'],
      depends: ['api'],
      verifies: ['test/backend/workflowcontract'],
      lastCommit: null,
      refs: [],
      links: [],
    },
  ],
  errors: [],
  warnings: [],
  hints: [],
  totals: { contracts: 2, tokens: 300, errors: 0, warnings: 0 },
});

const fetchMock = vi.fn(async (_path: string, _init: unknown) => {
  const body = { ok: true, value: { text: '# contract body' } };
  return new Response(JSON.stringify(body), { status: 200 });
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ContractDetail', () => {
  it('fetches the body once and renders it', async () => {
    render(<ContractDetail root="/repo" state={tree()} module="project" onRead={() => {}} />);
    await waitFor(() => expect(screen.getByText('# contract body')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders the root index, whose module is null', async () => {
    render(<ContractDetail root="/repo" state={tree()} module={null} onRead={() => {}} />);
    // `null` is a real document; it must not be read as "nothing selected".
    await waitFor(() => expect(screen.getByText('# contract body')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when the caller passes a new inline callback', async () => {
    const state = tree();
    const { rerender } = render(
      <ContractDetail root="/repo" state={state} module="project" onRead={() => {}} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Each render creates a fresh arrow, which is what the bug did implicitly.
    for (let i = 0; i < 3; i += 1) {
      rerender(<ContractDetail root="/repo" state={tree()} module="project" onRead={() => {}} />);
    }

    await waitFor(() => expect(screen.getByText('# contract body')).toBeTruthy());
    // One fetch, not four: the callback identity is not the request identity.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the read exactly once per opened contract', async () => {
    const onRead = vi.fn();
    const state = tree();
    const { rerender } = render(
      <ContractDetail root="/repo" state={state} module="project" onRead={onRead} />,
    );
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1));

    rerender(<ContractDetail root="/repo" state={tree()} module="project" onRead={onRead} />);
    // A re-render must not look like a new read: the counter is what the header
    // shows, and a flickering count was the visible symptom.
    expect(onRead).toHaveBeenCalledTimes(1);
  });
});
