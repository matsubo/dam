// apps/worker/src/tasks/ingest_nara_kasen.test.ts
//
// Fixtures are verbatim Shift_JIS captures of the PC ダム現況表
// (servletBousaiTableStatus?dk=4): the latest table on 2026-09-27 16:30 and
// the 2026-01-15 10:00 table, where 天理ダム's row is blank (未入力).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  type ParsedRow,
  parseNaraTable,
  usableVolumeM3,
} from './ingest_nara_kasen.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/nara');

async function fixture(name: string): Promise<ParsedRow[]> {
  const buf = await readFile(join(FIXTURES, name));
  return parseNaraTable(new TextDecoder('shift_jis').decode(buf));
}

function row(rows: ParsedRow[], name: string): ParsedRow {
  const r = rows.find((x) => x.naraName === name);
  if (!r) throw new Error(`${name} not parsed`);
  return r;
}

describe('parseNaraTable', () => {
  test('parses all five dams with the year-bearing JST stamp', async () => {
    const rows = await fixture('dam_table_2026-09-27.shiftjis.html');
    expect(rows.map((r) => r.naraName)).toEqual([
      '初瀬ダム',
      '岩井川ダム',
      '天理ダム',
      '白川ダム',
      '大門ダム',
    ]);
    for (const r of rows) expect(r.observedAt.toISOString()).toBe('2026-09-27T07:30:00.000Z');
  });

  test('reads level, 貯水容量 / 空容量 in 10³ m³ as m³, and flows', async () => {
    const hase = row(await fixture('dam_table_2026-09-27.shiftjis.html'), '初瀬ダム');
    expect(hase.waterLevelM).toBeCloseTo(221.7);
    expect(hase.storedVolumeM3).toBe(2_015_000);
    expect(hase.emptyVolumeM3).toBe(2_375_000);
    expect(hase.inflowM3s).toBeCloseTo(0.32);
    expect(hase.outflowM3s).toBeCloseTo(0.32);
  });

  test('strips the trend arrow and padding from short values', async () => {
    const daimon = row(await fixture('dam_table_2026-09-27.shiftjis.html'), '大門ダム');
    expect(daimon.waterLevelM).toBeCloseTo(262.56);
    expect(daimon.storedVolumeM3).toBe(146_000);
    expect(daimon.emptyVolumeM3).toBe(3_000);
    expect(daimon.outflowM3s).toBe(0);
  });

  test('drops a blank (未入力) row and keeps the others', async () => {
    const rows = await fixture('dam_table_2026-01-15.shiftjis.html');
    expect(rows.map((r) => r.naraName).sort()).toEqual(
      ['初瀬ダム', '大門ダム', '岩井川ダム', '白川ダム'].sort(),
    );
    expect(row(rows, '初瀬ダム').observedAt.toISOString()).toBe('2026-01-15T01:00:00.000Z');
    expect(row(rows, '初瀬ダム').storedVolumeM3).toBe(1_504_000);
  });

  test('returns nothing for a page without the table', () => {
    expect(parseNaraTable('<html><body>no data</body></html>')).toHaveLength(0);
  });
});

// Master capacities are the dams rows (ダム便覧) for pref 29.
describe('usableVolumeM3', () => {
  test('subtracts 堆砂容量 when 貯水容量 + 空容量 equals the master 総貯水容量', async () => {
    const rows = await fixture('dam_table_2026-09-27.shiftjis.html');
    // 初瀬 2,015 + 2,375 = 4,390 千m³ = total; dead = 4,390 − 3,740 = 650 千m³.
    expect(
      usableVolumeM3(row(rows, '初瀬ダム'), {
        totalCapacityM3: 4_390_000,
        activeCapacityM3: 3_740_000,
      }),
    ).toBe(1_365_000);
    // 天理 1,037 + 1,463 = 2,500 = total; dead 250.
    expect(
      usableVolumeM3(row(rows, '天理ダム'), {
        totalCapacityM3: 2_500_000,
        activeCapacityM3: 2_250_000,
      }),
    ).toBe(787_000);
    // 岩井川 179 + 631 = 810 = total; dead 120.
    expect(
      usableVolumeM3(row(rows, '岩井川ダム'), {
        totalCapacityM3: 810_000,
        activeCapacityM3: 690_000,
      }),
    ).toBe(59_000);
  });

  test('stores nothing when the printed sum does not match the master total', async () => {
    const rows = await fixture('dam_table_2026-09-27.shiftjis.html');
    // 白川 338 + 1,222 = 1,560 千m³ (the prefecture's 総貯水容量) against
    // ダム便覧's 1,360, which leaves out the 200 千m³ 堆砂容量.
    expect(
      usableVolumeM3(row(rows, '白川ダム'), {
        totalCapacityM3: 1_360_000,
        activeCapacityM3: 1_360_000,
      }),
    ).toBeNull();
    // 大門 146 + 3 = 149 千m³: 空容量 is measured to 常時満水位, not サーチャージ, so the
    // zero of 貯水容量 cannot be tied to the master 177 / 148.
    expect(
      usableVolumeM3(row(rows, '大門ダム'), {
        totalCapacityM3: 177_000,
        activeCapacityM3: 148_000,
      }),
    ).toBeNull();
  });

  test('stores nothing without both master capacities', async () => {
    const hase = row(await fixture('dam_table_2026-09-27.shiftjis.html'), '初瀬ダム');
    expect(usableVolumeM3(hase, { totalCapacityM3: 4_390_000, activeCapacityM3: null })).toBeNull();
  });

  test('reads zero, not a negative volume, below 最低水位', () => {
    const drawnDown = { storedVolumeM3: 600_000, emptyVolumeM3: 3_790_000 };
    expect(
      usableVolumeM3(drawnDown, { totalCapacityM3: 4_390_000, activeCapacityM3: 3_740_000 }),
    ).toBe(0);
  });
});

describe('chooseMaster (#79)', () => {
  test('keeps the row already stamped with the station over a better name match', () => {
    const masters = [
      { id: 10307n, name: '白川（再）', completedYear: 1996, stamp: null },
      { id: 10308n, name: '白川溜池（元）', completedYear: 1933, stamp: '白川ダム' },
    ];
    expect(chooseMaster('白川', masters, '白川ダム')).toBe(10308n);
  });

  test('binds an equal-rank （元）/（再） pair to the completed （再）, not the lower id', () => {
    const masters = [
      { id: 10n, name: '天理（元）', completedYear: 1950, stamp: null },
      { id: 20n, name: '天理（再）', completedYear: 1978, stamp: null },
    ];
    expect(chooseMaster('天理', masters, '天理ダム')).toBe(20n);
  });
});
