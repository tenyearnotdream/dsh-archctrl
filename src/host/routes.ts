/**
 * The Fetch routes the browser half reads.
 *
 * Every route answers with the same envelope, so a caller never has to guess
 * whether a failure is a transport error or a refusal. Each one re-reads the tree
 * rather than caching: the panel must show the files as they are.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  ActiveAnswer,
  RouteAnswer,
  TreeState,
  WorkspacesAnswer,
} from '../shared/contracts.js';
import { checkTree } from './check.js';
import {
  applyOwnershipAnswers,
  contestedPaths,
  ownershipQuestions,
  proposalModules,
  proposeFrontmatter,
  renderFrontmatter,
  scaffoldContract,
  scaffoldPath,
  withFrontmatter,
} from './onboard.js';
import { applyContract, judgeContract, resolveOwnership, type LlmLike } from './judge.js';
import { impact, reviewChanges } from './impact.js';
import { git as gitCommit } from './tree.js';
import { readTree } from './tree.js';

export const ROUTES = {
  state: '/api/archctrl/state',
  check: '/api/archctrl/check',
  contract: '/api/archctrl/contract',
  review: '/api/archctrl/review',
  propose: '/api/archctrl/propose',
  judge: '/api/archctrl/judge',
  apply: '/api/archctrl/apply',
  workspaces: '/api/archctrl/workspaces',
  active: '/api/archctrl/active',
  // Onboarding: diagnose a tree that was written by hand, then propose the
  // frontmatter it is missing or a scaffold for a repository that has none.
  diagnose: '/api/archctrl/diagnose',
  repair: '/api/archctrl/repair',
  scaffold: '/api/archctrl/scaffold',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

/** What a route may use beyond the request. */
export interface RouteRuntime {
  /** Model service, when the Host supplies one. */
  readonly llm?: LlmLike;
  /** The model of the Session that asked; absent before its first message. */
  readonly llmConfig?: { provider: string; model: string };
}

export interface RouteServices {
  /** Resolve the repository a request is about. */
  resolveRoot(request: Request, body: Record<string, unknown>): string | undefined;
  /** Registered workspaces, when the profile has the registry. */
  workspaces?(): WorkspacesAnswer['items'];
  /** Live sessions, used when the registry is absent. */
  sessionDirectories?(): readonly string[];
  /** The Host's own working directory, the last fallback. */
  hostDirectory?(): string | undefined;
  /** Modules this conversation has opened. */
  readModules(sessionId: string): readonly string[];
}

export type RouteHandler = (request: Request, runtime: RouteRuntime) => Promise<Response>;

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

const ok = <T>(value: T): Response => json({ ok: true, value } satisfies RouteAnswer<T>);

const fail = (code: string, message: string): Response =>
  json({ ok: false, error: { code, message } } satisfies RouteAnswer<never>);

/**
 * Read a JSON body, tolerating an absent or malformed one.
 *
 * A route must answer with its own diagnostic rather than throwing on a bad
 * body: "the panel sent nothing" is a bug worth reporting, not a 500.
 */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== 'POST') return {};
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Build every route for one mounted plugin. */
export function createRoutes(services: RouteServices): Record<RoutePath, RouteHandler> {
  const requireTree = (root: string | undefined) => (root === undefined ? null : readTree(root));

  return {
    [ROUTES.workspaces]: async () => {
      const collected: WorkspacesAnswer['items'][number][] = [];
      const seen = new Set<string>();

      for (const workspace of services.workspaces?.() ?? []) {
        if (seen.has(workspace.path)) continue;
        seen.add(workspace.path);
        collected.push(workspace);
      }
      const registryCount = collected.length;

      // A profile composed without the workspace registry still has sessions, and
      // a session knows the directory it runs in.
      for (const directory of services.sessionDirectories?.() ?? []) {
        if (seen.has(directory)) continue;
        seen.add(directory);
        collected.push({
          id: directory,
          title: directory.split('/').filter(Boolean).pop() ?? directory,
          path: directory,
          hasContracts: false,
          source: 'session',
        });
      }

      if (collected.length === 0) {
        const host = services.hostDirectory?.();
        if (host !== undefined && host !== '') {
          collected.push({
            id: host,
            title: host.split('/').filter(Boolean).pop() ?? host,
            path: host,
            hasContracts: false,
            source: 'host',
          });
        }
      }

      return ok<WorkspacesAnswer>({
        items: collected,
        source: { registry: registryCount, sessions: collected.length - registryCount },
      });
    },

    [ROUTES.state]: async (request) => {
      const root = services.resolveRoot(request, await readBody(request));
      if (root === undefined) return fail('no-root', 'no working directory');
      const tree = requireTree(root);
      if (tree === null) return fail('no-archctrl', `.archctrl was not found under ${root}`);
      const checked = checkTree(tree);
      return ok<TreeState>({
        root: tree.root,
        contracts: tree.contracts,
        errors: checked.errors,
        warnings: checked.warnings,
        hints: checked.hints,
        totals: {
          contracts: tree.contracts.length,
          tokens: tree.contracts.reduce((sum, c) => sum + c.tokens, 0),
          errors: checked.errors.length,
          warnings: checked.warnings.length,
        },
      });
    },

    [ROUTES.check]: async (request) => {
      const root = services.resolveRoot(request, await readBody(request));
      if (root === undefined) return fail('no-root', 'no working directory');
      const tree = requireTree(root);
      if (tree === null) return fail('no-archctrl', `.archctrl was not found under ${root}`);
      return ok(checkTree(tree));
    },

    [ROUTES.contract]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === undefined) return fail('no-root', 'no working directory');
      // The module arrives in the body from the panel and in the query from a
      // plain link; the body wins because that caller also chose the repository.
      const module = typeof body.module === 'string' ? body.module : (new URL(request.url).searchParams.get('module') ?? '');
      const tree = requireTree(root);
      if (tree === null) return fail('no-archctrl', `.archctrl was not found under ${root}`);
      const wanted = module === '' || module === 'root' || module === 'null' ? null : module;
      const contract = tree.contracts.find((c) => c.module === wanted);
      if (contract === undefined) return fail('unknown-module', `no contract for module "${module}"`);
      return ok({
        module: contract.module,
        contract: contract.contract,
        path: contract.path,
        tokens: contract.tokens,
        text: readFileSync(join(tree.root, contract.path), 'utf8'),
      });
    },

    [ROUTES.review]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === undefined) return fail('no-root', 'no working directory');
      const tree = requireTree(root);
      if (tree === null) return fail('no-archctrl', `.archctrl was not found under ${root}`);
      const base = typeof body.base === 'string' && body.base !== '' ? body.base : 'main';
      return ok(reviewChanges(tree, base));
    },

    [ROUTES.propose]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === undefined) return fail('no-root', 'no working directory');
      const tree = requireTree(root);
      if (tree === null) return fail('no-archctrl', `.archctrl was not found under ${root}`);
      const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [];
      const attribution = impact(tree, paths);
      const checked = checkTree(tree);
      return ok({
        targets: attribution.modules.map((hit) => {
          const contract = tree.contracts.find((c) => String(c.module) === hit.module) ?? null;
          return {
            module: hit.module,
            contract: contract?.contract ?? null,
            tokens: contract?.tokens ?? 0,
            paths: hit.paths,
            depends: contract?.depends ?? [],
            verifies: contract?.verifies ?? [],
          };
        }),
        dependents: attribution.dependents,
        unmatched: attribution.unmatched,
        errors: checked.errors,
        warnings: checked.warnings,
      });
    },

    [ROUTES.judge]: async (request, runtime) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === undefined) return fail('no-root', 'no working directory');
      const tree = requireTree(root);
      if (tree === null) return fail('no-archctrl', `.archctrl was not found under ${root}`);

      const module = typeof body.module === 'string' ? body.module : '';
      const wanted = module === '' || module === 'root' ? null : module;
      const contract = tree.contracts.find((c) => c.module === wanted);
      if (contract === undefined) return fail('unknown-module', `no contract for module "${module}"`);

      if (runtime.llm === undefined) return fail('no-llm', 'this Host provides no model service');
      if (runtime.llmConfig === undefined) {
        return fail('no-model', 'this Session has not chosen a model yet; send one message first');
      }
      const base = typeof body.base === 'string' && body.base !== '' ? body.base : 'main';
      try {
        return ok(await judgeContract(runtime.llm, runtime.llmConfig, tree, contract, base, request.signal));
      } catch (error) {
        return fail('judge-failed', error instanceof Error ? error.message : String(error));
      }
    },

    [ROUTES.apply]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === undefined) return fail('no-root', 'no working directory');
      const tree = requireTree(root);
      if (tree === null) return fail('no-archctrl', `.archctrl was not found under ${root}`);

      const module = typeof body.module === 'string' ? body.module : '';
      const wanted = module === '' || module === 'root' ? null : module;
      const contract = tree.contracts.find((c) => c.module === wanted);
      if (contract === undefined) return fail('unknown-module', `no contract for module "${module}"`);
      if (typeof body.body !== 'string' || body.body.trim() === '') {
        return fail('empty-body', 'the accepted revision is empty');
      }
      try {
        return ok(applyContract(tree, contract, body.body));
      } catch (error) {
        return fail('apply-failed', error instanceof Error ? error.message : String(error));
      }
    },

    [ROUTES.diagnose]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === undefined) return fail('no-root', 'no working directory');

      const tree = requireTree(root);
      if (tree === null) {
        // No tree at all is a diagnosis, not a failure: the panel needs to say
        // "this repository has no contracts yet" and offer a scaffold.
        return ok({
          state: 'empty',
          root,
          modules: proposalModules(root),
          contracts: [],
          frontmatter: [],
        });
      }

      const checked = checkTree(tree);
      const proposals = proposeFrontmatter(tree);
      // A tree with files but no declarations is the "hand-written documents"
      // case: the content is fine, the scope was never stated.
      const undeclared = tree.contracts.filter((c) => c.owns.length === 0).length;
      return ok({
        state: undeclared === 0 ? 'declared' : 'undeclared',
        root,
        modules: [],
        contracts: tree.contracts.map((c) => ({
          module: c.module,
          contract: c.contract,
          tokens: c.tokens,
          owns: c.owns.length,
        })),
        frontmatter: proposals.map((p) => ({
          ...p,
          block: renderFrontmatter(p.owns),
        })),
        totals: {
          contracts: tree.contracts.length,
          undeclared,
          errors: checked.errors.length,
          warnings: checked.warnings.length,
        },
      });
    },

    [ROUTES.repair]: async (request, runtime) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === undefined) return fail('no-root', 'no working directory');
      const tree = requireTree(root);
      if (tree === null) return fail('no-archctrl', `.archctrl was not found under ${root}`);

      // `apply: false` is the default: a repair is shown as a proposal first.
      const apply = body.apply === true;
      const proposals = proposeFrontmatter(tree);
      const contested = contestedPaths(proposals);

      // A contested path needs a reading of intent; an uncontested one is a
      // statement the document already made. Asking about the cheap case would
      // spend model tokens to confirm a citation.
      let resolved: Awaited<ReturnType<typeof resolveOwnership>> = [];
      let modelNote: string | undefined;
      if (body.useModel === true && contested.length > 0) {
        if (runtime.llm === undefined) {
          modelNote = 'no-llm';
        } else if (runtime.llmConfig === undefined) {
          modelNote = 'no-model';
        } else {
          try {
            resolved = await resolveOwnership(
              runtime.llm,
              runtime.llmConfig,
              ownershipQuestions(tree, contested, 2),
              request.signal,
            );
          } catch (error) {
            modelNote = error instanceof Error ? error.message : String(error);
          }
        }
      }

      const merged = applyOwnershipAnswers(proposals, resolved);
      const results: {
        contract: string;
        owns: readonly string[];
        unresolved: readonly string[];
        applied: boolean;
        commit?: string;
      }[] = [];

      for (const proposal of merged) {
        if (!apply || proposal.owns.length === 0) {
          results.push({ ...proposal, applied: false });
          continue;
        }
        const commit = insertFrontmatter(tree.root, proposal.contract, proposal.owns);
        results.push({
          contract: proposal.contract,
          owns: proposal.owns,
          unresolved: proposal.unresolved,
          applied: commit !== undefined,
          ...(commit === undefined ? {} : { commit }),
        });
      }

      return ok({
        applied: apply,
        proposed: proposals.length,
        contested: contested.length,
        resolved: resolved.length,
        ...(modelNote === undefined ? {} : { modelNote }),
        results,
      });
    },

    [ROUTES.scaffold]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === undefined) return fail('no-root', 'no working directory');

      const modules = proposalModules(root);
      const wanted = Array.isArray(body.modules)
        ? body.modules.filter((m): m is string => typeof m === 'string')
        : modules.map((m) => m.module);
      const plan = modules
        .filter((m) => wanted.includes(m.module))
        .map((m) => ({
          module: m.module,
          path: scaffoldPath(m.module),
          owns: m.owns,
          text: scaffoldContract(m.module, m.owns),
        }));

      if (body.apply !== true) return ok({ applied: false, plan });

      const written = writeScaffold(root, plan);
      return ok({ applied: true, plan, written });
    },

    [ROUTES.active]: async (request) => {
      const body = await readBody(request);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const root = services.resolveRoot(request, body);
      const tree = root === undefined ? null : readTree(root);
      const read = services.readModules(sessionId);
      return ok<ActiveAnswer>({
        sessionId,
        root: tree?.root ?? null,
        read,
        contracts: (tree?.contracts ?? []).map((c) => ({
          module: String(c.module),
          tokens: c.tokens,
          read: read.includes(String(c.module)),
        })),
      });
    },
  };
}

/**
 * Insert frontmatter into one contract and commit it alone.
 *
 * A repair to a document is a commit a reviewer can read by itself; folding it
 * into the code commit is what makes `git log` useless for both.
 */
function insertFrontmatter(root: string, contract: string, owns: readonly string[]): string | undefined {
  const full = join(root, contract);
  const source = readFileSync(full, 'utf8');
  if (source.startsWith('---\n')) return undefined;
  writeFileSync(full, withFrontmatter(source, `${renderFrontmatter(owns)}`), 'utf8');
  const message = `docs(archctrl): declare scope for ${contract}`;
  if (gitCommit(root, ['add', '--', contract]) === null) return undefined;
  if (gitCommit(root, ['commit', '-m', message, '--', contract]) === null) return undefined;
  return gitCommit(root, ['rev-parse', '--short', 'HEAD']) ?? undefined;
}

/** Write a scaffold, creating directories, and commit the set as one change. */
function writeScaffold(
  root: string,
  plan: readonly { path: string; text: string }[],
): { path: string; commit?: string }[] {
  const out: { path: string; commit?: string }[] = [];
  for (const entry of plan) {
    const full = join(root, entry.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, entry.text, 'utf8');
    out.push({ path: entry.path });
  }
  if (plan.length === 0) return out;
  const paths = plan.map((entry) => entry.path);
  if (gitCommit(root, ['add', '--', ...paths]) !== null) {
    const message = `docs(archctrl): scaffold ${paths.length} contracts`;
    if (gitCommit(root, ['commit', '-m', message, '--', ...paths]) !== null) {
      const hash = gitCommit(root, ['rev-parse', '--short', 'HEAD']);
      if (hash !== null) for (const entry of out) entry.commit = hash;
    }
  }
  return out;
}
