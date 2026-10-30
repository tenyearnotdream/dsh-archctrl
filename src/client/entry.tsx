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
import { Panel } from './components/Panel.js';
import { RightTab } from './components/RightTab.js';
import { TreeIcon } from './components/icons.js';

const TAB_ID = 'archctrl';

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
 * The tab is inside a Session but carries no repository of its own, so it asks
 * the same workspaces route the panel uses rather than inventing a third source.
 */
function RightRailMount(): ReactNode {
  return <RightTab />;
}

export function apply(ctx: SlotContext): void {
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: TAB_ID,
        order: 35,
        label: () => 'Architecture',
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
    ctx.slots.register(
      { name: 'main', key: TAB_ID, label: () => 'Architecture' },
      Panel,
    ),
  );

  // Only `connection` is a hard dependency elsewhere; the right rail is optional
  // so a profile without it still mounts the panel.
  ctx.inject(['sidebarRightTabs'], (scope) => {
    const tabs = scope.sidebarRightTabs;
    if (tabs === undefined) return;
    scope.effect(() => {
      tabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        order: 40,
        title: () => 'Architecture',
        // A type without a guide card exists but has no way in from the rail's
        // empty state, which is exactly how this tab was invisible once.
        guide: [
          {
            order: 40,
            title: () => 'Architecture',
            description: () => 'Contracts this conversation has read',
          },
        ],
      });
    });
    scope.effect(() => {
      scope.slots.inject('sidebar.right.pane.tab', () =>
        scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, RightRailMount),
      );
    });
    scope.effect(() => {
      scope.slots.inject('sidebar.right.pane.tab.title', () =>
        scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () => (
          <span>Architecture</span>
        )),
      );
    });
  });
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
