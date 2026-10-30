/**
 * Onboarding: bringing a repository that was never written for this plugin into
 * a state the plugin can check.
 *
 * Two problems are worth separating, because they need different answers:
 *
 * - **A tree that has no scope declarations.** The documents are fine; they just
 *   never said what they govern. That is mechanical: derive `owns` from the
 *   paths each contract already cites, and write the frontmatter.
 * - **A repository with no `.archctrl` at all.** There is nothing to derive from,
 *   so the honest answer is a scaffold of empty contracts the author fills in —
 *   never invented rules, because a contract invented by a tool is a rule nobody
 *   decided.
 *
 * Neither writes on its own: both return a proposal the panel shows as a diff.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { ContractRecord } from '../shared/contracts.js';
import type { OwnershipQuestion } from './judge.js';
import { toPosix, type Tree } from './tree.js';

/** A directory that looks like a module in a Go/TS repository. */
const CANDIDATE_ROOTS = ['internal', 'app', 'src', 'cmd', 'web/src', 'frontend/src', 'lib', 'pkg'];

/**
 * Paths a contract may govern.
 *
 * A contract governs code. A link to `docs/` is a reference for the reader, and
 * a skill directory belongs to the tooling — claiming either would put
 * documentation inside the ownership map, where it only creates collisions.
 */
const GOVERNABLE = /^(internal|app|frontend|web|cmd|resource|scripts|lib|pkg|src)\//;

/** Directories that never belong to a contract of their own. */
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  'internal/dao',
  'internal/service',
  'internal/controller',
  'internal/packed',
]);

/**
 * The most specific existing ancestor of a cited path.
 *
 * A citation may name a file (`internal/middleware/auth.go`) or a directory. A
 * contract governs directories, so a file is reduced to the directory that holds
 * it — once that directory exists, otherwise one level up.
 */
function governingDirectory(repoRoot: string, cited: string): string | null {
  let candidate = cited.replace(/\/+$/, '');
  if (!GOVERNABLE.test(candidate)) return null;
  if (IGNORED.has(candidate)) return null;
  for (let depth = 0; depth < 4; depth += 1) {
    const full = join(repoRoot, candidate);
    if (existsSync(full)) {
      try {
        if (statSync(full).isDirectory()) return candidate;
      } catch {
        return null;
      }
    }
    const parent = dirname(candidate);
    if (parent === '.' || parent === '') return null;
    candidate = toPosix(parent);
  }
  return null;
}

/**
 * Drop a path when a shorter one covers it.
 *
 * `internal/dao` plus `internal/dao/tag` becomes one entry: the child adds no
 * decision when the parent is already governed.
 */
function pruneNested(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const path of sorted) {
    if (kept.some((parent) => path === parent || path.startsWith(`${parent}/`))) continue;
    kept.push(path);
  }
  return kept.sort();
}

/** A module a scaffold would create, from the repository's own layout. */
export interface ScaffoldModule {
  /** Directory the contract lives in, relative to `.archctrl/`. */
  readonly module: string;
  /** Paths the contract would govern. */
  readonly owns: readonly string[];
  /** One line of evidence: why this directory was chosen. */
  readonly because: string;
}

/**
 * Propose a module tree for a repository that has no contracts.
 *
 * The choice is structural, not semantic: each top-level source directory that
 * holds real code becomes a module, because that is the only grouping the
 * repository itself already made. Naming and boundaries stay the author's job —
 * the scaffold ships boundaries with no rules in them.
 */
export function proposalModules(repoRoot: string): ScaffoldModule[] {
  const found: ScaffoldModule[] = [];
  for (const root of CANDIDATE_ROOTS) {
    const base = join(repoRoot, root);
    if (!existsSync(base)) continue;
    let entries: { name: string; dir: boolean }[];
    try {
      entries = readdirSync(base, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED.has(`${root}/${entry.name}`)) continue;
      const path = `${root}/${entry.name}`;
      if (entry.dir) {
        found.push({ module: path.replace(/^(internal|app|src|lib|pkg)\//, ''), owns: [path], because: `${path}/ exists` });
      }
    }
  }
  return found;
}

/**
 * Propose frontmatter for contracts that have none.
 *
 * Ownership is derived from what the document already cites in backticks: a
 * contract that names `internal/middleware/auth.go` plainly intends to govern
 * that code, so the tool is recording a decision the author already made rather
 * than making one.
 */
export interface FrontmatterProposal {
  readonly module: string | null;
  readonly contract: string;
  readonly owns: readonly string[];
  /** Citations that resolved to no existing path, so nothing was derived. */
  readonly unresolved: readonly string[];
}

export function proposeFrontmatter(tree: Tree): FrontmatterProposal[] {
  const out: FrontmatterProposal[] = [];
  for (const contract of tree.contracts) {
    if (contract.module === null && contract.contract !== 'arch.md') continue;
    if (contract.owns.length > 0) continue;
    const derived: string[] = [];
    const unresolved: string[] = [];
    // Both citation styles count: a backticked path and a Markdown link to a
    // file are the same statement about the code. A tree written by hand usually
    // has the links and no backticks, so ignoring them derived almost nothing.
    for (const cited of [...contract.refs, ...contract.links.map(stripArchctrlPrefix)]) {
      if (cited === '') continue;
      const directory = governingDirectory(tree.root, cited);
      if (directory === null) unresolved.push(cited);
      else derived.push(directory);
    }
    out.push({
      module: contract.module,
      contract: contract.contract,
      owns: pruneNested(derived),
      unresolved: [...new Set(unresolved)].sort(),
    });
  }
  return out;
}

/** A link inside `.archctrl/` is a sibling contract, not a code reference. */
function stripArchctrlPrefix(link: string): string {
  return link.startsWith('.archctrl/') ? '' : link;
}

/** Render the frontmatter block for one contract. */
export function renderFrontmatter(owns: readonly string[], depends: readonly string[] = []): string {
  const list = (key: string, values: readonly string[]): string =>
    values.length === 0 ? `${key}: []\n` : `${key}:\n${values.map((v) => `  - ${v}\n`).join('')}`;
  return `---\n${list('owns', owns)}${list('depends', depends)}---\n\n`;
}

/** Insert frontmatter above a document that has none. */
export function withFrontmatter(source: string, block: string): string {
  if (source.startsWith('---\n')) return source;
  return `${block}${source}`;
}

/**
 * A contract skeleton for a module the repository layout implies.
 *
 * The body states only what is true without knowing the design: this directory
 * exists, and these paths are in it. Every sentence that would be a decision is
 * left as a prompt for the author.
 */
export function scaffoldContract(module: string, owns: readonly string[]): string {
  const title = module === '' ? 'Architecture contracts' : module;
  const scope = owns.length === 0 ? '(none declared)' : owns.join(', ');
  return [
    renderFrontmatter(owns).trimEnd(),
    '',
    `# ${title}`,
    '',
    `> Scaffolded by archctrl from the repository layout. Replace this note with`,
    `> the boundary this module must hold; nothing below is a decision yet.`,
    '',
    `Governs: ${scope}`,
    '',
    '## 边界',
    '',
    '- 这个模块负责什么、不负责什么？',
    '- 哪些不变量一旦被违背就需要显式决策？',
    '',
    '## 验证',
    '',
    '- 哪些测试证明上面的约束仍然成立？',
    '',
  ].join('\n');
}

/** Where a scaffolded contract for one module would live. */
export function scaffoldPath(module: string): string {
  return module === '' ? '.archctrl/arch.md' : `.archctrl/${module}/arch.md`;
}

/** A path inside the repository, for display. */
export function displayPath(repoRoot: string, path: string): string {
  return toPosix(relative(resolve(repoRoot), resolve(repoRoot, path)));
}

/** Contracts that already declare scope, so a proposal leaves them alone. */
export function alreadyScoped(contract: ContractRecord): boolean {
  return contract.owns.length > 0;
}

// ---------------------------------------------------------------------------
// Conflicts
//
// Deriving scope from citations is mechanical and free, and it is also naive:
// a startup file is mentioned by every contract that runs at startup while
// exactly one of them decides its shape. Those paths are the ones worth a model
// call, and separating them first keeps the cost proportional to the ambiguity
// instead of the size of the tree.
// ---------------------------------------------------------------------------

/** A path two or more contracts would claim from their own citations. */
export interface ContestedPath {
  readonly path: string;
  /** Contract paths that would claim it, in tree order. */
  readonly contracts: readonly string[];
}

/** Paths that more than one proposal would claim. */
export function contestedPaths(proposals: readonly FrontmatterProposal[]): ContestedPath[] {
  const claims = new Map<string, string[]>();
  for (const proposal of proposals) {
    for (const owned of proposal.owns) {
      const existing = claims.get(owned);
      if (existing === undefined) claims.set(owned, [proposal.contract]);
      else if (!existing.includes(proposal.contract)) existing.push(proposal.contract);
    }
  }
  return [...claims.entries()]
    .filter(([, contracts]) => contracts.length > 1)
    .map(([path, contracts]) => ({ path, contracts }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The evidence a model needs to choose an owner.
 *
 * Two things only: what each candidate document calls itself, and the lines
 * where it mentions the path. A full contract would be several thousand tokens
 * per question, and the sentence that names the path is what decides it — a
 * document that says "启动顺序由本契约规定" owns the startup file even though five
 * others link to it.
 */
export function ownershipQuestions(
  tree: Tree,
  contested: readonly ContestedPath[],
  excerptLimit = 2,
): OwnershipQuestion[] {
  return contested.map((entry) => ({
    path: entry.path,
    candidates: entry.contracts.map((contractPath) => {
      // `contract` is relative to `.archctrl/`, which is the form both the tree
      // and the panel use; the file itself needs the directory.
      const full = join(tree.root, '.archctrl', contractPath);
      // A proposal names a document that was just read, so a failure here can
      // only be a race with an editor; the evidence degrades to its title.
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        text = '';
      }
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? contractPath;
      const stem = entry.path.split('/').pop() ?? entry.path;
      const excerpt = text
        .split('\n')
        .filter((line) => line.includes(entry.path) || line.includes(stem))
        .slice(0, excerptLimit)
        .map((line) => line.trim())
        .join(' / ');
      return {
        module: contractPath.replace(/\/arch\.md$/, '').replace(/^arch\.md$/, '(root)'),
        title,
        excerpt: excerpt === '' ? '(no direct mention)' : excerpt,
      };
    }),
  }));
}

/**
 * Fold the model's answers back into the proposals.
 *
 * A contested path goes to the single contract the model chose and is removed
 * from every other one. A path it declined to assign is removed everywhere: an
 * unowned path is a warning the author can act on, while a path two contracts
 * both claim is an error that blocks the whole tree.
 */
export function applyOwnershipAnswers(
  proposals: readonly FrontmatterProposal[],
  answers: readonly { path: string; module: string | null; because: string }[],
): FrontmatterProposal[] {
  const decided = new Map<string, string | null>();
  for (const answer of answers) decided.set(answer.path, answer.module);
  if (decided.size === 0) return [...proposals];

  return proposals.map((proposal) => {
    const module = proposal.module ?? '(root)';
    const kept = proposal.owns.filter((owned) => {
      if (!decided.has(owned)) return true;
      return decided.get(owned) === module;
    });
    return { ...proposal, owns: kept };
  });
}
