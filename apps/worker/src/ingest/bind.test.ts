import { describe, expect, test } from 'bun:test';
import { type Binding, bindEntry, type Master } from './bind.ts';

let nextId = 1n;
function master(name: string, extra: Partial<Master> = {}): Master {
  return {
    id: nextId++,
    name,
    prefCode: '33',
    ndi: null,
    stamp: null,
    completedYear: null,
    totalCapacityM3: null,
    activeCapacityM3: null,
    ...extra,
  };
}

const bound = (r: Binding) => (r.dam ? r.dam.name : null);
const entry = (name: string, extra: object = {}) => ({
  key: `k-${name}`,
  name,
  pref: '33',
  ...extra,
});

describe('bindEntry', () => {
  test('climbs the rungs: exact name, stem, stem+ダム, prefix, contains', () => {
    const masters = [
      master('旭川ダム'),
      master('黒谷池（元）'),
      master('湯原'),
      master('上長田調整池'),
    ];
    expect(bound(bindEntry(entry('旭川ダム'), masters, false))).toBe('旭川ダム');
    expect(bound(bindEntry(entry('旭川'), masters, false))).toBe('旭川ダム');
    expect(bound(bindEntry(entry('湯原ダム'), masters, false))).toBe('湯原');
    expect(bound(bindEntry(entry('黒谷'), masters, false))).toBe('黒谷池（元）');
    expect(bound(bindEntry(entry('長田'), masters, false))).toBe('上長田調整池');
  });

  test('an exact stem beats a prefix match that sorts first', () => {
    const masters = [master('黒谷池'), master('黒谷')];
    expect(bound(bindEntry(entry('黒谷ダム'), masters, false))).toBe('黒谷');
  });

  test('folds 槇/槙 and strips manager annotations', () => {
    const masters = [master('槇谷')];
    expect(bound(bindEntry(entry('槙谷ダム(国)'), masters, false))).toBe('槇谷');
  });

  test('exact stops before prefix and contains', () => {
    const masters = [master('日野川脇')];
    expect(bindEntry(entry('日野川', { bind: { exact: true } }), masters, false).dam).toBeNull();
    expect(bound(bindEntry(entry('日野川'), masters, false))).toBe('日野川脇');
  });

  test('a （元）/（再） pair goes to the live twin', () => {
    const masters = [master('佐久間（元）'), master('佐久間（再）', { completedYear: 2001 })];
    expect(bound(bindEntry(entry('佐久間'), masters, false, 2026))).toBe('佐久間（再）');
    const building = [master('鶴田（元）'), master('鶴田（再）', { completedYear: null })];
    expect(bound(bindEntry(entry('鶴田'), building, false, 2026))).toBe('鶴田（元）');
  });

  test('a tie between two different dams leaves the entry unbound', () => {
    const masters = [master('長谷'), master('長谷')];
    const r = bindEntry(entry('長谷'), masters, false);
    expect(r.dam).toBeNull();
  });

  test('the stamp holds against a better name match; a pin beats the stamp', () => {
    const stamped = master('長谷', { stamp: 'S1' });
    const named = master('長谷ダム');
    const pinned = master('別名', { ndi: '3300000001', prefCode: '13' });
    const masters = [stamped, named, pinned];
    expect(bindEntry({ key: 'S1', name: '長谷ダム', pref: '33' }, masters, false).dam).toBe(
      stamped,
    );
    expect(
      bindEntry(
        { key: 'S1', name: '長谷ダム', pref: '33', bind: { ndi: '3300000001' } },
        masters,
        false,
      ).dam,
    ).toBe(pinned);
  });

  test('searches only the entry’s prefectures', () => {
    const masters = [master('中里', { prefCode: '20' }), master('中里', { prefCode: '24' })];
    expect(bindEntry(entry('中里', { pref: '24' }), masters, false).dam?.prefCode).toBe('24');
  });

  test('a key marked not-a-dam binds only by stamp, never by name', () => {
    const masters = [master('呑吐')];
    expect(bindEntry(entry('呑吐'), masters, true).dam).toBeNull();
    const stamped = [master('呑吐', { stamp: 'k-呑吐' })];
    expect(bound(bindEntry(entry('呑吐'), stamped, true))).toBe('呑吐');
  });

  test("'never' stays unresolved even when a same-name master exists", () => {
    expect(bindEntry(entry('村山', { bind: 'never' }), [master('村山')], false).dam).toBeNull();
  });
});
