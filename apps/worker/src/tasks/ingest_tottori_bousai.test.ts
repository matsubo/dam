import { describe, expect, it } from 'bun:test';
import listFixture from '../../../../tests/fixtures/tottori_bousai/list_2026-06-05-08-20.json';
// Two of the hourly lists 鳥取県防災Web never completed: total=2 instead of 6,
// with a zero-level placeholder in place of real telemetry.
import partialCopied from '../../../../tests/fixtures/tottori_bousai/list_2026-09-23-14-20.json';
import partialPlaceholder from '../../../../tests/fixtures/tottori_bousai/list_2026-09-27-12-20.json';
import {
  chooseMaster,
  normalizeName,
  parseTottoriItems,
  parseTottoriTimestamp,
} from './ingest_tottori_bousai';

describe('parseTottoriTimestamp', () => {
  it('converts JST to UTC', () => {
    const d = parseTottoriTimestamp('2026-06-05 08:20:00');
    expect(d?.toISOString()).toBe('2026-06-04T23:20:00.000Z');
  });

  it('handles midnight JST', () => {
    const d = parseTottoriTimestamp('2026-01-01 00:00:00');
    expect(d?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseTottoriTimestamp('bad')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('strips ダム suffix', () => {
    expect(normalizeName('百谷ダム')).toBe('百谷');
    expect(normalizeName('菅沢ダム')).toBe('菅沢');
  });

  it('strips annotations', () => {
    expect(normalizeName('狭山池（再）')).toBe('狭山池');
    expect(normalizeName('狭山池（元）')).toBe('狭山池');
  });

  it('preserves plain name', () => {
    expect(normalizeName('東郷')).toBe('東郷');
  });
});

describe('parseTottoriItems', () => {
  it('parses all 6 fixture dams', () => {
    const rows = parseTottoriItems(listFixture.items as Parameters<typeof parseTottoriItems>[0]);
    expect(rows.length).toBe(6);
  });

  it('converts storage 千m³ → m³', () => {
    const rows = parseTottoriItems(listFixture.items as Parameters<typeof parseTottoriItems>[0]);
    const sugisawa = rows.find((r) => r.observatoryName === '菅沢ダム');
    expect(sugisawa).toBeDefined();
    // fixture damEffectiveStorageQuantities: 10604 千m³ → 10,604,000 m³
    expect(sugisawa?.storageVolumeM3).toBe(10604 * 1000);
  });

  it('stores rate as fraction 0-1', () => {
    const rows = parseTottoriItems(listFixture.items as Parameters<typeof parseTottoriItems>[0]);
    for (const r of rows) {
      if (r.storageRate != null) {
        expect(r.storageRate).toBeGreaterThanOrEqual(0);
        expect(r.storageRate).toBeLessThanOrEqual(1);
      }
    }
    // 菅沢: 68.8% → 0.688
    const sugisawa = rows.find((r) => r.observatoryName === '菅沢ダム');
    expect(sugisawa?.storageRate).toBeCloseTo(0.688, 3);
  });

  it('prefers 利水容量貯水率 over 有効容量貯水率', () => {
    // 鳥取県防災Web publishes both columns; today every dam reports
    // storageRateWaterUseCapacity as null/flg=2, so this only bites when the
    // 利水 column starts arriving. 有効 divides by the full 有効貯水容量 and
    // understates flood-control dams — same inversion as issue #19.
    const [base] = listFixture.items as Parameters<typeof parseTottoriItems>[0];
    if (!base) throw new Error('fixture missing');
    const rows = parseTottoriItems([
      {
        ...base,
        storageRateEffectiveCapacity: 31.0,
        storageRateEffectiveCapacityFlg: '0',
        storageRateWaterUseCapacity: 96.2,
        storageRateWaterUseCapacityFlg: '0',
      },
    ]);
    expect(rows[0]?.storageRate).toBeCloseTo(0.962, 3);
  });

  it('falls back to 有効容量貯水率 when 利水 is unpublished', () => {
    const [base] = listFixture.items as Parameters<typeof parseTottoriItems>[0];
    if (!base) throw new Error('fixture missing');
    const rows = parseTottoriItems([
      {
        ...base,
        storageRateEffectiveCapacity: 31.0,
        storageRateEffectiveCapacityFlg: '0',
        storageRateWaterUseCapacity: null,
        storageRateWaterUseCapacityFlg: '2',
      },
    ]);
    expect(rows[0]?.storageRate).toBeCloseTo(0.31, 3);
  });

  it('observatoryId is stringified', () => {
    const rows = parseTottoriItems(listFixture.items as Parameters<typeof parseTottoriItems>[0]);
    expect(rows[0]?.observatoryId).toBe('71001');
  });

  type Items = Parameters<typeof parseTottoriItems>[0];

  it('drops the zero-level placeholder of an incomplete list, keeps real rows', () => {
    // 09-27 12:20: 朝鍋 reads 0 m / 0 千m³ against its own 最低水位 97.0 m,
    // while 菅沢 carries real telemetry (356.2 m, between 11:20's 356.18 and
    // 13:20's 356.22 in the complete lists).
    const rows = parseTottoriItems(partialPlaceholder.items as Items);
    expect(rows.map((r) => r.observatoryName)).toEqual(['菅沢ダム']);
    expect(rows[0]?.waterLevelM).toBeCloseTo(356.2, 2);
    expect(rows[0]?.storageVolumeM3).toBe(429_000);
  });

  it('drops placeholder rows even when their other fields look plausible', () => {
    // 09-23 14:20: both items are 0 m / 0 千m³ and 菅沢 carries 朝鍋's
    // 24 % / 0.08 / 0.07 verbatim — none of it is 菅沢's.
    expect(parseTottoriItems(partialCopied.items as Items)).toEqual([]);
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 10979n, name: '菅沢' },
    { id: 10980n, name: '百谷' },
    { id: 10981n, name: '佐治川' },
    { id: 10982n, name: '東郷' },
  ];

  it('exact stem match wins', () => {
    expect(chooseMaster('菅沢', masters)).toBe(10979n);
    expect(chooseMaster('東郷', masters)).toBe(10982n);
  });

  it('matches stem-only master for ダム-suffix input', () => {
    expect(chooseMaster('百谷', masters)).toBe(10980n);
  });

  it('returns null for no match', () => {
    expect(chooseMaster('存在しない', masters)).toBeNull();
  });
});
