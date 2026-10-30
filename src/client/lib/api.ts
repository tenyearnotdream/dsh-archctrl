/**
 * The browser side of the Host routes.
 *
 * Every call unwraps the same envelope, so a component never inspects HTTP
 * status: a refusal arrives as a thrown Error with the Host's own message, which
 * is what the UI shows instead of a blank panel.
 */

import type {
  ActiveAnswer,
  ApplyReceipt,
  Diagnosis,
  RepairResult,
  ScaffoldEntry,
  CheckResult,
  ContractRecord,
  Judgement,
  ReviewResult,
  RouteAnswer,
  TreeState,
  WorkspacesAnswer,
} from '../../shared/contracts.js';

/** A refusal from the Host, carrying the stable code the UI translates. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const body = (await response.json()) as RouteAnswer<T>;
  // The Host reports a stable code; the message is a fallback, not the contract.
  if (!body.ok) throw new ApiError(body.error.code, body.error.message);
  return body.value;
}

export const api = {
  workspaces: (): Promise<WorkspacesAnswer> => post('api/archctrl/workspaces', {}),
  state: (root: string): Promise<TreeState> => post('api/archctrl/state', { root }),
  check: (root: string): Promise<CheckResult & { hints: unknown[] }> => post('api/archctrl/check', { root }),
  contract: (root: string, module: string | null): Promise<{ text: string } & ContractRecord | { text: string }> =>
    post('api/archctrl/contract', { root, module: module ?? 'root' }),
  review: (root: string, base: string): Promise<ReviewResult> => post('api/archctrl/review', { root, base }),
  judge: (root: string, module: string | null, base: string): Promise<Judgement> =>
    post('api/archctrl/judge', { root, module: module ?? 'root', base }),
  apply: (root: string, module: string | null, body: string): Promise<ApplyReceipt> =>
    post('api/archctrl/apply', { root, module: module ?? 'root', body }),
  active: (sessionId: string): Promise<ActiveAnswer> => post('api/archctrl/active', { sessionId }),
  diagnose: (root: string): Promise<Diagnosis> => post('api/archctrl/diagnose', { root }),
  repair: (
    root: string,
    apply: boolean,
    useModel = false,
  ): Promise<{
    applied: boolean;
    proposed: number;
    contested: number;
    resolved: number;
    modelNote?: string;
    results: RepairResult[];
  }> => post('api/archctrl/repair', { root, apply, useModel }),
  scaffold: (root: string, options: { apply: boolean; modules?: string[] }): Promise<{
    applied: boolean;
    plan: ScaffoldEntry[];
    written?: { path: string; commit?: string }[];
  }> => post('api/archctrl/scaffold', { root, ...options }),
};
