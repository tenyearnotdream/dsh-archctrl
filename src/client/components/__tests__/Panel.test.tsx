/**
 * The panel's empty states.
 *
 * A repository without `.archctrl` is a normal answer from the Host, not a
 * pending read. Two failures lived here: the refusal was rendered as "Reading
 * <root>…" forever, and the screen it left behind dropped the repository
 * selector, so a reader who chose a contract-less repository could not choose
 * another one without reloading. Onboarding, which exists for exactly this
 * case, was unreachable behind both.
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
  it('reports the refusal instead of reading forever', async () => {
    render(<Panel />);

    expect(await screen.findByText('archctrl: This repository has no .archctrl directory.')).toBeTruthy();
    expect(screen.queryByText('Reading /home/yaods/ai…')).toBeNull();
  });

  it('keeps onboarding reachable for the contract-less repository', async () => {
    const user = userEvent.setup();
    render(<Panel />);

    await user.click(await screen.findByRole('button', { name: 'Set up contracts' }));
    await user.click(await screen.findByRole('button', { name: 'Scan repository' }));

    // The diagnosis answers "empty", which is the flow's own wording, not the
    // refusal prefixed by "archctrl:".
    expect(await screen.findByText('This repository has no .archctrl directory.')).toBeTruthy();
  });

  it('keeps the repository selector usable after the refusal', async () => {
    workspaces = {
      items: [repository('/home/yaods/a'), repository('/home/yaods/b')],
      source: { registry: 2, sessions: 0 },
    };
    const user = userEvent.setup();
    render(<Panel />);

    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(select.value).toBe('/home/yaods/a');

    await user.selectOptions(select, '/home/yaods/b');
    await waitFor(() => expect(stateCalls).toContain('/home/yaods/b'));
  });
});
