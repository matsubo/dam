import { describe, expect, it } from 'bun:test';
import listFixture from '../../../../tests/fixtures/hiroshima/list_2026-06-05-08-10.json';
import {
  chooseMaster,
  normalizeName,
  parseHiroshimaItems,
  parseHiroshimaTimestamp,
} from './ingest_hiroshima';

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

describe('normalizeName', () => {
  it('strips ダム suffix', () => {
    expect(normalizeName('小瀬川ダム')).toBe('小瀬川');
  });

  it('strips annotations', () => {
    expect(normalizeName('三川（再）ダム')).toBe('三川');
    expect(normalizeName('三川（再）')).toBe('三川');
  });

  it('preserves plain name', () => {
    expect(normalizeName('椋梨')).toBe('椋梨');
  });
});

describe('parseHiroshimaItems', () => {
  it('parses all 18 fixture dams', () => {
    const rows = parseHiroshimaItems(
      listFixture.items as Parameters<typeof parseHiroshimaItems>[0],
    );
    expect(rows.length).toBe(18);
  });

  it('converts storage 千m³ → m³', () => {
    const rows = parseHiroshimaItems(
      listFixture.items as Parameters<typeof parseHiroshimaItems>[0],
    );
    const kose = rows.find((r) => r.observatoryName === '小瀬川ダム');
    expect(kose).toBeDefined();
    // fixture storage: 2069 千m³ → 2,069,000 m³
    expect(kose?.storageVolumeM3).toBe(2069 * 1000);
  });

  it('stores rate as fraction 0-1', () => {
    const rows = parseHiroshimaItems(
      listFixture.items as Parameters<typeof parseHiroshimaItems>[0],
    );
    const kose = rows.find((r) => r.observatoryName === '小瀬川ダム');
    // fixture storageRateWaterUseCapacity: 60.9 → 0.609
    expect(kose?.storageRate).toBeCloseTo(0.609, 3);
  });

  it('prefers the 利水容量 rate over the 有効容量 one', () => {
    // 広島県 publishes both for every dam and they diverge widely — 御調ダム read
    // 利水 100.0 / 有効 20.4 on 2026-09-11 09:00. The prefecture's own table lists
    // the 利水 column first, and it is the season-aware figure (see #17/#19).
    const rows = parseHiroshimaItems([
      {
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
      },
    ] as Parameters<typeof parseHiroshimaItems>[0]);
    expect(rows[0]?.storageRate).toBeCloseTo(1.0, 6);
  });

  it('falls back to the 有効容量 rate when 利水 is flagged invalid', () => {
    const rows = parseHiroshimaItems([
      {
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
        storageRateWaterUseCapacity: null,
        storageRateWaterUseCapacityFlg: '2',
      },
    ] as Parameters<typeof parseHiroshimaItems>[0]);
    expect(rows[0]?.storageRate).toBeCloseTo(0.204, 6);
  });

  it('observatoryId is stringified', () => {
    const rows = parseHiroshimaItems(
      listFixture.items as Parameters<typeof parseHiroshimaItems>[0],
    );
    expect(rows[0]?.observatoryId).toBe('70001');
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 1n, name: '小瀬川' },
    { id: 2n, name: '三川（再）' },
    { id: 3n, name: '魚切' },
    { id: 4n, name: '土師' },
  ];

  it('exact stem match wins', () => {
    expect(chooseMaster('小瀬川', masters)).toBe(1n);
    expect(chooseMaster('魚切', masters)).toBe(3n);
  });

  it('matches annotated master via stem', () => {
    // 三川ダム → stem=三川 → matches 三川（再） whose normalized stem = 三川
    expect(chooseMaster('三川', masters)).toBe(2n);
  });

  it('returns null for no match', () => {
    expect(chooseMaster('存在しない', masters)).toBeNull();
  });
});
