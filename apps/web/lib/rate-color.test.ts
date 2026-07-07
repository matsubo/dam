import { describe, expect, test } from 'bun:test';
import { rateBand } from './rate-color.ts';

describe('rateBand', () => {
  test('null / non-finite → no-data band', () => {
    expect(rateBand(null).label).toBe('データなし');
    expect(rateBand(undefined).label).toBe('データなし');
    expect(rateBand(Number.NaN).label).toBe('データなし');
  });

  test('bands map by threshold (0.2 / 0.4 / 0.6 / 0.8)', () => {
    expect(rateBand(0.1).label).toBe('危機的');
    expect(rateBand(0.3).label).toBe('渇水警戒');
    expect(rateBand(0.5).label).toBe('やや低い');
    expect(rateBand(0.7).label).toBe('平常');
    expect(rateBand(0.95).label).toBe('十分');
  });

  test('boundaries are inclusive-lower (0.2 leaves 危機的)', () => {
    expect(rateBand(0.199).label).toBe('危機的');
    expect(rateBand(0.2).label).toBe('渇水警戒');
    expect(rateBand(0.8).label).toBe('十分');
  });

  test('clamps out-of-range rates', () => {
    expect(rateBand(-0.5).label).toBe('危機的');
    expect(rateBand(1.5).label).toBe('十分');
  });

  test('every band exposes a color', () => {
    for (const r of [null, 0.1, 0.3, 0.5, 0.7, 0.95]) {
      expect(rateBand(r).color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
