import { describe, expect, test } from 'bun:test';
import { detectOutlier, isPhysicallyValid, QualityFlag } from './quality.ts';

describe('isPhysicallyValid', () => {
  test('rejects negative storage rate', () => {
    expect(isPhysicallyValid({ storageRate: -0.1 })).toBe(false);
  });
  test('rejects storage rate > 1.5 (allow some headroom for emergency overflow)', () => {
    expect(isPhysicallyValid({ storageRate: 1.6 })).toBe(false);
    expect(isPhysicallyValid({ storageRate: 1.4 })).toBe(true);
  });
  test('accepts zero', () => {
    expect(isPhysicallyValid({ storageRate: 0, storageVolumeM3: 0 })).toBe(true);
  });
});

describe('detectOutlier', () => {
  test('flag when delta > 30% in 1h', () => {
    expect(detectOutlier({ prev: 1_000_000, current: 1_400_000 })).toBe(true);
  });
  test('do not flag normal change', () => {
    expect(detectOutlier({ prev: 1_000_000, current: 1_010_000 })).toBe(false);
  });
  test('null prev disables detection', () => {
    expect(detectOutlier({ prev: null, current: 1_000_000 })).toBe(false);
  });
});

describe('QualityFlag bit math', () => {
  test('exposes the documented bits', () => {
    expect(QualityFlag.Missing).toBe(1);
    expect(QualityFlag.Outlier).toBe(2);
    expect(QualityFlag.Interpolated).toBe(4);
    expect(QualityFlag.Mismatch).toBe(8);
    expect(QualityFlag.ManualReview).toBe(16);
  });
});
