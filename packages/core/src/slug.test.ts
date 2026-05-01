import { describe, expect, test } from 'bun:test';
import { suffixedSlug, toSlug } from './slug.ts';

describe('toSlug', () => {
  test('converts ASCII to lowercased dash-separated', () => {
    expect(toSlug('Yamba Dam')).toBe('yamba-dam');
  });

  test('strips punctuation', () => {
    expect(toSlug("O'Hara, Lake!")).toBe('ohara-lake');
  });

  test('romanizes Japanese hiragana with Hepburn n→m before b', () => {
    expect(toSlug('やんば', { kanaToRomaji: true })).toBe('yamba');
  });

  test('romanizes katakana input', () => {
    expect(toSlug('ヤンバ')).toBe('yamba');
  });

  test('handles mixed Latin and kana', () => {
    expect(toSlug('Lake やんば Dam')).toBe('lake-yamba-dam');
  });

  test('handles sokuon by doubling the next consonant', () => {
    expect(toSlug('やっぱ')).toBe('yappa');
  });

  test('handles yōon digraphs', () => {
    expect(toSlug('しゃ')).toBe('sha');
    expect(toSlug('きょう')).toBe('kyou');
  });

  test('romanizes the canonical fixture dam name 八ッ場ダム (kanji-passthrough lossy, ダム → damu)', () => {
    expect(toSlug('八ッ場ダム')).toBe('damu');
  });

  test('folds halfwidth katakana via NFKC', () => {
    expect(toSlug('ﾔﾝﾊﾞ')).toBe('yamba');
  });

  test('returns empty string for empty input', () => {
    expect(toSlug('')).toBe('');
  });

  test('keeps numbers intact', () => {
    expect(toSlug('Dam 123')).toBe('dam-123');
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
