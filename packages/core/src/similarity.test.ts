import { describe, expect, test } from 'bun:test';
import { normalizeJaName, trigramSimilarity } from './similarity.ts';

describe('normalizeJaName', () => {
  test('removes common dam suffix', () => {
    expect(normalizeJaName('八ッ場ダム')).toBe('八ッ場');
  });

  test('strips middle dot and parens', () => {
    expect(normalizeJaName('利根（とね）ダム')).toBe('利根');
  });

  test('lowercases and trims latin', () => {
    expect(normalizeJaName(' Yamba Dam ')).toBe('yamba');
  });

  test('normalizes small ヶ/ヵ to full ケ/カ', () => {
    expect(normalizeJaName('五ヶ山')).toBe('五ケ山');
    expect(normalizeJaName('宮ヵ瀬ダム')).toBe('宮カ瀬');
  });

  test('folds 第N ordinals to arabic so 第二 == 第2 == 第２', () => {
    // MLIT writes 矢作第２ダム; the master row is 矢作第二. Both must land on
    // the same stem or the sibling dam 50 m away loses to plain 矢作 2.7 km off.
    expect(normalizeJaName('矢作第２ダム')).toBe(normalizeJaName('矢作第二'));
    expect(normalizeJaName('遠野第二ダム')).toBe(normalizeJaName('遠野第2'));
    expect(normalizeJaName('佐久間第一')).toBe('佐久間第1');
    expect(normalizeJaName('第十発電ダム')).toBe('第10発電');
  });

  test('leaves multi-kanji ordinals alone rather than mangling them', () => {
    // 第十一 must not become 第101 — only a lone kanji digit folds.
    expect(normalizeJaName('第十一')).toBe('第十一');
  });

  test('leaves non-ordinal kanji numerals alone', () => {
    // 五ケ山 / 三国 are names, not ordinals — folding them would be wrong.
    expect(normalizeJaName('五ヶ山')).toBe('五ケ山');
    expect(normalizeJaName('二居ダム')).toBe('二居');
  });
});

describe('trigramSimilarity', () => {
  test('identical strings score 1', () => {
    expect(trigramSimilarity('hello', 'hello')).toBeCloseTo(1, 5);
  });

  test('disjoint strings score 0', () => {
    expect(trigramSimilarity('abcdef', 'xyzuvw')).toBeCloseTo(0, 5);
  });

  test('partial overlap is between', () => {
    const s = trigramSimilarity('yamba', 'yamaba');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});
