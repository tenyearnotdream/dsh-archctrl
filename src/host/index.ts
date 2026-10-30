/**
 * Host half of the architecture-control plugin.
 *
 * The contract tree under `.archctrl/` is the only input. This plugin holds no
 * state of its own: it reads the documents on every request, derives ownership
 * from their frontmatter, and answers questions about them. Uninstalling it
 * leaves the repository byte-identical.
 *
 * Three surfaces are offered:
 *
 * - **Tools** the agent calls: which contract owns these files, one contract's
 *   text, the drift report, and a review of the changes since a ref.
 * - **A constant prompt section** naming the tree, so the agent knows where to
 *   look without the plugin injecting anything per turn.
 * - **Fetch routes** the browser panel reads.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ContractRecord } from '../shared/contracts.js';
import { checkTree } from './check.js';
import { impact, reviewChanges } from './impact.js';
import type { LlmLike } from './judge.js';
import { createRoutes, type RouteRuntime } from './routes.js';
import { readTree } from './tree.js';

const PROMPT_SECTION = 'archctrl:contracts';

/** Runtime settings, validated here because a bundle carries no schema export. */
export interface Settings {
  readonly enabled: boolean;
  readonly promptSection: boolean;
  readonly promptSectionOrder: number;
  readonly maxToolPaths: number;
}

const DEFAULTS: Settings = {
  enabled: true,
  promptSection: true,
  promptSectionOrder: 900,
  maxToolPaths: 40,
};

export function resolveConfig(input: unknown): Settings {
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
      ? value
      : fallback;
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    promptSection: bool(raw.promptSection, DEFAULTS.promptSection),
    promptSectionOrder: num(raw.promptSectionOrder, DEFAULTS.promptSectionOrder, -10000, 20000),
    maxToolPaths: num(raw.maxToolPaths, DEFAULTS.maxToolPaths, 1, 500),
  };
}

// ---------------------------------------------------------------------------
// The reading log
//
// Which contracts a conversation has opened. Process-local and never persisted:
// "what this Session looked at" is a property of the conversation, not of the
// project, so it must not be written into the repository.
// ---------------------------------------------------------------------------

const readSessions = new Map<string, Set<string>>();

/** Record that one Session read one module's contract. */
export function markRead(sessionId: string | undefined, module: string | null): void {
  if (typeof sessionId !== 'string' || sessionId === '') return;
  // The root index has no module name; its key is a stable placeholder so the
  // reading log can round-trip through JSON without turning null into "null".
  const key = module ?? '(root)';
  const existing = readSessions.get(sessionId);
  if (existing === undefined) readSessions.set(sessionId, new Set([key]));
  else existing.add(key);
}

/** The modules one Session has read. */
export function readModules(sessionId: string): readonly string[] {
  return [...(readSessions.get(sessionId) ?? [])].sort();
}

/** Reset the log; used by tests that must not share state. */
export function resetReadingLog(): void {
  readSessions.clear();
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

/**
 * A constant index of the tree.
 *
 * Deliberately not dynamic per turn: a section whose text changes on every
 * request defeats the provider's prompt cache, and the cache saving is larger
 * than any per-turn relevance gain at this size.
 */
export function promptText(tree: { contracts: readonly ContractRecord[] } | null): string {
  if (tree === null || tree.contracts.length === 0) return '';
  const top = tree.contracts.filter((c) => c.module !== null && !c.module.includes('/'));
  const total = tree.contracts.reduce((sum, c) => sum + c.tokens, 0);
  return [
    `Architecture contracts live under .archctrl/ (${tree.contracts.length} files, ~${total} tokens total).`,
    `A directory is a module and its arch.md is that module's contract. Read .archctrl/arch.md first, then only the module you are changing:`,
    top.map((c) => `.archctrl/${c.contract}`).join('  '),
    `Call arch_impact before editing code to learn which contract owns the files. Call arch_contract for one module's full text. Do not invent architecture the contracts forbid.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const textBlocks = (value: unknown): { type: 'text'; text: string }[] => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
];

const failure = (error: unknown): { error: string } => ({
  error: error instanceof Error ? error.message : String(error),
});

/** The shape this plugin needs from the DSH Context. Structural, not imported. */
export interface PluginContext {
  effect(factory: () => (() => void) | void): (() => void) | void;
  on(event: string, listener: (...args: never[]) => void): (() => void) | void;
  get(key: string): unknown;
  inject(deps: readonly string[], body: (scope: PluginContext) => unknown): unknown;
  readonly tools?: { register(definition: unknown): () => void };
  readonly systemPrompt?: { section(section: unknown): () => void };
}

/** The agent a tool call belongs to. */
interface AgentLike {
  readonly id?: string;
  readonly session?: { readonly header?: { readonly cwd?: string } };
}

interface ExecLike {
  readonly agent?: AgentLike;
}

function workspaceRootOf(agent: AgentLike | undefined): string | undefined {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

export const name = 'archctrl';
export const inject = ['tools', 'systemPrompt'];

/** Called by the Client bundle wrapper; registers the Host surface. */
export function apply(ctx: PluginContext, input?: unknown): void {
  const config = resolveConfig(input);
  if (!config.enabled) return;

  // Services the Fetch routes read, resolved from the `connection` scope because
  // this plugin's own context does not necessarily see them.
  const routeServices: {
    workspaceRegistry?: { list(): readonly { id: string; title: string; path: string }[] };
    sessions?: { list(): readonly { header?: { cwd?: string } }[]; get(id: string): unknown };
    workingDirectory?: { defaultDirectory?: string };
  } = {};

  const requireTree = (agent: AgentLike | undefined) => {
    const root = workspaceRootOf(agent);
    if (root === undefined) throw new Error('no working directory for this session');
    const tree = readTree(root);
    if (tree === null) throw new Error('this repository has no .archctrl contracts');
    return tree;
  };

  if (config.promptSection && ctx.systemPrompt !== undefined) {
    ctx.effect(() =>
      ctx.systemPrompt?.section({
        name: PROMPT_SECTION,
        order: config.promptSectionOrder,
        text: () => {
          const working = routeServices.workingDirectory?.defaultDirectory;
          if (typeof working !== 'string' || working === '') return '';
          try {
            return promptText(readTree(working));
          } catch {
            return '';
          }
        },
        interpolate: false,
      }),
    );
  }

  const register = (definition: Record<string, unknown>): void => {
    ctx.effect(() => ctx.tools?.register(definition));
  };

  register({
    name: 'arch_impact',
    description:
      'Which architecture contract owns these files, and which modules depend on them. Call this before editing code so the change stays inside the approved boundaries instead of re-deriving them by reading source.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repository-relative file or directory paths, e.g. internal/logic/canvas/canvas.go.',
        },
      },
      required: ['paths'],
    },
    output: { schema: { type: 'object' }, render: (_args: unknown, value: unknown) => textBlocks(value) },
    async execute(args: { paths?: unknown }, exec: ExecLike) {
      const paths = Array.isArray(args?.paths)
        ? args.paths.filter((p): p is string => typeof p === 'string' && p !== '')
        : [];
      if (paths.length === 0) return failure(new Error('paths must be a non-empty array of strings'));
      if (paths.length > config.maxToolPaths) {
        return failure(new Error(`paths accepts at most ${config.maxToolPaths} entries`));
      }
      try {
        const tree = requireTree(exec.agent);
        const result = impact(tree, paths);
        for (const hit of result.modules) {
          markRead(exec.agent?.id, hit.module === 'null' ? null : hit.module);
        }
        return {
          ...result,
          contracts: result.modules.map((hit) => {
            const contract = tree.contracts.find((c) => String(c.module) === hit.module);
            return {
              module: hit.module,
              contract: contract?.contract ?? null,
              tokens: contract?.tokens ?? 0,
              verifies: contract?.verifies ?? [],
              paths: hit.paths,
            };
          }),
          ...(result.unmatched.length > 0
            ? {
                note: 'Unmatched paths belong to no contract; either the module is new or its arch.md frontmatter does not claim them.',
              }
            : {}),
        };
      } catch (error) {
        return failure(error);
      }
    },
  });

  register({
    name: 'arch_contract',
    description:
      "Read one architecture contract in full, with its verification anchors and recent commits. Use after arch_impact names the module; omit the module to list what is available.",
    parameters: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description: 'Module name from arch_impact, e.g. project or platform/http. Omit to list modules.',
        },
      },
    },
    output: { schema: { type: 'object' }, render: (_args: unknown, value: unknown) => textBlocks(value) },
    async execute(args: { module?: unknown }, exec: ExecLike) {
      try {
        const tree = requireTree(exec.agent);
        const module = typeof args?.module === 'string' ? args.module.trim() : '';
        if (module === '') {
          return {
            modules: tree.contracts.map((c) => ({
              module: String(c.module),
              contract: c.contract,
              tokens: c.tokens,
              owns: c.owns.length,
              lastCommit: c.lastCommit?.subject ?? null,
            })),
          };
        }
        const wanted = module === '(root)' ? null : module;
        const contract = tree.contracts.find((c) => c.module === wanted);
        if (contract === undefined) {
          return failure(new Error(`unknown module "${module}"; call arch_contract without a module to list them`));
        }
        markRead(exec.agent?.id, contract.module);
        return {
          module,
          contract: contract.contract,
          path: contract.path,
          tokens: contract.tokens,
          lastCommit: contract.lastCommit,
          owns: contract.owns,
          depends: contract.depends,
          verifies: contract.verifies,
          text: readFileSync(join(tree.root, contract.path), 'utf8'),
        };
      } catch (error) {
        return failure(error);
      }
    },
  });

  register({
    name: 'arch_check',
    description:
      'Deterministic drift report for the architecture contracts: broken links, references to paths that no longer exist, ownership of missing paths, and directories no contract claims. Free to run.',
    parameters: {
      type: 'object',
      properties: {
        includeHints: {
          type: 'boolean',
          description: 'Include the informational "this contract lags N commits" list. Defaults to true.',
        },
      },
    },
    output: { schema: { type: 'object' }, render: (_args: unknown, value: unknown) => textBlocks(value) },
    async execute(args: { includeHints?: unknown }, exec: ExecLike) {
      try {
        const tree = requireTree(exec.agent);
        const result = checkTree(tree);
        return {
          errors: result.errors,
          warnings: result.warnings,
          ...(args?.includeHints === false ? {} : { hints: result.hints }),
          summary: {
            contracts: tree.contracts.length,
            tokens: tree.contracts.reduce((sum, c) => sum + c.tokens, 0),
            errors: result.errors.length,
            warnings: result.warnings.length,
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
  });

  register({
    name: 'arch_review',
    description:
      'Review the changes since a base ref without spending model tokens: which contracts own the changed files, whether those contracts were updated, which of their cited paths the change touches, and the diff size involved. Use before a commit the user asks you to review.',
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base ref to compare against, e.g. main. Defaults to main.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_args: unknown, value: unknown) => textBlocks(value) },
    async execute(args: { base?: unknown }, exec: ExecLike) {
      try {
        const tree = requireTree(exec.agent);
        const base = typeof args?.base === 'string' && args.base.trim() !== '' ? args.base.trim() : 'main';
        return reviewChanges(tree, base);
      } catch (error) {
        return failure(error);
      }
    },
  });

  // -------------------------------------------------------------------------
  // Fetch routes
  // -------------------------------------------------------------------------

  const routes = createRoutes({
    resolveRoot: (request, body) => {
      const url = new URL(request.url);
      const explicit =
        typeof body.root === 'string' && body.root !== ''
          ? body.root
          : (url.searchParams.get('root') ?? undefined);
      if (explicit !== undefined && explicit !== '') return explicit;

      const sessionId =
        typeof body.sessionId === 'string' && body.sessionId !== ''
          ? body.sessionId
          : (url.searchParams.get('sessionId') ?? undefined);
      if (sessionId !== undefined && sessionId !== '') {
        const session = routeServices.sessions?.get(sessionId) as
          | { header?: { cwd?: string } }
          | undefined;
        const cwd = session?.header?.cwd;
        if (typeof cwd === 'string' && cwd !== '') return cwd;
      }
      return undefined;
    },
    workspaces: () =>
      (routeServices.workspaceRegistry?.list() ?? []).map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        hasContracts: existsSync(join(workspace.path, '.archctrl')),
        source: 'registry' as const,
      })),
    sessionDirectories: () =>
      (routeServices.sessions?.list() ?? [])
        .map((session) => session.header?.cwd)
        .filter((cwd): cwd is string => typeof cwd === 'string' && cwd !== ''),
    hostDirectory: () => routeServices.workingDirectory?.defaultDirectory,
    readModules,
  });

  /**
   * What a handler may use beyond the request: the model service, and the model
   * selection of the Session that asked. A route is not inside a Session, so the
   * browser names one; without it the judgement refuses rather than guessing.
   */
  const runtimeFor = (request: Request, scope: PluginContext): RouteRuntime => {
    const llm = scope.get('llm') as LlmLike | undefined;
    let llmConfig: { provider: string; model: string } | undefined;
    try {
      const sessionId = new URL(request.url).searchParams.get('sessionId');
      const sessions = routeServices.sessions as
        | { get(id: string): { requestHeader?(): { config?: { provider?: string; model?: string } } } | undefined }
        | undefined;
      const session = sessionId !== null ? sessions?.get(sessionId) : undefined;
      const header = session?.requestHeader?.();
      if (typeof header?.config?.provider === 'string' && typeof header?.config?.model === 'string') {
        llmConfig = { provider: header.config.provider, model: header.config.model };
      }
    } catch {
      llmConfig = undefined;
    }
    return { ...(llm === undefined ? {} : { llm }), ...(llmConfig === undefined ? {} : { llmConfig }) };
  };

  // Mount only after every declaration exists: `ctx.inject` runs its body once
  // `connection` is available, and mounting an empty list would leave the panel
  // answering 404 with no diagnostic.
  ctx.inject(['connection'], (scope) => {
    for (const key of ['workspaceRegistry', 'sessions', 'workingDirectory'] as const) {
      const value = scope.get(key);
      if (value !== undefined) {
        (routeServices as Record<string, unknown>)[key] = value;
      }
    }

    const connection = scope.get('connection') as
      | { fetch?: { register(route: { path: string; methods: readonly string[]; requestBody: 'buffered'; fetch(handler: unknown): unknown }): () => void } }
      | undefined;
    const registerFetch = connection?.fetch;
    if (typeof registerFetch?.register !== 'function') return;

    for (const [path, handler] of Object.entries(routes)) {
      scope.effect(() =>
        registerFetch.register({
          path,
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: (request: Request) => handler(request, runtimeFor(request, scope)),
        }),
      );
    }
  });


}

// Re-exported for the Host's tests and for anyone composing a second surface on
// the same rules: the plugin itself only needs `apply`, but the decision logic is
// useful on its own and must not be duplicated.
export { parseFrontmatter, splitDocument } from './frontmatter.js';
export { checkTree, effectiveOwns } from './check.js';
export { impact, reviewChanges } from './impact.js';
export { applyContract, judgeContract } from './judge.js';
export { readTree, referencedPaths, approximateTokens } from './tree.js';
export { ROUTES } from './routes.js';
export {
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
export { resolveOwnership } from './judge.js';
export type { CheckResult, ContractRecord, ReviewResult, TreeState } from '../shared/contracts.js';
export type { Tree } from './tree.js';
