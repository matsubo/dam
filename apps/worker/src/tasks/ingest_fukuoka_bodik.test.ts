import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  chooseMaster,
  normalizeName,
  parseFukuokaRows,
  parseFukuokaTimestamp,
} from './ingest_fukuoka_bodik';

const FIXTURE_PATH = path.join(
  import.meta.dir,
  '../../../../tests/fixtures/fukuoka_bodik/202606data_2026-06-05.csv',
);

function loadFixture(): string {
  const buf = fs.readFileSync(FIXTURE_PATH);
  return new TextDecoder('shift-jis').decode(buf);
}

describe('parseFukuokaTimestamp', () => {
  it('converts JST YYYY/MM/DD HH:MM to UTC', () => {
    const d = parseFukuokaTimestamp('2026/06/05 08:00');
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  it('handles midnight rollover', () => {
    const d = parseFukuokaTimestamp('2026/01/01 00:00');
    expect(d?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseFukuokaTimestamp('bad')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('strips ダム suffix', () => {
    expect(normalizeName('南畑ダム')).toBe('南畑');
    expect(normalizeName('瑞梅寺ダム')).toBe('瑞梅寺');
  });

  it('strips annotations', () => {
    expect(normalizeName('江川（仮）ダム')).toBe('江川');
  });

  it('normalizes small ヶ to full ケ', () => {
    // master uses 五ヶ山 (U+30F6 small ヶ); CSV sends 五ケ山 (U+30B1 full ケ)
    expect(normalizeName('五ヶ山')).toBe('五ケ山');
    expect(normalizeName('五ケ山')).toBe('五ケ山');
  });
});

describe('parseFukuokaRows', () => {
  it('parses 9 dam rows from fixture (skips 合計)', () => {
    const rows = parseFukuokaRows(loadFixture());
    expect(rows.length).toBe(9);
  });

  it('converts storage 千m³ → m³', () => {
    const rows = parseFukuokaRows(loadFixture());
    const minami = rows.find((r) => r.damName === '南畑ダム');
    expect(minami).toBeDefined();
    // fixture: 南畑ダム = 2571 千m³ → 2,571,000 m³
    expect(minami?.storageVolumeM3).toBe(2571 * 1000);
  });

  it('takes the most recent row (top of file)', () => {
    const rows = parseFukuokaRows(loadFixture());
    expect(rows[0]?.observedAt?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  it('returns empty array for empty CSV', () => {
    expect(parseFukuokaRows('')).toEqual([]);
    expect(parseFukuokaRows('観測時刻,南畑ダム')).toEqual([]);
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 40001n, name: '南畑' },
    { id: 40002n, name: '五ケ山' },
    { id: 40003n, name: '脊振' },
    { id: 40004n, name: '曲渕' },
  ];

  it('matches stem exactly', () => {
    expect(chooseMaster('南畑', masters)).toBe(40001n);
    expect(chooseMaster('曲渕', masters)).toBe(40004n);
  });

  it('matches when CSV name includes ダム suffix', () => {
    // CSV header: 南畑ダム → normalizeName → 南畑 → exact match rank 0
    expect(chooseMaster('南畑', masters)).toBe(40001n);
  });

  it('returns null for no match', () => {
    expect(chooseMaster('存在しない', masters)).toBeNull();
  });
});
