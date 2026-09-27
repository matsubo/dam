import { describe, expect, test } from 'bun:test';
import { chooseRanked, preferMaster, stampedMaster, twinOf } from './dam_binding.ts';

const m = (
  id: number,
  name: string,
  completedYear: number | null = null,
  stamp: string | null = null,
) => ({
  id: BigInt(id),
  name,
  completedYear,
  stamp,
});

describe('twinOf', () => {
  test('reads the （元）/（再） marker, full- or half-width', () => {
    expect(twinOf('菅生（再）')).toEqual({ base: '菅生', marker: '再' });
    expect(twinOf('菅生(元)')).toEqual({ base: '菅生', marker: '元' });
  });
  test('other names are not twins', () => {
    expect(twinOf('長谷')).toBeNull();
    expect(twinOf('山梨（上）')).toBeNull();
  });
});

describe('preferMaster (tie-break at equal name rank)', () => {
  test('a completed （再） is the current structure', () => {
    const moto = m(1, '菅生（元）', 1968);
    const sai = m(2, '菅生（再）', 2010);
    expect(preferMaster(sai, moto, 2026)).toBe(true);
    expect(preferMaster(moto, sai, 2026)).toBe(false);
  });

  test('a （再） still under construction leaves the （元） current', () => {
    const moto = m(1, '佐久間（元）', 1956);
    const sai = m(2, '佐久間（再）', null);
    expect(preferMaster(moto, sai, 2026)).toBe(true);
    expect(preferMaster(sai, moto, 2026)).toBe(false);
  });

  test('a （再） completing in the future is not current yet', () => {
    expect(preferMaster(m(1, 'X（元）', 1960), m(2, 'X（再）', 2030), 2026)).toBe(true);
  });

  test('anything else falls back to the lower id', () => {
    expect(preferMaster(m(1, '長谷'), m(2, '長谷'), 2026)).toBe(true);
    expect(preferMaster(m(3, '長谷'), m(2, '長谷'), 2026)).toBe(false);
    // Different bases are not twins even with markers.
    expect(preferMaster(m(5, 'A（再）', 2000), m(4, 'B（元）'), 2026)).toBe(false);
  });
});

describe('stampedMaster', () => {
  test('the one row already stamped with this station wins', () => {
    const ms = [m(1, '長谷', null, null), m(2, '長谷', null, '長谷ダム')];
    expect(stampedMaster(ms, '長谷ダム')?.id).toBe(2n);
  });
  test('no stamp, or the same stamp on two rows, decides nothing', () => {
    expect(stampedMaster([m(1, '長谷'), m(2, '長谷')], '長谷ダム')).toBeNull();
    expect(stampedMaster([m(1, '長谷', null, 'k'), m(2, '長谷', null, 'k')], 'k')).toBeNull();
  });
});

describe('chooseRanked (curated SQL candidates carrying their own name rank)', () => {
  const r = (rank: number, ...args: Parameters<typeof m>) => ({ ...m(...args), rank });

  test('the lowest rank wins outright', () => {
    expect(chooseRanked([r(2, 1, '長谷ダム'), r(0, 2, '長谷')], 'k')?.id).toBe(2n);
  });
  test('twins at the same rank go to the completed （再）, not the lower id', () => {
    const rows = [r(2, 11336, '松原（元）', 1973), r(2, 11337, '松原（再）', 1984)];
    expect(chooseRanked(rows, 'k', 2026)?.id).toBe(11337n);
  });
  test('the row already stamped with the key beats a better rank', () => {
    const rows = [r(0, 1, '長谷'), r(5, 2, '長谷川', null, 'k')];
    expect(chooseRanked(rows, 'k')?.id).toBe(2n);
  });
  test('no candidates, no match', () => {
    expect(chooseRanked([], 'k')).toBeNull();
  });
});
