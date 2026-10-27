// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, it } from 'bun:test';
import listFixture from '../../../../tests/fixtures/hiroshima/list_2026-06-05-08-10.json';
import type { Reading } from '../ingest/types.ts';
import {
  type HiroshimaItem,
  hiroshimaEntries,
  hiroshimaReading,
  parseHiroshimaTimestamp,
} from './ingest_hiroshima';

const entries = () => hiroshimaEntries(listFixture.items as HiroshimaItem[]);

function observation(r: Reading | undefined | unknown) {
  const reading = r as Reading | undefined;
  if (reading?.state !== 'values') throw new Error('no values');
  const o = reading.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

const MITSUGI: HiroshimaItem = {
  name: '御調ダム',
  observatoryId: 70010,
  managerCd: '30',
  dataTimestamp: '2026-09-11 09:00:00',
  damQuantitiesLevel: null,
  damQuantitiesLevelFlg: '2',
  damInflowQuantities: null,
  damInflowQuantitiesFlg: '2',
  damTotalReleaseQuantities: null,
  damTotalReleaseQuantitiesFlg: '2',
  damEffectiveStorageQuantities: 917,
  damEffectiveStorageQuantitiesFlg: '0',
  storageRateEffectiveCapacity: 20.4,
  storageRateEffectiveCapacityFlg: '0',
  storageRateWaterUseCapacity: 100.0,
  storageRateWaterUseCapacityFlg: '0',
};

describe('parseHiroshimaTimestamp', () => {
  it('converts JST to UTC', () => {
    const d = parseHiroshimaTimestamp('2026-06-05 08:10:00');
    expect(d?.toISOString()).toBe('2026-06-04T23:10:00.000Z');
  });

  it('handles midnight JST', () => {
    const d = parseHiroshimaTimestamp('2026-01-01 00:00:00');
    expect(d?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseHiroshimaTimestamp('bad')).toBeNull();
  });
});

describe('hiroshimaEntries', () => {
  it('lists all 18 fixture dams, every one with values', () => {
    const list = entries();
    expect(list.length).toBe(18);
    expect(list.every((e) => (e.reading as Reading).state === 'values')).toBe(true);
    expect(list.every((e) => e.pref === '34')).toBe(true);
  });

  it('converts storage 千m³ → m³', () => {
    const kose = entries().find((e) => e.name === '小瀬川ダム');
    // fixture storage: 2069 千m³ → 2,069,000 m³
    expect(observation(kose?.reading).storageVolumeM3).toBe(2069 * 1000);
  });

  it('stores rate as fraction 0-1', () => {
    const kose = entries().find((e) => e.name === '小瀬川ダム');
    // fixture storageRateWaterUseCapacity: 60.9 → 0.609
    expect(observation(kose?.reading).storageRate).toBeCloseTo(0.609, 3);
  });

  it('keys by the stringified observatoryId', () => {
    expect(entries()[0]?.key).toBe('70001');
  });
});

describe('hiroshimaReading', () => {
  it('prefers the 利水容量 rate over the 有効容量 one', () => {
    // 広島県 publishes both for every dam and they diverge widely — 御調ダム read
    // 利水 100.0 / 有効 20.4 on 2026-09-11 09:00. The prefecture's own table lists
    // the 利水 column first, and it is the season-aware figure (see #17/#19).
    expect(observation(hiroshimaReading(MITSUGI)).storageRate).toBeCloseTo(1.0, 6);
  });

  it('falls back to the 有効容量 rate when 利水 is flagged invalid', () => {
    const r = hiroshimaReading({
      ...MITSUGI,
      storageRateWaterUseCapacity: null,
      storageRateWaterUseCapacityFlg: '2',
    });
    expect(observation(r).storageRate).toBeCloseTo(0.204, 6);
  });

  it('a dam flagged on every field is provider-marked empty', () => {
    const r = hiroshimaReading({
      ...MITSUGI,
      damEffectiveStorageQuantitiesFlg: '1',
      storageRateEffectiveCapacityFlg: '3',
      storageRateWaterUseCapacityFlg: '2',
    });
    expect(r.state).toBe('empty');
  });

  it('an unparseable timestamp is unreadable', () => {
    expect(hiroshimaReading({ ...MITSUGI, dataTimestamp: 'bad' }).state).toBe('unreadable');
  });
});
