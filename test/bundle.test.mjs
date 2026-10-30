// Verifies the BUILT bundle, not the source.
//
// The loader loads plugin bundles as classic scripts (`same-origin external
// classic script`), so a top-level `import` is a syntax error at load time — a
// failure that never appears in a source-level test. This file executes the
// artefact exactly as the browser would: a plain script, then the factory.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'dist/client/client.js');
const hostPath = join(root, 'dist/host/index.js');

const PACKAGE = '@local/dsh-archctrl';

/** Minimal React: enough to mount a component tree without a DOM. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  createContext: (value) => ({ Provider: 'Provider', _value: value }),
  useContext: () => null,
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};
const JSX = { jsx: React.createElement, jsxs: React.createElement, Fragment: 'Fragment' };

const provide = (name) =>
  name === 'react' ? React : name === 'react/jsx-runtime' ? JSX : React;

/** Execute the bundle the way the browser does, and return the module. */
function loadBundle() {
  const source = readFileSync(bundlePath, 'utf8');
  let captured;
  const styles = [];
  const document = {
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { appendChild: (node) => styles.push(node) },
    getElementById: () => null,
  };
  const window = { __ModuleLoader__: { load: (module) => { captured = module; } } };

  // A classic script: `new Function` has the same restriction as <script>, so a
  // top-level `import` would throw here just as it would in the browser.
  new Function('window', 'document', source)(window, document);
  assert.equal(captured.id, PACKAGE);
  return { module: captured.factory(provide), styles };
}

test('the built bundle exists', () => {
  assert.ok(existsSync(bundlePath), 'run `npm run build:client` first');
  assert.ok(existsSync(hostPath), 'run `npm run build:host` first');
});

test('the bundle registers both languages with the Host', () => {
  const { module } = loadBundle();
  const registered = [];
  const bound = [];
  // `locale` is optional, so it arrives through a soft inject — never off `ctx`.
  const locale = {
    register: (namespace, dictionaries) => {
      registered.push({ namespace, dictionaries });
      return () => {};
    },
    bind: (namespace) => {
      bound.push(namespace);
      return (key) => key;
    },
  };
  const base = {
    slots: { inject: (_slot, register) => register(), register: () => () => {} },
    effect: (factory) => {
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: () => undefined,
    on: () => () => {},
  };
  module.apply({
    ...base,
    inject: (_deps, body) =>
      body({ ...base, locale, sidebarRightTabs: { register: () => () => {} } }),
  });

  assert.equal(registered.length, 1);
  assert.deepEqual(Object.keys(registered[0].dictionaries).sort(), ['en', 'zh']);
  // Both languages must carry the same keys, or one of them silently falls back.
  const zhKeys = Object.keys(registered[0].dictionaries.zh).sort();
  const enKeys = Object.keys(registered[0].dictionaries.en).sort();
  assert.deepEqual(zhKeys, enKeys);
  assert.equal(bound[0], registered[0].namespace);
});

test('the bundle still applies without the locale service', () => {
  const { module } = loadBundle();
  const base = {
    slots: { inject: (_slot, register) => register(), register: () => () => {} },
    effect: (factory) => {
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: () => undefined,
    on: () => () => {},
  };
  // A Host without `locale` must not throw: English is the last fallback.
  assert.doesNotThrow(() =>
    module.apply({
      ...base,
      inject: (_deps, body) => body({ ...base, sidebarRightTabs: { register: () => () => {} } }),
    }),
  );
});

test('apply reads no service it did not inject', () => {
  // cordis throws `cannot get property "<name>" without inject` on an undeclared
  // service read, which marks the whole plugin failed and takes the page down.
  // This proxy reproduces that rule so a direct `ctx.locale` cannot come back.
  const { module } = loadBundle();
  const guard = (target) =>
    new Proxy(target, {
      get(object, key) {
        if (typeof key === 'string' && !(key in object)) {
          throw new Error(`cannot get property "${key}" without inject`);
        }
        return object[key];
      },
    });
  const base = {
    slots: { inject: (_slot, register) => register(), register: () => () => {} },
    effect: (factory) => {
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: () => undefined,
    on: () => () => {},
  };
  const scope = guard({
    ...base,
    locale: { register: () => () => {}, bind: () => (key) => key },
    sidebarRightTabs: { register: () => () => {} },
  });
  assert.doesNotThrow(() =>
    module.apply(
      guard({
        ...base,
        inject: (_deps, body) => body(scope),
      }),
    ),
  );
});

test('the bundle is a classic script, not an ES module', () => {
  const source = readFileSync(bundlePath, 'utf8');
  // The loader appends a plain <script>; a top-level import would fail to parse.
  assert.equal(/^\s*import[\s{*]/m.test(source), false, 'top-level import found');
  assert.equal(/^\s*export[\s{*]/m.test(source), false, 'top-level export found');
});

test('the bundle registers under the package name and exports apply', () => {
  const { module } = loadBundle();
  assert.deepEqual(Object.keys(module).sort(), ['apply', 'inject']);
  assert.deepEqual(module.inject, ['slots']);
  assert.equal(typeof module.apply, 'function');
});

test('applying registers every slot the plugin ships', () => {
  const { module } = loadBundle();
  const slots = [];
  const tabTypes = [];
  const base = {
    slots: {
      inject: (_slot, register) => register(),
      register: (options, component) => {
        slots.push({ slot: options.name, id: options.id ?? options.key, component });
        return () => {};
      },
    },
    effect: (factory) => {
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: () => undefined,
    on: () => () => {},
  };
  module.apply({
    ...base,
    inject: (_deps, body) =>
      body({ ...base, sidebarRightTabs: { register: (definition) => { tabTypes.push(definition); return () => {}; } } }),
  });

  assert.deepEqual(
    slots.map((entry) => [entry.slot, entry.id]),
    [
      ['sidebar.panellist', 'archctrl'],
      ['conversation.composer.dock', 'archctrl-reads'],
      ['main', 'archctrl'],
      ['sidebar.right.pane.tab', 'archctrl'],
      ['sidebar.right.pane.tab.title', 'archctrl'],
    ],
  );
  for (const entry of slots) assert.equal(typeof entry.component, 'function');
});

test('the right-rail tab type carries a guide card, or it is unreachable', () => {
  const { module } = loadBundle();
  const tabTypes = [];
  const base = {
    slots: { inject: (_s, r) => r(), register: () => () => {} },
    effect: (factory) => {
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: () => undefined,
    on: () => () => {},
  };
  // The rail registry is reached through the scope's `get`, not the service
  // table: `ctx.inject` resolves the scope, and the registry lives on it.
  const tabs = {
    register: (definition) => {
      tabTypes.push(definition);
      return () => {};
    },
  };
  module.apply({
    ...base,
    inject: (_deps, body) => body({ ...base, get: (name) => (name === 'sidebarRightTabs' ? tabs : undefined) }),
  });
  assert.equal(tabTypes.length, 1);
  assert.equal(tabTypes[0].kind, 'archctrl');
  assert.ok(Array.isArray(tabTypes[0].guide) && tabTypes[0].guide.length > 0);
});

test('the bundle carries its stylesheet inside the single JS file', () => {
  // The loader fetches one URL, so a separate CSS asset would never be applied.
  // Vite inlines it at the top of the IIFE; this asserts it is present and it is
  // genuinely Tailwind output, not an empty placeholder.
  const source = readFileSync(bundlePath, 'utf8');
  const styles = [];
  const document = {
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { appendChild: (node) => styles.push(node) },
    getElementById: () => null,
  };
  let factory;
  const window = { __ModuleLoader__: { load: (module) => { factory = module.factory; } } };
  new Function('window', 'document', source)(window, document);

  // The stylesheet is part of the factory body, so it appears when the loader
  // materializes the module — which is exactly when the plugin goes live.
  assert.equal(styles.length, 0, 'nothing runs before materialization');
  factory(provide);

  assert.equal(styles.length, 1, 'exactly one stylesheet is injected');
  const css = styles[0].textContent;
  assert.ok(css.length > 4000, `stylesheet looks truncated: ${css.length} bytes`);
  assert.match(css, /dsw-alias-bg-base|--color-background/, 'theme tokens are missing');
  assert.match(css, /archctrl-root/, 'the plugin\'s own class is missing');
});
