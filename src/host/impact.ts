/**
 * Which contract owns a set of paths, and what else is affected.
 *
 * This is the one call that replaces "grep around the repository and guess which
 * contract applies". Its answer is bounded: an owning module, its contract, the
 * dependents, and nothing else.
 */

import { normalize } from 'node:path';

import type { ReviewResult, ReviewVerdict } from '../shared/contracts.js';
import { type Tree, git } from './tree.js';
import { checkTree, effectiveOwns } from './check.js';

export interface ImpactAnswer {
  readonly modules: readonly { module: string; paths: readonly string[] }[];
  readonly unmatched: readonly string[];
  /** Modules affected but not hit: ancestors and transitive dependents. */
  readonly dependents: readonly string[];
}

/** The deepest claim wins, so `web/ui` beats `web` for `web/src/components/x`. */
function ownerOf(tree: Tree, path: string): { module: string | null; owned: string } | null {
  let best: { module: string | null; owned: string } | null = null;
  for (const [owned, module] of tree.owners) {
    if (path === owned || path.startsWith(`${owned}/`)) {
      if (best === null || owned.length > best.owned.length) best = { module, owned };
    }
  }
  return best;
}

export function impact(tree: Tree, paths: readonly string[]): ImpactAnswer {
  const hits = new Map<string | null, string[]>();
  const unmatched: string[] = [];

  for (const raw of paths) {
    const path = normalize(raw).replace(/^\.\//, '');
    const owner = ownerOf(tree, path);
    if (owner === null) {
      unmatched.push(path);
      continue;
    }
    const existing = hits.get(owner.module);
    if (existing === undefined) hits.set(owner.module, [path]);
    else existing.push(path);
  }

  const modules = [...hits.entries()].map(([module, hitPaths]) => ({
    module: String(module),
    paths: hitPaths,
  }));

  // A change to a child is a change to its ancestors, and to anything that
  // depends on them, so dependents are computed transitively rather than one
  // hop: a reviewer needs to know `web` is affected when `web/ui` changes.
  const affected = new Set<string>();
  for (const hit of modules) {
    affected.add(hit.module);
    const segments = hit.module.split('/');
    while (segments.length > 1) {
      segments.pop();
      affected.add(segments.join('/'));
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const contract of tree.contracts) {
      if (contract.module === null || affected.has(contract.module)) continue;
      if (contract.depends.some((dep) => affected.has(dep))) {
        affected.add(contract.module);
        grew = true;
      }
    }
  }
  for (const hit of modules) affected.delete(hit.module);

  return { modules, unmatched, dependents: [...affected].sort() };
}

/** New or changed declarations in a diff: the shape of a change without its body. */
function signatureLines(diff: string, limit = 40): string[] {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (/^\+\s*(func|type|export|interface|class)\b/.test(line)) out.push(line.trim());
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Stages one and two: what changed, which contracts own it, and what the
 * reviewer needs to see. Never calls a model and never writes.
 *
 * The verdict is deliberately a summary, not a judgement: deciding whether an
 * invariant moved is a reading of intent, and this function cannot do that.
 */
export function reviewChanges(tree: Tree, base: string): ReviewResult {
  const range = `${base}...HEAD`;
  const read = (args: readonly string[]): string => git(tree.root, args) ?? '';
  const contractPaths = new Set(tree.contracts.map((c) => c.path));

  const changed = [
    ...new Set(
      [
        ...read(['diff', '--name-only', range]).split('\n'),
        ...read(['diff', '--name-only', 'HEAD']).split('\n'),
        ...read(['ls-files', '--others', '--exclude-standard']).split('\n'),
      ]
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    ),
  ];

  const code = changed.filter((p) => !contractPaths.has(p) && !p.startsWith('.archctrl/'));
  const contractsTouched = changed.filter((p) => contractPaths.has(p));
  const attribution = impact(tree, code);
  const checked = checkTree(tree);
  const byModule = new Map(tree.contracts.map((c) => [c.module, c]));

  const modules = attribution.modules.map((hit) => {
    const wanted = hit.module === 'null' || hit.module === '' ? null : hit.module;
    const contract = byModule.get(wanted) ?? null;
    const stat = read(['diff', '--stat', range, '--', ...hit.paths]);
    const totals = stat.split('\n').find((line) => line.includes('changed')) ?? '';
    const cited = (contract?.refs ?? []).filter((ref) =>
      hit.paths.some((p) => p === ref || p.startsWith(`${ref}/`)),
    );
    const lag = checked.hints.find((hint) => hint.module === hit.module);
    return {
      module: hit.module,
      contract: contract?.contract ?? null,
      contractTokens: contract?.tokens ?? 0,
      contractTouched: contract !== null && contractsTouched.includes(contract.path),
      paths: hit.paths,
      diffStat: totals.trim(),
      citesTouchedPaths: cited,
      commitsSinceContract: lag?.commits ?? 0,
      verifies: contract?.verifies ?? [],
      depends: contract?.depends ?? [],
    };
  });

  let signatures: string[] = [];
  if (attribution.modules.length > 0) {
    const owned = attribution.modules.flatMap((hit) => hit.paths);
    signatures = signatureLines(read(['diff', '-U0', range, '--', ...owned]));
  }

  const evidenceChars = JSON.stringify({ modules, signatureLines: signatures }).length;
  const stale = modules.filter((m) => !m.contractTouched && m.commitsSinceContract > 0);
  const cited = modules.filter((m) => m.citesTouchedPaths.length > 0);

  let verdict: ReviewVerdict;
  if (modules.length === 0 && checked.errors.length === 0) {
    verdict = 'no architectural surface changed';
  } else if (stale.length > 0) {
    verdict = 'code changed in modules whose contracts were not updated';
  } else if (cited.length > 0) {
    verdict = 'changed paths are cited by a contract; verify those invariants still hold';
  } else {
    verdict = 'contracts involved; review the listed invariants';
  }

  return {
    base,
    changedFiles: changed.length,
    codeFiles: code.length,
    contractsTouched,
    modules,
    dependents: attribution.dependents,
    unmatched: attribution.unmatched,
    errors: checked.errors,
    warnings: checked.warnings,
    signatureLines: signatures,
    estimate: { evidenceTokens: Math.ceil(evidenceChars / 3.2) },
    verdict,
  };
}

/** Re-exported so the router can report ownership without importing check.ts. */
export { effectiveOwns };
