/**
 * The architecture-check button, under the composer next to the read strip.
 *
 * It hands the conversation one prepared instruction and sends it, so ending a
 * session with a contract check is one click instead of hand-written prompt
 * text. The instruction is authoritative and lives here rather than in a
 * template the operator edits: the point is that every session asks the same
 * question, including the part that tells the model when nothing needs to
 * change.
 *
 * This is the only write trigger the panel leaves to the user. The tools that
 * guessed scope or wrote revisions from UI state are gone on purpose: a contract
 * change should be a decision the conversation makes and the operator reads,
 * not something a panel button infers from citations.
 */

import { useState } from 'react';

import { Button } from './ui/button.js';
import { t } from '../locale/index.js';

/**
 * The instruction typed into the composer.
 *
 * Kept as one string so the button cannot drift from what a reviewer expects.
 * The final paragraph matters most: most sessions only change implementation
 * detail, and a check that always rewrites documents is worse than no check,
 * because it buries real boundary changes in noise.
 */
export const ARCH_CHECK_PROMPT = [
  '检查本次会话的代码改动与 .archctrl 契约是否一致。',
  '',
  '先看 git status 和 git diff（必要时对比基线 tag），逐项判断：',
  '1. 是否有新模块、新目录或新的职责边界没有被任何契约 owns 声明；',
  '2. 是否改动了某份契约里写明的不变量、所有权或失败语义；',
  '3. 是否需要同步 docs/ 下的实现手册；',
  '4. 改动是否让契约里的描述与现实不符。',
  '',
  '如果改动只是实现细节、没有触及边界或不变量，直接说明"本次无需更新契约"即可，',
  '不要为了更新而更新，也不要重写没受影响的段落。',
  '',
  '需要更新时，按 AGENTS.md 与 docs/maintenance/architecture-control.md 的维护协议改，',
  '契约改动单独提交，并在回复里说明改了哪份、为什么。',
].join('\n');

export interface ArchCheckButtonProps {
  /**
   * The Session's public input actions. Absent before a Session exists, which is
   * also when an immediately-sent instruction would have nowhere to go.
   */
  readonly inputActions?: {
    setDraft(text: string): void;
    submit(): void;
  };
  /** Session id, used only as a React key input so a switch re-enables the button. */
  readonly sessionId?: string;
}

export function ArchCheckButton({ inputActions, sessionId = '' }: ArchCheckButtonProps = {}) {
  const [sent, setSent] = useState(false);

  // Without a Session there is no draft to fill, so the control stays inert
  // rather than looking clickable and doing nothing.
  const disabled = inputActions === undefined;
  const label = sent ? t('check.sent') : t('check.action');

  function run(): void {
    if (inputActions === undefined) return;
    setSent(true);
    inputActions.setDraft(ARCH_CHECK_PROMPT);
    inputActions.submit();
    // The acknowledgement is short-lived: it reports that the click landed, not
    // that the model finished, which the conversation itself shows.
    window.setTimeout(() => setSent(false), 2500);
  }

  return (
    <Button
      size="sm"
      // `secondary` rather than `ghost`: in the tool row a borderless button
      // disappears among the statistics, and this one has to be found at the end
      // of a session rather than hunted for.
      variant="secondary"
      // `key` resets `sent` when the operator switches Session, so a stale
      // "已发送" never follows them into an unrelated conversation.
      key={sessionId}
      disabled={disabled}
      title={t('check.title')}
      onClick={run}
    >
      <ShieldIcon />
      {label}
    </Button>
  );
}

/** A shield, the smallest mark that reads as "check the rules". */
function ShieldIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3"
    >
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
