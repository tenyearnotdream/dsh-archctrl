/**
 * The architecture-check button.
 *
 * It exists so ending a session with a contract check is one click. Two things
 * matter and are pinned here: it sends the prepared instruction verbatim through
 * the Session's input actions, and it stays inert when no Session is mounted
 * (nothing to type into).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { en } from '../../locale/dict';
import { makeTranslate, setTranslate } from '../../locale/index';
import { ARCH_CHECK_PROMPT, ArchCheckButton } from '../ArchCheckButton';

beforeEach(() => {
  setTranslate(makeTranslate(en));
});

function inputActions() {
  return { setDraft: vi.fn(), submit: vi.fn() };
}

describe('ArchCheckButton', () => {
  it('writes the instruction into the draft and submits it', async () => {
    const actions = inputActions();
    const user = userEvent.setup();
    render(<ArchCheckButton inputActions={actions} />);

    await user.click(screen.getByRole('button', { name: 'Check architecture' }));

    expect(actions.setDraft).toHaveBeenCalledWith(ARCH_CHECK_PROMPT);
    expect(actions.submit).toHaveBeenCalledTimes(1);
    // The draft must be written before submitting, or an empty message is sent.
    expect(actions.setDraft.mock.invocationCallOrder[0]).toBeLessThan(
      actions.submit.mock.invocationCallOrder[0] as number,
    );
  });

  it('asks the model to skip work when nothing needs to change', () => {
    // Most sessions only touch implementation detail. Without this clause the
    // check rewrites documents every time and buries real boundary changes.
    expect(ARCH_CHECK_PROMPT).toContain('本次无需更新契约');
    expect(ARCH_CHECK_PROMPT).toContain('不要为了更新而更新');
  });

  it('covers the four questions a contract check must answer', () => {
    expect(ARCH_CHECK_PROMPT).toContain('owns');
    expect(ARCH_CHECK_PROMPT).toContain('不变量');
    expect(ARCH_CHECK_PROMPT).toContain('docs/');
    expect(ARCH_CHECK_PROMPT).toContain('与现实不符');
  });

  it('is disabled without a Session to type into', () => {
    render(<ArchCheckButton />);
    const button = screen.getByRole('button', { name: 'Check architecture' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('acknowledges the click without claiming the model finished', async () => {
    const actions = inputActions();
    const user = userEvent.setup();
    render(<ArchCheckButton inputActions={actions} />);

    await user.click(screen.getByRole('button', { name: 'Check architecture' }));
    expect(screen.getByRole('button', { name: 'Sent' })).toBeTruthy();
  });
});
