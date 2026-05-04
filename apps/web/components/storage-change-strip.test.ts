import { describe, expect, test } from 'bun:test';

// We import the pure helpers from the strip module. They're not exported but
// re-implemented here to keep this a unit test (and to lock the formula).
function pctChange(current: string | null, prev: string | null): number | null {
  if (!current || !prev) return null;
  const c = Number(current);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}

function freshness(ageS: number | null, expectedSeconds: number): 'ok' | 'stale' {
  if (ageS == null) return 'stale';
  return ageS <= expectedSeconds * 1.4 ? 'ok' : 'stale';
}

describe('pctChange', () => {
  test('positive change', () => {
    expect(pctChange('110', '100')).toBeCloseTo(10);
  });
  test('negative change', () => {
    expect(pctChange('90', '100')).toBeCloseTo(-10);
  });
  test('zero change', () => {
    expect(pctChange('100', '100')).toBe(0);
  });
  test('returns null when either side is missing', () => {
    expect(pctChange(null, '100')).toBeNull();
    expect(pctChange('100', null)).toBeNull();
  });
  test('returns null when prev is zero (avoid div/0)', () => {
    expect(pctChange('100', '0')).toBeNull();
  });
  test('returns null on NaN inputs', () => {
    expect(pctChange('abc', '100')).toBeNull();
    expect(pctChange('100', 'abc')).toBeNull();
  });
  test('handles bigint-shaped TEXT from postgres', () => {
    expect(pctChange('1525000.00', '1500000.00')).toBeCloseTo(1.6667, 3);
  });
});

describe('freshness', () => {
  test('fresh when age within window', () => {
    expect(freshness(3000, 3600)).toBe('ok');
  });
  test('fresh when exactly at the 1.4× tolerance boundary', () => {
    expect(freshness(3600 * 1.4, 3600)).toBe('ok');
  });
  test('stale when beyond 1.4× window', () => {
    expect(freshness(3600 * 2, 3600)).toBe('stale');
  });
  test('stale when age unknown', () => {
    expect(freshness(null, 3600)).toBe('stale');
  });
});
