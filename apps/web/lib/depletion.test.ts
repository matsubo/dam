import { describe, expect, test } from 'bun:test';
import { estimateDepletionDays } from './depletion.ts';

describe('estimateDepletionDays', () => {
  test('linear extrapolation of the observed decline', () => {
    // 300万m³ → 240万m³ over 30 days = -2万m³/day → 120 days left.
    expect(estimateDepletionDays({ currentM3: 2_400_000, pastM3: 3_000_000, days: 30 })).toBe(120);
  });

  test('rising storage → null (no depletion to forecast)', () => {
    expect(estimateDepletionDays({ currentM3: 3_000_000, pastM3: 2_400_000, days: 30 })).toBeNull();
  });

  test('flat storage → null', () => {
    expect(estimateDepletionDays({ currentM3: 1_000, pastM3: 1_000, days: 30 })).toBeNull();
  });

  test('missing inputs → null', () => {
    expect(estimateDepletionDays({ currentM3: null, pastM3: 3_000_000, days: 30 })).toBeNull();
    expect(estimateDepletionDays({ currentM3: 2_400_000, pastM3: null, days: 30 })).toBeNull();
  });

  test('already empty → 0 days', () => {
    expect(estimateDepletionDays({ currentM3: 0, pastM3: 1_000, days: 30 })).toBe(0);
  });
});
