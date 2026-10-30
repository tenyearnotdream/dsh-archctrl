/**
 * Reading the contract tree off disk.
 *
 * Every call re-reads the files: contracts change while a session runs, and a
 * tree that is stale about `arch.md` is worse than one that takes a millisecond
 * longer, because the whole point is saying what is true now.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

import type { CommitSummary, ContractRecord } from '../shared/contracts.js';
import { parseFrontmatter } from './frontmatter.js';

/** A repository path a contract cites in backticks. */
const PATH_PREFIXES = /^(internal|test|web|resource|docs|api|cmd|scripts|hack|plugins)\//;
const SKIP_PATTERNS = /[*{]/;

export interface Tree {
  readonly root: string;
  /** Every tracked path in the repository, for suffix matching of citations. */
  readonly repoPaths?: ReadonlySet<string>;
  readonly contracts: readonly ContractRecord[];
  /** Owned path -> owning module (null for the root index). */
  readonly owners: ReadonlyMap<string, string | null>;
  /** Paths two contracts both claim. */
  readonly conflicts: readonly { path: string; modules: readonly string[] }[];
}

/** Split a path into its POSIX form, so Windows hosts report the same tree. */
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Run git in a repository and return stdout, or null when git cannot answer. */
export function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Every Markdown document under `.archctrl/`, sorted.
 *
 * A directory owns one contract, `arch.md`. Any other document beside it is a
 * supplement the contract links to — a query manual, a decision log — and is
 * part of the tree even though it carries no scope of its own. Ignoring those
 * files reported a link to them as broken, which is a tree that was complete
 * looking broken.
 */
function listContractFiles(archDir: string): { path: string; primary: boolean }[] {
  const found: { path: string; primary: boolean }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        found.push({ path: full, primary: entry.name === 'arch.md' });
      }
    }
  };
  walk(archDir);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * `platform/http/arch.md` -> `platform/http`; the root index is null.
 *
 * A supplement such as `query/semantics.md` belongs to the module it sits in,
 * so it reports that module but carries no scope: only `arch.md` declares
 * ownership, and a supplement must never add a second claimant for one path.
 */
function moduleOfContract(relativePath: string, primary: boolean): string | null {
  if (!primary) {
    const slash = relativePath.lastIndexOf('/');
    return slash < 0 ? null : relativePath.slice(0, slash);
  }
  return relativePath === 'arch.md' ? null : relativePath.slice(0, -'/arch.md'.length);
}

/**
 * Tokens are how the plugin reports cost, so the estimate must be stable and
 * cheap rather than exact: CJK characters are one token each, the rest roughly
 * four characters per token.
 */
export function approximateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.round(cjk + (text.length - cjk) / 3.6);
}

/**
 * Repository paths a contract cites.
 *
 * A backticked span may hold a command, so its words are scanned for the first
 * that starts like a repository path: `node scripts/x.mjs check` contributes the
 * script, while `make check` contributes nothing.
 */
export function referencedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = (match[1] ?? '').trim();
    if (SKIP_PATTERNS.test(token) || token.includes('NNNNNN')) continue;
    const word = token.split(/\s+/).find((candidate) => PATH_PREFIXES.test(candidate));
    if (word === undefined) continue;
    out.add(word.replace(/\/+$/, ''));
  }
  return [...out];
}

function lastCommitOf(root: string, contractPath: string): CommitSummary | null {
  const out = git(root, ['log', '-1', '--format=%H%x09%ct%x09%s', '--', contractPath]);
  if (out === null || out === '') return null;
  const [hash, time, subject] = out.split('\t');
  if (hash === undefined || time === undefined) return null;
  return { hash, time: Number(time), subject: subject ?? '' };
}

/** Read the whole tree for one repository, or null when it has no contracts. */
export function readTree(root: string): Tree | null {
  const archDir = join(root, '.archctrl');
  if (!existsSync(archDir) || !statSync(archDir).isDirectory()) return null;

  const contracts: ContractRecord[] = [];
  for (const { path: full, primary } of listContractFiles(archDir)) {
    const rel = toPosix(relative(archDir, full));
    const text = readFileSync(full, 'utf8');
    const head = parseFrontmatter(text);

    const links: string[] = [];
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = (match[1] ?? '').split('#')[0] ?? '';
      if (target === '' || /^[a-z]+:/i.test(target)) continue;
      links.push(toPosix(relative(root, normalize(join(dirname(full), target)))));
    }

    const contractPath = toPosix(relative(root, full));
    contracts.push({
      module: moduleOfContract(rel, primary),
      contract: rel,
      path: contractPath,
      tokens: approximateTokens(head.body),
      bytes: Buffer.byteLength(text),
      owns: head.owns,
      depends: head.depends,
      verifies: head.verifies,
      ...(head.problem === undefined ? {} : { problem: head.problem }),
      lastCommit: lastCommitOf(root, `.archctrl/${rel}`),
      refs: referencedPaths(text),
      links,
    });
  }

  const owners = new Map<string, string | null>();
  const conflicts: { path: string; modules: string[] }[] = [];
  for (const contract of contracts) {
    if (contract.owns.length === 0) continue;
    for (const owned of contract.owns) {
      const prior = owners.get(owned);
      if (prior !== undefined && prior !== contract.module) {
        conflicts.push({ path: owned, modules: [String(prior), String(contract.module)] });
      } else {
        owners.set(owned, contract.module);
      }
    }
  }

  return { root, contracts, owners, conflicts };
}
