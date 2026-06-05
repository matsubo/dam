import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  chooseMaster,
  normalizeName,
  parseShimaneItems,
  parseShimaneTimestamp,
} from './ingest_shimane_bousai';

const FIXTURE_DIR = path.join(import.meta.dir, '../../../../tests/fixtures/shimane_bousai');

function loadList(): { items: Parameters<typeof parseShimaneItems>[0] } {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'list_2026-06-05-08-00.json'), 'utf8'));
}

describe('parseShimaneTimestamp', () => {
  it('converts JST YYYY-MM-DD HH:MM:SS to UTC', () => {
    const d = parseShimaneTimestamp('2026-06-05 08:00:00');
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  it('handles midnight rollover', () => {
    const d = parseShimaneTimestamp('2026-01-01 00:00:00');
    expect(d?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseShimaneTimestamp('bad')).toBeNull();
    expect(parseShimaneTimestamp('')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('strips ダム suffix', () => {
    expect(normalizeName('布部ダム')).toBe('布部');
    expect(normalizeName('第二浜田ダム')).toBe('第二浜田');
    expect(normalizeName('益田川ダム')).toBe('益田川');
  });

  it('strips annotations', () => {
    expect(normalizeName('銚子（隠岐）ダム')).toBe('銚子');
  });

  it('is a no-op on bare names', () => {
    expect(normalizeName('布部')).toBe('布部');
  });
});

describe('parseShimaneItems', () => {
  it('parses 14 dam rows from fixture', () => {
    const rows = parseShimaneItems(loadList().items);
    expect(rows.length).toBe(14);
  });

  it('converts storage 千m³ → m³', () => {
    const rows = parseShimaneItems(loadList().items);
    const yatoRow = rows.find((r) => r.observatoryName === '八戸ダム');
    expect(yatoRow).toBeDefined();
    // fixture: 八戸ダム = 21440 千m³ → 21,440,000 m³
    expect(yatoRow?.storageVolumeM3).toBe(21440 * 1000);
  });

  it('converts storageRate % → 0-1 fraction', () => {
    const rows = parseShimaneItems(loadList().items);
    const hamaRow = rows.find((r) => r.observatoryName === '浜田ダム');
    expect(hamaRow?.storageRate).toBeCloseTo(0.55, 5);
  });

  it('stringifies observatoryId', () => {
    const rows = parseShimaneItems(loadList().items);
    expect(typeof rows[0]?.observatoryId).toBe('string');
    expect(rows[0]?.observatoryId).toBe('32001');
  });

  it('drops rows where all fields are null/flagged', () => {
    const nullItem = {
      name: '欠測ダム',
      observatoryId: 99999,
      managerCd: '40',
      dataTimestamp: '2026-06-05 08:00:00',
      damQuantitiesLevel: null,
      damQuantitiesLevelFlg: '1',
      damInflowQuantities: null,
      damInflowQuantitiesFlg: '1',
      damTotalReleaseQuantities: null,
      damTotalReleaseQuantitiesFlg: '1',
      damEffectiveStorageQuantities: null,
      damEffectiveStorageQuantitiesFlg: '1',
      storageRateEffectiveCapacity: null,
      storageRateEffectiveCapacityFlg: '1',
      storageRateWaterUseCapacity: null,
      storageRateWaterUseCapacityFlg: '1',
    };
    expect(parseShimaneItems([nullItem])).toHaveLength(0);
  });

  it('timestamp in parsed rows matches fixture', () => {
    const rows = parseShimaneItems(loadList().items);
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 32001n, name: '布部ダム' },
    { id: 32002n, name: '山佐ダム' },
    { id: 32003n, name: '三瓶ダム' },
    { id: 32008n, name: '大長見ダム' },
    { id: 32010n, name: '益田川ダム' },
  ];

  it('matches exact stem (ダム stripped from master)', () => {
    expect(chooseMaster('布部', masters)).toBe(32001n);
    expect(chooseMaster('山佐', masters)).toBe(32002n);
  });

  it('matches multi-kanji dam names', () => {
    expect(chooseMaster('大長見', masters)).toBe(32008n);
    expect(chooseMaster('益田川', masters)).toBe(32010n);
  });

  it('returns null for no match', () => {
    expect(chooseMaster('存在しない', masters)).toBeNull();
  });

  it('tie-breaks by lower id', () => {
    const ties = [
      { id: 5n, name: '大長見上ダム' },
      { id: 3n, name: '大長見下ダム' },
    ];
    // Both include '大長見' → rank 3; lower id wins
    expect(chooseMaster('大長見', ties)).toBe(3n);
  });
});
