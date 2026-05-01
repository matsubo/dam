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
