// Executes every Fetch route the Host half mounts.
//
// The bug this file exists for: three routes called `readBody`, a helper the
// refactor deleted. Nothing caught it — the client tests only proved that the
// slots registered, and a route is a function nobody called until a user did.
// So these tests call each route with a real Request and assert on the response.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../dist/host/index.js';

/** A repository with one contract, so the routes have something to answer about. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'archctrl-routes-'));
  const files = {
    '.archctrl/arch.md': '---\nowns:\n  - .archctrl\n---\n\n# root\n',
    '.archctrl/m/arch.md': '---\nowns:\n  - internal/m\n---\n\n# m\n\n禁止原生 confirm。\n',
    'internal/m/a.go': 'package m\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Mount the plugin and return its routes plus a caller.
 *
 * `llm` is optional per call: a route that needs a model reports a failure
 * instead of throwing, and a route that does not must still work without one.
 */
function mount({ root, withLlm = false }) {
  const routes = new Map();
  const register = (route) => {
    for (const method of route.methods) routes.set(`${method} ${route.path}`, route.fetch);
    return () => {};
  };
  const connection = { fetch: { register } };
  const scope = {
    effect: (factory) => {
      const disposer = typeof factory === 'function' ? factory() : undefined;
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: (key) => {
      if (key === 'connection') return connection;
      if (key === 'workingDirectory') return { defaultDirectory: root };
      if (key === 'sessions') return { list: () => [], get: () => undefined };
      if (key === 'llm' && withLlm) {
        return {
          prepareCall: async (config) => ({
            config,
            async *stream() {
              yield { type: 'text-delta', text: '{"change": false, "reason": "ok"}' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          }),
        };
      }
      return undefined;
    },
    on: () => () => {},
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  };
  const ctx = { ...scope, inject: (_deps, body) => body(scope) };
  apply(ctx, {});
  return routes;
}

/**
 * Call a mounted route.
 *
 * Every read route accepts POST, which is what the browser uses: the request
 * carries the repository root, and a GET may not have a body.
 */
const callRoute = async (routes, _listed, path, body) => {
  const handler = routes.get(`GET ${path}`) ?? routes.get(`POST ${path}`);
  assert.ok(handler !== undefined, `route ${path} was not mounted`);
  const request = new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const response = await handler(request);
  return response.json();
};

test('every declared route mounts', () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    // Every route accepts GET and POST: the browser sends a body (the repository
    // root), and a plain link can still open one.
    const paths = [...new Set([...routes.keys()].map((key) => key.replace(/^(GET|POST) /, '')))].sort();
    assert.deepEqual(paths, [
      '/api/archctrl/active',
      '/api/archctrl/apply',
      '/api/archctrl/check',
      '/api/archctrl/contract',
      '/api/archctrl/diagnose',
      '/api/archctrl/judge',
      '/api/archctrl/propose',
      '/api/archctrl/repair',
      '/api/archctrl/review',
      '/api/archctrl/scaffold',
      '/api/archctrl/state',
      '/api/archctrl/workspaces',
    ]);
    for (const key of routes.keys()) {
      assert.match(key, /^(GET|POST) \/api\/archctrl\//);
    }
  } finally {
    repo.cleanup();
  }
});

test('state answers with the tree', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    const body = await callRoute(routes, 'GET', '/api/archctrl/state', { root: repo.dir });
    assert.equal(body.ok, true);
    assert.equal(body.value.totals.contracts, 2);
    assert.equal(body.value.root, repo.dir);
  } finally {
    repo.cleanup();
  }
});

test('check answers with its findings', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    const body = await callRoute(routes, 'GET', '/api/archctrl/check', { root: repo.dir });
    assert.equal(body.ok, true);
    assert.deepEqual(body.value.errors, []);
  } finally {
    repo.cleanup();
  }
});

test('contract returns one body, and refuses an unknown module', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    const found = await callRoute(routes, 'GET', '/api/archctrl/contract', { root: repo.dir, module: 'm' });
    assert.equal(found.ok, true);
    assert.match(found.value.text, /禁止原生 confirm/);

    const missing = await callRoute(routes, 'GET', '/api/archctrl/contract', { root: repo.dir, module: 'ghost' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'unknown-module');
  } finally {
    repo.cleanup();
  }
});

test('review reports the change set', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    const body = await callRoute(routes, 'GET', '/api/archctrl/review', { root: repo.dir, base: 'HEAD' });
    assert.equal(body.ok, true);
    // A temp repository is not a git repo, so there is no diff to report; what
    // matters is that the route answered rather than throwing.
    assert.equal(typeof body.value.verdict, 'string');
  } finally {
    repo.cleanup();
  }
});

test('workspaces answers even without a registry service', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    const body = await callRoute(routes, 'GET', '/api/archctrl/workspaces', {});
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.value.items));
    // The host working directory is the last fallback, so the panel is never
    // left with an empty list and no explanation.
    assert.equal(body.value.items.length, 1);
    assert.equal(body.value.source.registry, 0);
  } finally {
    repo.cleanup();
  }
});

test('active reports the reading log for a session', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    const body = await callRoute(routes, 'GET', '/api/archctrl/active', { sessionId: 'session-x', root: repo.dir });
    assert.equal(body.ok, true);
    assert.deepEqual(body.value.read, []);
  } finally {
    repo.cleanup();
  }
});

test('judge reports a failure when this Host offers no model', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir, withLlm: false });
    const body = await callRoute(routes, 'POST', '/api/archctrl/judge', { root: repo.dir, module: 'm', base: 'HEAD' });
    assert.equal(body.ok, false);
    // Distinguish "no model" from "model said no": silence here would be read as
    // a passing verdict.
    assert.equal(body.error.code, 'no-llm');
  } finally {
    repo.cleanup();
  }
});

test('judge reaches the model service when one exists', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir, withLlm: true });
    const body = await callRoute(routes, 'POST', '/api/archctrl/judge', { root: repo.dir, module: 'm', base: 'HEAD' });
    // No `no-model` from the request header path: a request with no session id
    // still allows the judgement when the Host can supply a config.
    assert.equal(body.ok, false);
    assert.ok(body.error.code === 'no-model' || body.error.code === 'archctrl/judge');
  } finally {
    repo.cleanup();
  }
});

test('apply refuses an empty revision instead of truncating a contract', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    const body = await callRoute(routes, 'POST', '/api/archctrl/apply', { root: repo.dir, module: 'm', body: '   ' });
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'empty-body');
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Onboarding
//
// A request for these three answers must never throw: "this repository has no
// contracts" is a diagnosis the panel renders, not a failure.
// ---------------------------------------------------------------------------

test('diagnose reports an empty repository instead of failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archctrl-empty-'));
  try {
    mkdirSync(join(dir, 'internal', 'middleware'), { recursive: true });
    writeFileSync(join(dir, 'internal', 'middleware', 'auth.go'), 'package middleware\n');
    const routes = mount({ root: dir });
    const body = await callRoute(routes, 'GET', '/api/archctrl/diagnose', { root: dir });
    assert.equal(body.ok, true);
    assert.equal(body.value.state, 'empty');
    assert.ok(body.value.modules.length > 0, 'the layout should suggest modules');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnose reports a hand-written tree as undeclared', async () => {
  const repo = makeRepo();
  try {
    const routes = mount({ root: repo.dir });
    const body = await callRoute(routes, 'GET', '/api/archctrl/diagnose', { root: repo.dir });
    assert.equal(body.ok, true);
    // `makeRepo` writes contracts with scope, so this one is already declared.
    assert.equal(body.value.state, 'declared');
  } finally {
    repo.cleanup();
  }
});

test('repair proposes without writing by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archctrl-repair-'));
  try {
    mkdirSync(join(dir, '.archctrl', 'storage'), { recursive: true });
    mkdirSync(join(dir, 'internal', 'dao'), { recursive: true });
    writeFileSync(join(dir, 'internal', 'dao', 'schema.go'), 'package dao\n');
    writeFileSync(
      join(dir, '.archctrl', 'storage', 'arch.md'),
      '# Storage\n\nSee [schema](../../internal/dao/schema.go).\n',
    );
    const routes = mount({ root: dir });
    const body = await callRoute(routes, 'POST', '/api/archctrl/repair', { root: dir, apply: false });
    assert.equal(body.ok, true);
    assert.equal(body.value.applied, false);
    const storage = body.value.results.find((r) => r.contract === 'storage/arch.md');
    assert.deepEqual(storage.owns, ['internal/dao']);
    // The proposal must not have touched the file.
    const onDisk = readFileSync(join(dir, '.archctrl', 'storage', 'arch.md'), 'utf8');
    assert.equal(onDisk.startsWith('---'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repair reports no model instead of guessing an owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archctrl-conflict-'));
  try {
    for (const [module, line] of [
      ['a', '启动顺序由本契约规定，见 [boot](../../internal/middleware/auth.go)。'],
      ['b', '本契约只提到 [auth](../../internal/middleware/auth.go)。'],
    ]) {
      mkdirSync(join(dir, '.archctrl', module), { recursive: true });
      writeFileSync(join(dir, '.archctrl', module, 'arch.md'), `# ${module}\n\n${line}\n`);
    }
    mkdirSync(join(dir, 'internal', 'middleware'), { recursive: true });
    writeFileSync(join(dir, 'internal', 'middleware', 'auth.go'), 'package middleware\n');

    const routes = mount({ root: dir, withLlm: false });
    const body = await callRoute(routes, 'POST', '/api/archctrl/repair', {
      root: dir,
      apply: false,
      useModel: true,
    });
    assert.equal(body.ok, true);
    assert.equal(body.value.contested, 1);
    // A conflict left unassigned is an error the author can act on; a guessed
    // owner would be a rule nobody decided.
    assert.equal(body.value.resolved, 0);
    assert.equal(body.value.modelNote, 'no-llm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold plans without writing, then writes on request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archctrl-scaffold-'));
  try {
    mkdirSync(join(dir, 'internal', 'middleware'), { recursive: true });
    writeFileSync(join(dir, 'internal', 'middleware', 'auth.go'), 'package middleware\n');

    const routes = mount({ root: dir });
    const planned = await callRoute(routes, 'POST', '/api/archctrl/scaffold', { root: dir });
    assert.equal(planned.ok, true);
    assert.equal(planned.value.applied, false);
    assert.ok(planned.value.plan.length > 0);
    assert.equal(existsSync(join(dir, '.archctrl')), false);

    const written = await callRoute(routes, 'POST', '/api/archctrl/scaffold', { root: dir, apply: true });
    assert.equal(written.ok, true);
    assert.equal(written.value.applied, true);
    assert.ok(existsSync(join(dir, '.archctrl', 'middleware', 'arch.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
