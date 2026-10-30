/**
 * The Fetch routes the browser half reads.
 *
 * Every route answers with the same envelope, so a caller never has to guess
 * whether a failure is a transport error or a refusal. Each one re-reads the tree
 * rather than caching: the panel must show the files as they are.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ActiveAnswer,
  RouteAnswer,
  TreeState,
  WorkspacesAnswer,
} from '../shared/contracts.js';
import { checkTree } from './check.js';
import { applyContract, judgeContract, type LlmLike } from './judge.js';
import { impact, reviewChanges } from './impact.js';
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
