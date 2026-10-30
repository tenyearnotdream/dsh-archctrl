/**
 * The shared vocabulary between the Host half and the browser half.
 *
 * Both sides import this module, so a field one produces is a field the other
 * can rely on. It contains no logic that needs a filesystem, a model, or a
 * request: only the shapes a contract tree is reported in.
 */

/** One contract, as the panel and the tools see it. */
export interface ContractRecord {
  /** Null for the root index (`.archctrl/arch.md`). */
  readonly module: string | null;
  /** Path relative to `.archctrl/`, e.g. `platform/http/arch.md`. */
  readonly contract: string;
  /** Repository-relative path, e.g. `.archctrl/platform/http/arch.md`. */
  readonly path: string;
  /** Approximate token count of the body, for the cost display. */
  readonly tokens: number;
  readonly bytes: number;
  readonly owns: readonly string[];
  readonly depends: readonly string[];
  readonly verifies: readonly string[];
  /** A malformed frontmatter declaration, when there is one. */
  readonly problem?: string;
  readonly lastCommit: CommitSummary | null;
  /** Repository paths the body cites in backticks. */
  readonly refs: readonly string[];
  /** Markdown links out of this document. */
  readonly links: readonly string[];
}

export interface CommitSummary {
  readonly hash: string;
  readonly time: number;
  readonly subject: string;
}

export type IssueRule =
  | 'frontmatter'
  | 'broken-link'
  | 'stale-reference'
  | 'stale-ownership'
  | 'shared-ownership'
  | 'unowned-directory';

/** A problem a reader must fix. */
export interface Issue {
  readonly rule: IssueRule;
  readonly contract?: string;
  readonly path?: string;
  readonly message: string;
}

/** Informational: code moved on since the contract was last edited. */
export interface LagHint {
  readonly module: string;
  readonly contract: string;
  readonly commits: number;
}

export interface CheckResult {
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly hints: readonly LagHint[];
}

export interface TreeTotals {
  readonly contracts: number;
  readonly tokens: number;
  readonly errors: number;
  readonly warnings: number;
}

/** Everything the browser needs to draw the tree. */
export interface TreeState {
  readonly root: string;
  readonly contracts: readonly ContractRecord[];
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly hints: readonly LagHint[];
  readonly totals: TreeTotals;
}

/** One module affected by a change set. */
export interface ImpactModule {
  readonly module: string;
  readonly contract: string | null;
  readonly contractTokens: number;
  readonly contractTouched: boolean;
  readonly paths: readonly string[];
  readonly diffStat: string;
  readonly citesTouchedPaths: readonly string[];
  readonly commitsSinceContract: number;
  readonly verifies: readonly string[];
  readonly depends: readonly string[];
}

export type ReviewVerdict =
  | 'no architectural surface changed'
  | 'code changed in modules whose contracts were not updated'
  | 'changed paths are cited by a contract; verify those invariants still hold'
  | 'contracts involved; review the listed invariants';

/** What stages one and two report, before any model is asked. */
export interface ReviewResult {
  readonly base: string;
  readonly changedFiles: number;
  readonly codeFiles: number;
  readonly contractsTouched: readonly string[];
  readonly modules: readonly ImpactModule[];
  readonly dependents: readonly string[];
  readonly unmatched: readonly string[];
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly signatureLines: readonly string[];
  readonly estimate: { readonly evidenceTokens: number };
  readonly verdict: ReviewVerdict;
}

/** One model answer about one contract. */
export interface Judgement {
  readonly module: string;
  readonly contract: string;
  /** False is a first-class answer: the contract still describes the code. */
  readonly change: boolean;
  readonly reason: string;
  /** The contract line the change is based on, when there is a change. */
  readonly basis: string;
  /** The complete replacement body, frontmatter excluded. */
  readonly body?: string;
}

/** One applied revision, committed alone. */
export interface ApplyReceipt {
  readonly path: string;
  readonly commit: string;
  readonly message: string;
}

/** A workspace the panel may read contracts from. */
export interface WorkspaceOption {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly hasContracts: boolean;
  readonly source: 'registry' | 'session' | 'host';
}

export interface WorkspacesAnswer {
  readonly items: readonly WorkspaceOption[];
  /** Per-source counts, so an empty list is distinguishable from a missing service. */
  readonly source: { readonly registry: number; readonly sessions: number };
}

/** The reading log for one conversation. */
export interface ActiveAnswer {
  readonly sessionId: string;
  readonly root: string | null;
  readonly read: readonly string[];
  readonly contracts: readonly { readonly module: string; readonly tokens: number; readonly read: boolean }[];
}

/** Envelope every route answers with. */
export type RouteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
