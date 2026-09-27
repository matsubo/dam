// apps/worker/src/tasks/ingest_nara_kasen.test.ts
//
// Fixtures are verbatim Shift_JIS captures of the PC ダム現況表
// (servletBousaiTableStatus?dk=4): the latest table on 2026-09-27 16:30, the
// 2026-01-15 10:00 table, where 天理ダム's row is blank (未入力), and the
// 2026-06-27 06:00 table (nw=0&tm=202606270600), with 初瀬, 天理 and 大門
// at or above 常時満水位 and 岩井川 blank.

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

// 有効貯水容量 is the master (ダム便覧) figure, equal to the prefecture's for
// every dam here: 初瀬 3,740 / 天理 2,250 / 岩井川 690 / 白川 1,360 / 大門 148 千m³.
describe('usableVolumeM3', () => {
  test('reads 有効 − 空容量 for the dams whose 空容量 counts down from サーチャージ', async () => {
    const rows = await fixture('dam_table_2026-09-27.shiftjis.html');
    // 初瀬 2,015 + 2,375 = 4,390 千m³: 3,740 − 2,375, i.e. 2,015 − 堆砂 650.
    expect(usableVolumeM3(row(rows, '初瀬ダム'), 3_740_000)).toBe(1_365_000);
    // 天理 1,037 + 1,463 = 2,500: 2,250 − 1,463 = 1,037 − 250.
    expect(usableVolumeM3(row(rows, '天理ダム'), 2_250_000)).toBe(787_000);
    // 岩井川 179 + 631 = 810: 690 − 631 = 179 − 120.
    expect(usableVolumeM3(row(rows, '岩井川ダム'), 690_000)).toBe(59_000);
    // 白川 338 + 1,222 = 1,560, the prefecture's 総貯水容量 (ダム便覧 says
    // 1,360, leaving out the 200 堆砂): 1,360 − 1,222 = 338 − 200.
    expect(usableVolumeM3(row(rows, '白川ダム'), 1_360_000)).toBe(138_000);
  });

  test('keeps counting above 常時満水位, where the flood pool starts filling', async () => {
    const rows = await fixture('dam_table_2026-06-27.shiftjis.html');
    // 初瀬 at EL 222.95, 1.35 m over 常時満水位 221.60: 空容量 2,193 is below
    // the 2,390 洪水調節容量, so it runs to サーチャージ. 3,740 − 2,193 = 2,197 − 650.
    expect(usableVolumeM3(row(rows, '初瀬ダム'), 3_740_000)).toBe(1_547_000);
    // 天理 at EL 255.02 ≈ 常時満水位 255.00: 空容量 1,298 ≈ 洪水調節容量 1,300,
    // and the usable 952 ≈ 維持 250 + 上水 700.
    expect(usableVolumeM3(row(rows, '天理ダム'), 2_250_000)).toBe(952_000);
  });

  test('stores nothing for 大門, whose 空容量 runs only to 常時満水位', async () => {
    // EL 262.56, 14 cm under 常時満水位 262.70: 146 + 3 = 149, short of the
    // 177 総貯水容量 by about the 30 千m³ flood pool; 148 − 3 would read 98 %.
    const below = row(await fixture('dam_table_2026-09-27.shiftjis.html'), '大門ダム');
    expect(usableVolumeM3(below, 148_000)).toBeNull();
    // EL 262.75, over 常時満水位: 空容量 is clamped at 0 while 貯水容量 goes on
    // rising (150), so 148 − 0 would read full on every flood.
    const above = row(await fixture('dam_table_2026-06-27.shiftjis.html'), '大門ダム');
    expect(above.emptyVolumeM3).toBe(0);
    expect(usableVolumeM3(above, 148_000)).toBeNull();
  });

  test('stores nothing when 貯水容量 + 空容量 stops adding up to 総貯水容量', () => {
    // 空容量 counted to the 有効 top instead: the zero it is measured against moved.
    const redefined = { naraName: '初瀬ダム', storedVolumeM3: 2_015_000, emptyVolumeM3: 1_725_000 };
    expect(usableVolumeM3(redefined, 3_740_000)).toBeNull();
  });

  test('stores nothing without the master 有効貯水容量', async () => {
    const hase = row(await fixture('dam_table_2026-09-27.shiftjis.html'), '初瀬ダム');
    expect(usableVolumeM3(hase, null)).toBeNull();
  });

  test('reads zero, not a negative volume, below 最低水位', () => {
    const drawnDown = { naraName: '初瀬ダム', storedVolumeM3: 600_000, emptyVolumeM3: 3_790_000 };
    expect(usableVolumeM3(drawnDown, 3_740_000)).toBe(0);
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
