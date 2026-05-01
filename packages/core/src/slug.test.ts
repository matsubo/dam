import { describe, expect, test } from 'bun:test';
import { suffixedSlug, toSlug } from './slug.ts';

describe('toSlug', () => {
  test('converts ASCII to lowercased dash-separated', () => {
    expect(toSlug('Yamba Dam')).toBe('yamba-dam');
  });

  test('strips punctuation', () => {
    expect(toSlug("O'Hara, Lake!")).toBe('ohara-lake');
  });

  test('romanizes Japanese kana', () => {
    expect(toSlug('やんば', { kanaToRomaji: true })).toBe('yanba');
  });

  test('does not romanize when option disabled', () => {
    const out = toSlug('やんば', { kanaToRomaji: false });
    expect(out).toBe('');
  });

  test('collapses multiple separators', () => {
    expect(toSlug('  Hello   World  ')).toBe('hello-world');
  });
});

describe('suffixedSlug', () => {
  test('returns base when not taken', () => {
    expect(suffixedSlug('yamba-dam', new Set())).toBe('yamba-dam');
  });

  test('appends -2 when base taken', () => {
    expect(suffixedSlug('yamba-dam', new Set(['yamba-dam']))).toBe('yamba-dam-2');
  });

  test('keeps incrementing', () => {
    expect(suffixedSlug('yamba-dam', new Set(['yamba-dam', 'yamba-dam-2', 'yamba-dam-3']))).toBe(
      'yamba-dam-4',
    );
  });
});
