/**
 * The two dictionaries must stay in step.
 *
 * A missing translation is invisible at runtime — the Host silently falls back
 * to English — so a Chinese user sees a stray English sentence and nobody
 * notices. These tests make the gap a build failure.
 */

import { describe, expect, it } from 'vitest';

import { en, zh } from '../dict';
import { interpolate, makeTranslate } from '../index';

const placeholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

describe('dictionaries', () => {
  it('covers every English key in Chinese', () => {
    expect(Object.keys(en).filter((key) => !(key in zh))).toEqual([]);
  });

  it('has no Chinese key the English one lacks', () => {
    expect(Object.keys(zh).filter((key) => !(key in en))).toEqual([]);
  });

  it('keeps the same placeholders in both languages', () => {
    const mismatched = Object.keys(en).filter((key) => {
      const a = placeholders(en[key] ?? '');
      const b = placeholders(zh[key] ?? '');
      return a.join(',') !== b.join(',');
    });
    expect(mismatched).toEqual([]);
  });

  it('uses only lowercase keys', () => {
    expect(Object.keys(en).filter((key) => key !== key.toLowerCase())).toEqual([]);
  });
});

describe('interpolate', () => {
  it('fills placeholders', () => {
    expect(interpolate('{count} contracts', { count: 3 })).toBe('3 contracts');
  });

  it('leaves an unknown placeholder visible rather than blank', () => {
    expect(interpolate('{count} contracts', {})).toBe('{count} contracts');
  });
});

describe('makeTranslate', () => {
  it('falls back to the secondary dictionary', () => {
    const t = makeTranslate({ 'a.b': 'zh' }, { 'a.b': 'en', 'c.d': 'en only' });
    expect(t('a.b')).toBe('zh');
    expect(t('c.d')).toBe('en only');
  });

  it('returns the key when neither dictionary has it', () => {
    expect(makeTranslate({})('missing.key')).toBe('missing.key');
  });
});
