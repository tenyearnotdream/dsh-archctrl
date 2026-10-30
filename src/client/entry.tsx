/**
 * The Client half's entry point.
 *
 * Vite wraps the output in `window.__ModuleLoader__.load({ id, factory })`; this
 * module only declares what the wrapper hands back. Keeping the wrapper out of
 * the source is what lets the components be imported by tests as ordinary ESM.
 */

import './index.css';

import type { ReactNode } from 'react';

import { ActiveStrip } from './components/ActiveStrip.js';
import { en, zh } from './locale/dict.js';
import { makeTranslate, setTranslate, t } from './locale/index.js';
import { Panel } from './components/Panel.js';
import { RightTab, type RightTabProps } from './components/RightTab.js';
import { TreeIcon } from './components/icons.js';

const TAB_ID = 'archctrl';
const LOCALE_NS = 'archctrl';

/** The shape of the DSH Client context this bundle uses. */
interface SlotContext {
  slots: {
    inject(
      slot: string,
      register: () => () => void,
    ): unknown;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  inject(deps: readonly string[], body: (scope: ClientScope) => unknown): unknown;
  effect(factory: () => (() => void) | void): (() => void) | void;
}

interface ClientScope extends SlotContext {
  /** Resolve a service the Host provided outside the cordis service table. */
  get(name: string): unknown;
  readonly locale?: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void;
    bind(namespace: string): (key: string, values?: Record<string, string | number>) => string;
  };
  readonly sidebarRightTabs?: {
    register(definition: {
      id: string;
      kind: string;
      order?: number;
      title: () => string;
      guide?: readonly { order: number; title: () => string; description: () => string }[];
    }): () => void;
  };
}

/**
 * The right rail's mount point.
 *
 * The tab is inside a Session, so it forwards the Session identity the slot
 * provides: the repository to read is that Session's working directory, not a
 * repository chosen from the global list.
 */
function RightRailMount(props: RightTabProps): ReactNode {
  return <RightTab {...props} />;
}

export function apply(ctx: SlotContext): void {
  // English first: it is the last link of every chain the Host declares, so a
  // render before (or without) locale registration never shows raw keys.
  setTranslate(makeTranslate(en));

  // `locale` is optional and cannot be read straight off `ctx` — cordis refuses
  // undeclared services at apply time — so it is soft-injected like the rail.
  ctx.inject(['locale'], (scope) => {
    const locale = scope.locale;
    if (locale === undefined) return;
    // Register both languages once. The Host picks the active one and owns the
    // fallback chain, so the plugin never inspects the language itself.
    scope.effect(() => locale.register(LOCALE_NS, { zh, en }));
    setTranslate(locale.bind(LOCALE_NS));
  });

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: TAB_ID,
        order: 35,
        label: () => t('panel.title'),
      },
      TreeIcon,
    ),
  );

  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'archctrl-reads', order: 40 },
      ActiveStrip,
    ),
  );

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: TAB_ID, label: () => t('panel.title') }, Panel),
  );

  // Only `connection` is a hard dependency elsewhere; the right rail is optional
  // so a profile without it still mounts the panel.
  // The right rail's registry is provided through the reflect face, not the
  // cordis service table, so `ctx.inject` never resolves it. The tab type is
  // registered through the documented service when present, and the slot bodies
  // are registered unconditionally: a body with no type is inert, while a type
  // with no body opens an empty pane.
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, RightRailMount),
  );
  ctx.slots.inject('sidebar.right.pane.tab.title', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () => (
      <span>{t('panel.rail-title')}</span>
    )),
  );

  ctx.inject(['sidebarRightTabs'], (scope) => {
    const tabs = scope.get('sidebarRightTabs') as RightTabsService | undefined;
    if (tabs === undefined) return;
    scope.effect(() =>
      tabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        order: 40,
        title: () => t('panel.rail-title'),
        // A type without a guide card exists but has no way in from the rail's
        // empty state, which is exactly how this tab was invisible once.
        guide: [
          {
            order: 40,
            title: () => t('panel.rail-title'),
            description: () => t('panel.rail-description'),
          },
        ],
      }),
    );
  });
}

/** The right rail's tab registry, as the Host exposes it. */
interface RightTabsService {
  register(definition: {
    id: string;
    kind: string;
    order?: number;
    title: () => string;
    guide?: readonly { order: number; title: () => string; description: () => string }[];
  }): () => void;
}

/**
 * Hand the module to the loader wrapper.
 *
 * Vite emits an anonymous IIFE when the entry's only consumer is the wrapper
 * itself, so the value is published explicitly instead of relying on a bundler
 * name option that changes shape between formats.
 */
declare global {
  var __archctrlModule: { apply: typeof apply; mount: typeof RightRailMount } | undefined;
}
globalThis.__archctrlModule = { apply, mount: RightRailMount };
