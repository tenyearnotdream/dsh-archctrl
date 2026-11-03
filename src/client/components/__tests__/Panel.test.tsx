/**
 * The panel's empty states.
 *
 * A repository without `.archctrl` is a normal answer from the Host, not a
 * pending read. Two failures lived here: the refusal was rendered as "Reading
 * <root>…" forever, and the screen it left behind dropped the repository
 * selector, so a reader who chose a contract-less repository could not choose
 * another one without reloading.
 *
 * The panel no longer offers to scaffold or repair a tree. Those buttons wrote
 * architecture documents from citation heuristics; a contract change is now a
 * conversation decision, triggered from the composer instead.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspacesAnswer } from '../../../shared/contracts';
import { en } from '../../locale/dict';
import { makeTranslate, setTranslate } from '../../locale/index';
import { Panel } from '../Panel';

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });

let workspaces: WorkspacesAnswer;
let stateCalls: string[];

function repository(path: string, hasContracts = false): WorkspacesAnswer['items'][number] {
  return { id: path, title: path.split('/').pop() ?? path, path, hasContracts, source: 'registry' };
}

beforeEach(() => {
  setTranslate(makeTranslate(en));
  stateCalls = [];
  workspaces = { items: [repository('/home/yaods/ai')], source: { registry: 1, sessions: 0 } };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/workspaces')) return json({ ok: true, value: workspaces });
      if (path.endsWith('/state')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { root?: string };
        stateCalls.push(body.root ?? '');
        return json({
          ok: false,
          error: { code: 'no-archctrl', message: `.archctrl was not found under ${body.root ?? ''}` },
        });
      }
      if (path.endsWith('/active')) {
        return json({ ok: true, value: { sessionId: '', root: null, read: [], contracts: [] } });
      }
      if (path.endsWith('/diagnose')) {
        return json({
          ok: true,
          value: { state: 'empty', root: '/home/yaods/ai', modules: [], contracts: [], frontmatter: [] },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Panel without a contract tree', () => {
  it('explains the missing tree instead of reading forever', async () => {
    render(<Panel />);

    // The screen states what is missing and who should fix it, and never leaves
    // the panel claiming to be mid-read.
    expect(await screen.findByText(/has no \.archctrl contract tree/)).toBeTruthy();
    expect(screen.queryByText('Reading /home/yaods/ai…')).toBeNull();
  });

  it('offers no button that writes contracts', async () => {
    render(<Panel />);

    await screen.findByText(/has no \.archctrl contract tree/);
    // The write triggers moved to the conversation; the panel must not keep a
    // shortcut that edits documents from UI state.
    for (const name of ['Set up contracts', 'Scan repository', 'Propose scope', 'Create a scaffold']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('keeps the repository selector usable after the refusal', async () => {
    workspaces = {
      items: [repository('/home/yaods/a'), repository('/home/yaods/b')],
      source: { registry: 2, sessions: 0 },
    };
    const user = userEvent.setup();
    render(<Panel />);

    // Wait for the refusal screen first: the picker only exists once the read
    // answered, and switching before that lands on the previous render.
    await screen.findByText(/has no \.archctrl contract tree/);
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(select.value).toBe('/home/yaods/a');

    await user.selectOptions(select, '/home/yaods/b');
    // The switch issues the read itself; the panel renders the missing-tree
    // screen from a branch, so waiting on the effect alone would race it.
    await waitFor(() => expect(stateCalls).toContain('/home/yaods/b'), { timeout: 3000 });
  });
});
