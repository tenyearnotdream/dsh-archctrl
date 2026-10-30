/**
 * The drift rules.
 *
 * Everything here is deterministic and free: no model is involved, and the same
 * tree always produces the same answer. That is the part a reviewer can trust
 * without reading the code, and it is why these checks can run on every request.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { CheckResult, Issue, LagHint } from '../shared/contracts.js';
import { git, type Tree } from './tree.js';

/**
 * Generated trees. They follow their owners and never carry a decision of their
 * own, so requiring a contract for each would add documents nobody reads.
 */
const GENERATED = new Set([
  'internal/dao',
  'internal/service',
  'internal/controller',
  'internal/lib',
]);

/**
 * Does a repository path end with this citation?
 *
 * Prose often cites a path relative to a package (`api/models`) while the file
 * lives deeper (`frontend/src/api/models`). The citation is still a true
 * statement about the code; resolving it only against the repository root
 * reported every such sentence as a stale reference.
 *
 * Matching is on whole segments, so `api/models` never matches
 * `oldapi/models`, and a single-segment citation is not matched at all: it names
 * no structure, so a hit would be a coincidence.
 */
function matchesTail(root: string, citation: string): boolean {
  const segments = citation.split('/').filter(Boolean);
  if (segments.length < 2) return false;
  const suffix = `/${citation}`;
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 4) return false;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = full.slice(root.length + 1).split(sep).join('/');
      if ((rel === citation || rel.endsWith(suffix)) && (entry.isDirectory() || existsSync(full))) {
        return true;
      }
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        if (walk(full, depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}

/** A path exists in the working tree or, failing that, in HEAD. */
function pathExists(root: string, path: string): boolean {
  return existsSync(join(root, path)) || git(root, ['cat-file', '-e', `HEAD:${path}`]) !== null;
}

/** A module's owned paths minus every path a deeper module claims. */
export function effectiveOwns(tree: Tree, module: string | null): readonly string[] {
  const mine = tree.contracts.find((c) => c.module === module)?.owns ?? [];
  const deeper = tree.contracts.filter((c) => c.module !== module).flatMap((c) => c.owns);
  return mine.filter(
    (owned) => !deeper.some((other) => other !== owned && other.startsWith(`${owned}/`)),
  );
}

/**
 * Is this directory covered by a contract?
 *
 * A container whose every child is claimed counts as covered: `internal/logic`
 * holds only claimed packages and carries no decision of its own.
 */
function directoryCovered(root: string, rel: string, owned: readonly string[]): boolean {
  if (owned.some((p) => rel === p || rel.startsWith(`${p}/`))) return true;
  if (!existsSync(join(root, rel))) return false;
  let children: string[];
  try {
    children = readdirSync(join(root, rel), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${rel}/${entry.name}`);
  } catch {
    return false;
  }
  if (children.length === 0) return false;
  return children.every((child) => owned.some((p) => child === p || child.startsWith(`${p}/`)));
}

/** Run every rule over one tree. */
export function checkTree(tree: Tree): CheckResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const hints: LagHint[] = [];

  const byPath = new Map(tree.contracts.map((contract) => [contract.path, contract]));

  for (const conflict of tree.conflicts) {
    errors.push({
      rule: 'shared-ownership',
      path: conflict.path,
      message: `${conflict.path} is claimed by both "${conflict.modules[0]}" and "${conflict.modules[1]}"`,
    });
  }

  for (const contract of tree.contracts) {
    if (contract.problem !== undefined) {
      errors.push({ rule: 'frontmatter', contract: contract.path, message: contract.problem });
    }
    for (const link of contract.links) {
      // A link inside `.archctrl/` points at another contract and must resolve to
      // one: the tree is the thing being navigated. A link outside it is an
      // ordinary reference to the repository, which is checked for existence —
      // the same rule the backticked citations get — but never has to be a
      // contract. Treating both alike reported every code reference as a broken
      // link, which is what made a mature tree look broken on first open.
      if (link.startsWith('.archctrl/')) {
        if (!byPath.has(link)) {
          errors.push({
            rule: 'broken-link',
            contract: contract.path,
            message: `links to missing contract ${link}`,
          });
        }
        continue;
      }
      if (!pathExists(tree.root, link)) {
        errors.push({
          rule: 'stale-reference',
          contract: contract.path,
          message: `links to ${link}, which no longer exists`,
        });
      }
    }
    for (const owned of contract.owns) {
      if (!pathExists(tree.root, owned)) {
        errors.push({
          rule: 'stale-ownership',
          contract: contract.path,
          message: `owns ${owned}, which does not exist`,
        });
      }
    }
    for (const ref of contract.refs) {
      if (pathExists(tree.root, ref) || matchesTail(tree.root, ref)) continue;
      errors.push({
        rule: 'stale-reference',
        contract: contract.path,
        message: `references ${ref}, which no longer exists`,
      });
    }
  }

  for (const contract of tree.contracts) {
    if (contract.module === null) continue;
    const since = contract.lastCommit?.time ?? 0;
    let commits = 0;
    for (const owned of effectiveOwns(tree, contract.module)) {
      const out = git(tree.root, ['rev-list', '--count', `--since=@${since}`, 'HEAD', '--', owned]);
      if (out !== null && out !== '') commits += Number(out);
    }
    if (commits > 0) {
      hints.push({ module: contract.module, contract: contract.path, commits });
    }
  }

  const owned = [...tree.owners.keys()];
  for (const top of ['internal', 'web/src']) {
    const base = join(tree.root, top);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${top}/${entry.name}`;
      if (GENERATED.has(rel)) continue;
      if (!directoryCovered(tree.root, rel, owned)) {
        warnings.push({
          rule: 'unowned-directory',
          path: rel,
          message: `${rel} is not claimed by any contract`,
        });
      }
    }
  }

  return { errors, warnings, hints };
}
