/**
 * Stage three: ask the conversation's own model whether a contract still holds.
 *
 * Stages one and two are deterministic and free. They can establish that a
 * module's code changed while its contract did not; they cannot tell whether a
 * design decision was violated, because that is a reading of intent.
 *
 * The model is the one the Session is already talking to. Judging an invariant
 * needs the same understanding of the design that wrote the code, and a detached
 * small model answers confidently and wrongly.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ApplyReceipt, ContractRecord, Judgement } from '../shared/contracts.js';
import { splitDocument } from './frontmatter.js';
import { type Tree, git } from './tree.js';

/**
 * The prompt is constrained against the failure mode that ruins contract trees:
 * a model asked "should this be updated?" says yes, and the documents fill with
 * a changelog nobody reads.
 */
export const JUDGE_INSTRUCTIONS = `You review whether an architecture contract still describes the code.

You are given: one contract document, the diff summary of the files it governs,
and the declarations added or changed in them.

Report a change ONLY when all three hold:
1. The diff touches a rule the contract states explicitly, not merely "code was added".
2. That rule is now false, incomplete, or requires a new exception.
3. You can quote the contract line that must change.

Otherwise answer {"change": false, "reason": "..."} and say why the contract still
holds. Do not propose edits to record that work happened: a contract is a set of
decisions, not a changelog. Never propose adding a rule the code does not already
obey, and never restate what the diff did. If a rule is merely worth rewording,
that is not a change.

When a change is required, return the COMPLETE new document body (not a patch),
keeping every unaffected line byte-identical, and list the single contract line
your change is based on.`;

/** The diff evidence a judgement is made from: stat plus declarations, not the body. */
export function evidenceFor(tree: Tree, contract: ContractRecord, base: string): string {
  const range = `${base}...HEAD`;
  const read = (args: readonly string[]): string => git(tree.root, args) ?? '';
  const owned = contract.owns.length > 0 ? contract.owns : ['.archctrl'];
  const lines = [
    read(['diff', '--stat', range, '--', ...owned]),
    read(['diff', '--stat', 'HEAD', '--', ...owned]),
    read(['diff', '-U0', range, '--', ...owned])
      .split('\n')
      .filter((line) => /^\+\s*(func|type|export|interface|class)\b/.test(line))
      .slice(0, 40)
      .join('\n'),
  ];
  return lines.join('\n').trim();
}

/** The prompt for one contract. Frontmatter is never sent: it is not the model's to edit. */
export function judgePrompt(tree: Tree, contract: ContractRecord, evidence: string): string {
  const full = readFileSync(join(tree.root, contract.path), 'utf8');
  const { body } = splitDocument(full);
  return [
    `Contract: ${contract.path}`,
    `Module: ${contract.module ?? '(root)'}`,
    `Governs: ${contract.owns.join(', ') || '(nothing declared)'}`,
    '',
    '=== CONTRACT (current) ===',
    body.trim(),
    '',
    '=== DIFF SUMMARY OF THE GOVERNED FILES ===',
    evidence.trim() || '(no diff)',
  ].join('\n');
}

/** What this Host must supply for a judgement. The DSH `llm` service satisfies it. */
export interface LlmLike {
  prepareCall(
    config: { provider: string; model: string },
    signal?: AbortSignal,
  ): Promise<{
    config: { provider: string; model: string };
    stream(options: unknown): AsyncIterable<{ type: string; text?: string }>;
  }>;
}

interface ParsedAnswer {
  change: boolean;
  reason: string;
  basis: string;
  body?: string;
}

/**
 * Read a model answer, or fail loudly.
 *
 * An answer that is not JSON, or has no boolean `change`, is an error rather than
 * an implicit "no change": silence read as approval is how a wrong contract
 * survives a review.
 */
export function parseAnswer(text: string): ParsedAnswer {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`model did not answer with JSON: ${trimmed.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    throw new Error(`model answer is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('model answer is not an object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.change !== 'boolean') {
    throw new Error('model answer has no boolean "change"');
  }
  return {
    change: record.change,
    reason: typeof record.reason === 'string' ? record.reason : '',
    basis: typeof record.basis === 'string' ? record.basis : '',
    ...(typeof record.body === 'string' ? { body: record.body } : {}),
  };
}

/** Ask the model about one contract. */
export async function judgeContract(
  llm: LlmLike,
  callConfig: { provider: string; model: string },
  tree: Tree,
  contract: ContractRecord,
  base: string,
  signal?: AbortSignal,
): Promise<Judgement> {
  const prompt = judgePrompt(tree, contract, evidenceFor(tree, contract, base));
  const prepared = await llm.prepareCall(callConfig, signal);

  let text = '';
  for await (const chunk of prepared.stream({
    provider: prepared.config.provider,
    model: prepared.config.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    system: JUDGE_INSTRUCTIONS,
    signal,
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
  }

  const answer = parseAnswer(text);
  return {
    module: String(contract.module),
    contract: contract.contract,
    change: answer.change,
    reason: answer.reason,
    basis: answer.basis,
    ...(answer.body === undefined ? {} : { body: answer.body }),
  };
}

/**
 * Write one accepted revision and commit it alone.
 *
 * The commit names only this document: an architecture decision belongs in a
 * commit a reviewer can read on its own, and keeping it out of the code commit
 * is what makes `git log` useful for both.
 */
export function applyContract(tree: Tree, contract: ContractRecord, body: string): ApplyReceipt {
  const full = join(tree.root, contract.path);
  const current = readFileSync(full, 'utf8');
  const { frontmatter } = splitDocument(current);
  const normalized = body.endsWith('\n') ? body : `${body}\n`;
  writeFileSync(full, frontmatter + normalized, 'utf8');

  if (git(tree.root, ['add', '--', contract.path]) === null) {
    throw new Error(`git add failed for ${contract.path}`);
  }
  const message = `docs(archctrl): update ${contract.module ?? 'root'} contract`;
  if (git(tree.root, ['commit', '-m', message, '--', contract.path]) === null) {
    throw new Error('git commit failed; the file was written but not committed');
  }
  const hash = git(tree.root, ['rev-parse', '--short', 'HEAD']) ?? '';
  return { path: contract.path, commit: hash, message };
}

/**
 * Ownership resolution: which contract governs which path.
 *
 * A citation says a document *mentions* a path. Ownership says a document
 * *decides* that path, and only one contract may. Deriving ownership from
 * citations alone put five contracts on `app/backend/cmd` — every one of them
 * legitimately mentions startup — so the choice has to be a reading of what each
 * document claims, which is exactly what a model can do and a regex cannot.
 */
export const OWNERSHIP_INSTRUCTIONS = `You assign code paths to architecture contracts.

For each path, choose the ONE contract that decides how that code must be built
or changed. A contract that merely mentions a path is not its owner: a startup
file is mentioned by every module but is governed by the one that defines
startup order.

Rules:
1. Exactly one contract per path. If none decides it, answer "none".
2. Prefer the narrowest contract that states a rule about the path.
3. Test and generated files belong to the contract that owns the code they
   verify or generate.
4. Answer only the JSON asked for. Never invent a contract name.`;

/** One path and the contracts that cited it. */
export interface OwnershipQuestion {
  readonly path: string;
  readonly candidates: readonly { module: string; title: string; excerpt: string }[];
}

export interface OwnershipAnswer {
  readonly path: string;
  readonly module: string | null;
  readonly because: string;
}

/** Ask the model to resolve ownership for a batch of contested paths. */
export async function resolveOwnership(
  llm: LlmLike,
  callConfig: { provider: string; model: string },
  questions: readonly OwnershipQuestion[],
  signal?: AbortSignal,
): Promise<OwnershipAnswer[]> {
  if (questions.length === 0) return [];
  const prompt = [
    'Resolve ownership for these paths.',
    '',
    ...questions.map((q) =>
      [
        `PATH: ${q.path}`,
        ...q.candidates.map((c) => `  - ${c.module}: ${c.title}\n    ${c.excerpt}`),
      ].join('\n'),
    ),
    '',
    'Answer with JSON only:',
    '{"answers":[{"path":"...","module":"<module or null>","because":"<one clause>"}]}',
  ].join('\n');

  const prepared = await llm.prepareCall(callConfig, signal);
  let text = '';
  for await (const chunk of prepared.stream({
    provider: prepared.config.provider,
    model: prepared.config.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    system: OWNERSHIP_INSTRUCTIONS,
    signal,
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('ownership answer is not JSON');
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  const answers = (parsed as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) throw new Error('ownership answer has no "answers" array');
  return answers
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      path: typeof entry.path === 'string' ? entry.path : '',
      module: typeof entry.module === 'string' && entry.module !== '' && entry.module !== 'none' ? entry.module : null,
      because: typeof entry.because === 'string' ? entry.because : '',
    }))
    .filter((answer) => answer.path !== '');
}
