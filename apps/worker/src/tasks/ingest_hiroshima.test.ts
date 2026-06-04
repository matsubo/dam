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
    // fixture storageRateEffectiveCapacity: 20.9 → 0.209
    expect(kose?.storageRate).toBeCloseTo(0.209, 3);
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
