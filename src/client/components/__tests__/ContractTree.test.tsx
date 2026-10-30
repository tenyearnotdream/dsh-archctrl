/**
 * The tree is the one view a reader uses constantly, so its ordering and depth
 * rules are pinned here: a module's depth comes from the directory layout, and
 * the root index sorts before every module.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ContractTree, flatten, statusOf } from '../ContractTree';
import { en } from '../../locale/dict';
import { makeTranslate, setTranslate } from '../../locale/index';
import type { TreeState } from '../../../shared/contracts';

/** Components read the module-level translator the Host installs in `apply`. */
function installTranslator(): void {
  setTranslate(makeTranslate(en));
}

const contract = (module: string | null, tokens = 100) => ({
  module,
  contract: module === null ? 'arch.md' : `${module}/arch.md`,
  path: module === null ? '.archctrl/arch.md' : `.archctrl/${module}/arch.md`,
  tokens,
  bytes: 400,
  owns: [],
  depends: [],
  verifies: [],
  lastCommit: null,
  refs: [],
  links: [],
});

const state = (overrides: Partial<TreeState> = {}): TreeState => ({
  root: '/repo',
  contracts: [contract(null), contract('project'), contract('platform'), contract('platform/http')],
  errors: [],
  warnings: [],
  hints: [],
  totals: { contracts: 4, tokens: 400, errors: 0, warnings: 0 },
  ...overrides,
});

describe('flatten', () => {
  it('puts the root index first and derives depth from the layout', () => {
    const rows = flatten(state());
    expect(rows.map((row) => [row.contract.module, row.depth])).toEqual([
      [null, 0],
      ['platform', 1],
      ['platform/http', 2],
      ['project', 1],
    ]);
  });

  it('treats a module whose parent has no contract as top level', () => {
    const rows = flatten(
      state({
        contracts: [contract(null), contract('web/ui')],
      }),
    );
    expect(rows.map((row) => row.depth)).toEqual([0, 1]);
  });
});

describe('statusOf', () => {
  it('reports an error before a warning before lag', () => {
    const withError = state({ errors: [{ rule: 'broken-link', contract: '.archctrl/project/arch.md', message: 'x' }] });
    expect(statusOf(withError, 'project')).toBe('error');

    const withWarning = state({ warnings: [{ rule: 'unowned-directory', path: 'internal/x', message: 'x' }] });
    expect(statusOf(withWarning, 'project')).toBe('ok');

    const withHint = state({ hints: [{ module: 'project', contract: '.archctrl/project/arch.md', commits: 2 }] });
    expect(statusOf(withHint, 'project')).toBe('lag');
  });

  it('reports an unknown module as clean rather than throwing', () => {
    expect(statusOf(state(), 'ghost')).toBe('ok');
  });
});

describe('ContractTree', () => {
  it('renders every row, always expanded, with its token count', () => {
    installTranslator();
    render(<ContractTree state={state()} selected={undefined} onSelect={() => {}} read={new Set()} />);
    expect(screen.getByText('arch.md')).toBeTruthy();
    expect(screen.getByText('platform/http')).toBeTruthy();
    expect(screen.getAllByText('100')).toHaveLength(4);
  });

  it('marks a contract the conversation has read', () => {
    installTranslator();
    render(<ContractTree state={state()} selected={undefined} onSelect={() => {}} read={new Set(['project'])} />);
    // The title comes from the dictionary, so this also proves the translator is
    // wired in: an unregistered `t` would render the raw key.
    expect(screen.getAllByTitle('read in this session')).toHaveLength(1);
  });
});
