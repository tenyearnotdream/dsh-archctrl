/**
 * The right rail is Session-scoped.
 *
 * It used to ask the global workspace list which repository to read, so it kept
 * showing whichever repository came first — after switching to a conversation
 * in another workspace, the tab still reported on the old one. These tests pin
 * that the rail reads the owning Session's cwd and follows it when the Session
 * changes.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TreeState } from '../../../shared/contracts';
import { en } from '../../locale/dict';
import { makeTranslate, setTranslate } from '../../locale/index';
import { RightTab } from '../RightTab';

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });

const tree = (root: string): TreeState => ({
  root,
  contracts: [
    {
      module: 'project',
      contract: 'project/arch.md',
      path: '.archctrl/project/arch.md',
      tokens: 10,
      bytes: 100,
      owns: ['internal/project'],
      depends: [],
      verifies: [],
      lastCommit: null,
      refs: [],
      links: [],
    },
  ],
  errors: [],
  warnings: [],
  hints: [],
  totals: { contracts: 1, tokens: 10, errors: 0, warnings: 0 },
});

let stateCalls: string[];

/** A stand-in for the slot's `useSessions` selector. */
const sessions =
  (byId: Record<string, { cwd?: string }>) =>
  <Selected,>(selector: (state: { byId: Record<string, { cwd?: string }> }) => Selected): Selected =>
    selector({ byId });

beforeEach(() => {
  setTranslate(makeTranslate(en));
  stateCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/workspaces')) {
        return json({
          ok: true,
          value: {
            items: [
              { id: '/home/yaods/ai', title: 'ai', path: '/home/yaods/ai', hasContracts: false, source: 'registry' },
              { id: '/home/yaods/project', title: 'project', path: '/home/yaods/project', hasContracts: true, source: 'registry' },
            ],
            source: { registry: 2, sessions: 0 },
          },
        });
      }
      if (path.endsWith('/state')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { root?: string };
        const root = body.root ?? '';
        stateCalls.push(root);
        if (root === '/home/yaods/project') return json({ ok: true, value: tree(root) });
        return json({
          ok: false,
          error: { code: 'no-archctrl', message: `.archctrl was not found under ${root}` },
        });
      }
      if (path.endsWith('/active')) {
        return json({ ok: true, value: { sessionId: 's', root: null, read: [], contracts: [] } });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RightTab session binding', () => {
  it('reads the owning Session workspace, not the first registered one', async () => {
    render(
      <RightTab sessionId="s1" useSessions={sessions({ s1: { cwd: '/home/yaods/project' } })} />,
    );

    await waitFor(() => expect(stateCalls).toContain('/home/yaods/project'));
    expect(stateCalls).not.toContain('/home/yaods/ai');
    expect(await screen.findByText('/home/yaods/project')).toBeTruthy();
  });

  it('moves to the new workspace when the Session changes', async () => {
    const { rerender } = render(
      <RightTab sessionId="s1" useSessions={sessions({ s1: { cwd: '/home/yaods/project' } })} />,
    );
    await screen.findByText('/home/yaods/project');

    rerender(
      <RightTab sessionId="s2" useSessions={sessions({ s2: { cwd: '/home/yaods/ai' } })} />,
    );

    expect(
      await screen.findByText('archctrl: This repository has no .archctrl directory.'),
    ).toBeTruthy();
    expect(screen.queryByText('/home/yaods/project')).toBeNull();
    expect(stateCalls).toContain('/home/yaods/ai');
  });

  it('waits for the Session workspace instead of borrowing another repository', async () => {
    render(<RightTab sessionId="s1" useSessions={sessions({})} />);

    expect(await screen.findByText('Locating this session’s workspace…')).toBeTruthy();
    expect(stateCalls).toEqual([]);
  });
});
