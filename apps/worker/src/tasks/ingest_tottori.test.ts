import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTottoriAllPage } from './ingest_tottori';

const FIXTURE = readFileSync(
  join(import.meta.dir, '../../../../tests/fixtures/tottori_dam/data10all.html'),
  'utf8',
);

const NAMES = new Set(['賀祥ダム', '朝鍋ダム', '佐治川ダム', '東郷ダム', '百谷ダム']);

describe('parseTottoriAllPage', () => {
  it('parses every dam in the 10分データ全ダム一覧 table', () => {
    const rows = parseTottoriAllPage(FIXTURE, NAMES);
    expect(rows.map((r) => r.tottoriName).sort()).toEqual(
      ['佐治川ダム', '東郷ダム', '朝鍋ダム', '百谷ダム', '賀祥ダム'].sort(),
    );
  });

  it('reads 賀祥ダム the way the prefecture publishes it', () => {
    // The top page's <area alt> reported 452 千m³ / 07 % for this same reading,
    // which contradicts its own 空容量 (452 + 5,480 ≠ 6,690). The table page is
    // self-consistent and matches 鳥取県防災Web's 18 %.
    const kasho = parseTottoriAllPage(FIXTURE, NAMES).find((r) => r.tottoriName === '賀祥ダム');
    expect(kasho?.storageVolumeM3).toBe(1_210_000);
    expect(kasho?.effectiveCapacityM3).toBe(6_690_000);
    expect(kasho?.storageRate).toBeCloseTo(0.18, 6);
    expect(kasho?.waterLevelM).toBe(107.89);
    expect(kasho?.inflowM3s).toBe(0.7);
    expect(kasho?.outflowM3s).toBe(0.7);
    expect(kasho?.observedAt.toISOString()).toBe('2026-09-11T00:20:00.000Z');
  });

  it('keeps single-digit columns and blank 下流水位 cells from breaking a row', () => {
    const sajigawa = parseTottoriAllPage(FIXTURE, NAMES).find(
      (r) => r.tottoriName === '佐治川ダム',
    );
    expect(sajigawa?.storageVolumeM3).toBe(111_000);
    expect(sajigawa?.storageRate).toBeCloseTo(0.06, 6);
    expect(sajigawa?.rainfallMm).toBe(0);
  });

  it('ignores dams that are not in the master set', () => {
    const rows = parseTottoriAllPage(FIXTURE, new Set(['賀祥ダム']));
    expect(rows).toHaveLength(1);
  });

  it('drops a 貯水率 the row’s own 有効貯水容量 contradicts', () => {
    // Synthetic: a row whose 貯水率 no longer matches the volume and capacity
    // printed beside it. (The top page's 賀祥 block was self-consistent in these
    // three fields — 452 / 6,690 really is 07 % — so it is not this case.)
    const broken = FIXTURE.replace(
      '<td class="data"> 1210</td>\n<td class="data">6690</td>',
      '<td class="data"> 452</td>\n<td class="data">6690</td>',
    );
    const kasho = parseTottoriAllPage(broken, NAMES).find((r) => r.tottoriName === '賀祥ダム');
    expect(kasho?.storageVolumeM3).toBe(452_000);
    expect(kasho?.storageRate).toBeNull();
  });

  it('returns nothing when the page has no table', () => {
    expect(parseTottoriAllPage('<html><body>maintenance</body></html>', NAMES)).toEqual([]);
  });
});
