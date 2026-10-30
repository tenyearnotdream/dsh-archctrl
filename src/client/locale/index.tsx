/**
 * Translation for the Client half.
 *
 * The Host owns the active language and its fallback chain; this module only
 * registers the dictionaries and exposes a `t` the components call. A missing
 * key falls back to English rather than showing the key, because the Host's
 * chain already ends there.
 */

import { createContext, useContext } from 'react';

import type { Dictionary } from './dict.js';

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Resolve `{name}` placeholders. Unfilled ones stay visible rather than blank. */
export function interpolate(template: string, values?: Record<string, string | number>): string {
  if (values === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

/** A pure lookup over one dictionary, used by tests and as the last fallback. */
export function makeTranslate(dict: Dictionary, fallback: Dictionary = {}): Translate {
  return (key, values) => {
    const template = dict[key] ?? fallback[key] ?? key;
    return interpolate(template, values);
  };
}

export const TranslateContext = createContext<Translate | null>(null);

/**
 * Read `t` from the nearest provider.
 *
 * It throws rather than silently returning the key: a component rendered outside
 * the provider is a wiring mistake, and showing raw keys is how that mistake
 * reaches a user instead of a stack trace.
 */
export function useTranslate(): Translate {
  const translate = useContext(TranslateContext);
  if (translate === null) throw new Error('archctrl: useTranslate outside TranslateProvider');
  return translate;
}

/**
 * The translator the mounted components use.
 *
 * DSH mounts each registered component itself, so a React context provider in
 * this bundle would never wrap them. The Host's `apply` sets this once; until
 * then `t` resolves through the English dictionary, which keeps a first paint
 * before locale registration from showing raw keys.
 */
let current: Translate = makeTranslate({});

/** Install the translator the Host resolved for the active language. */
export function setTranslate(next: Translate): void {
  current = next;
}

/** The translator for the active language. */
export function t(key: string, values?: Record<string, string | number>): string {
  return current(key, values);
}
