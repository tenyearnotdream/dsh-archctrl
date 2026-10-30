/**
 * Turn a Host refusal into text in the active language.
 *
 * Every route answers with a stable `code`; the English `message` beside it is
 * for logs and for a code this build has not translated yet. Showing the message
 * directly would leave the UI in English on a Chinese Host, which is exactly the
 * defect this module exists to prevent.
 */

import { ApiError } from './api.js';
import { t } from '../locale/index.js';

export function describeError(cause: unknown): string {
  if (cause instanceof ApiError) {
    const key = `error.${cause.code}`;
    const translated = t(key, { message: cause.message });
    // `t` returns the key itself when it is unknown; fall back to the Host's own
    // message rather than showing `error.some-new-code`.
    return translated === key ? cause.message : translated;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
