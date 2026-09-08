import { describe, expect, test } from 'bun:test';
import { rateDenominator } from './rate-basis.ts';

describe('rateDenominator', () => {
  test('no effective capacity → null (nothing to explain)', () => {
    expect(rateDenominator(null, 14_500_000, 1_992_000)).toBeNull();
    expect(rateDenominator(undefined, 14_500_000, 1_992_000)).toBeNull();
    expect(rateDenominator(0, 14_500_000, 1_992_000)).toBeNull();
    expect(rateDenominator(-1, 14_500_000, 1_992_000)).toBeNull();
    expect(rateDenominator(Number.NaN, 14_500_000, 1_992_000)).toBeNull();
  });

  test('effective equals static → not flagged', () => {
    const d = rateDenominator(14_500_000, 14_500_000, 1_992_000);
    expect(d?.capacityM3).toBe(14_500_000);
    expect(d?.differsFromStatic).toBe(false);
  });

  test('within 2% of static → not flagged (rounding noise from % → fraction)', () => {
    // 美利河 back-solves to 14,756 千m³ from storPcntEff=13.5 vs static
    // 14,500 (+1.8%): the same figure, blurred by one-decimal rounding.
    expect(rateDenominator(14_756_000, 14_500_000, 1_992_000)?.differsFromStatic).toBe(false);
    expect(rateDenominator(14_900_000, 14_500_000, 1_992_000)?.differsFromStatic).toBe(true); // +2.8%
  });

  test('洪水期 利水容量 far below static → flagged with the effective value (#19)', () => {
    // 美利河ダム: source 利水容量貯水率 92.3% at 1,992 千m³ → 2,158 千m³,
    // while the static Damnet 利水容量 is 14,500 千m³.
    const d = rateDenominator(2_158_000, 14_500_000, 1_992_000);
    expect(d?.differsFromStatic).toBe(true);
    expect(d?.capacityM3).toBe(2_158_000);
  });

  test('no static capacity on the master → flagged (the header shows —)', () => {
    const d = rateDenominator(2_158_000, null, 1_992_000);
    expect(d?.differsFromStatic).toBe(true);
    expect(d?.capacityM3).toBe(2_158_000);
  });

  test('rate capped at 100% back-solves to the volume itself → null, never shown', () => {
    // 薗原ダム 2026-09-08: storCap 3,933 千m³ with storPcntIrr=100 (the feed
    // caps at 100). volume / 1.0 is the volume, not the 利水容量 (~3,000
    // 千m³ per the reporter's reverse-engineering), so there is nothing
    // truthful to display.
    expect(rateDenominator(3_933_000, 14_140_000, 3_933_000)).toBeNull();
  });

  test('a genuine >100% 利水 rate still yields a real denominator', () => {
    // 105% → back-solved capacity is below the volume; that is a real
    // season-aware figure (flood pool filling), keep it.
    const d = rateDenominator(3_745_714, 14_140_000, 3_933_000);
    expect(d?.differsFromStatic).toBe(true);
    expect(d?.capacityM3).toBe(3_745_714);
  });

  test('missing volume → cannot tell a capped rate apart → null', () => {
    expect(rateDenominator(2_158_000, 14_500_000, null)).toBeNull();
  });
});
