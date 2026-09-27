// Parser tests for 宮城県 農政部「農業用水の状況」.
//
// Runs against the real 令和8年9月15日現在 PDF and the index / report pages
// as captured on 2026-09-27 (tests/fixtures/miyagi_nousei). The PDF's reading
// order scatters the table, so positional line rebuilding is the risky half —
// a hand-written text fixture would not exercise it.

import { describe, expect, test } from 'bun:test';
import type { BindableMaster } from '@dam/core/dam_binding';
import {
  chooseMaster,
  findLatestReportUrl,
  findReportPdfUrl,
  parseMiyagiNouseiLines,
  pdfToLines,
} from './ingest_miyagi_nousei.ts';

const DIR = new URL('../../../../tests/fixtures/miyagi_nousei/', import.meta.url).pathname;

const lines = await pdfToLines(new Uint8Array(await Bun.file(`${DIR}r8_0915.pdf`).arrayBuffer()));
const parsed = parseMiyagiNouseiLines(lines);
const row = (name: string) => parsed.rows.find((r) => r.name === name);

describe('parseMiyagiNouseiLines — the real 令和8年9月15日 PDF', () => {
  test('dates the survey at 09:00 JST on the reported day', () => {
    // 「（令和８年９月１５日現在）」 + 「貯水量は午前9時現在値」.
    expect(parsed.reportDate?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  test('publishes all 17 dams and all 9 ため池, and nothing from the snow table', () => {
    expect(parsed.published).toHaveLength(26);
    expect(parsed.published).toContain('岩堂沢ダム');
    expect(parsed.published).toContain('孫沢溜池');
    expect(parsed.published.filter((n) => n === '栗駒ダム')).toHaveLength(1);
  });

  test('reads a dam row: 利水容量, volume, rate, level and flows in SI units', () => {
    // 岩堂沢ダム: 13,000 / 12,449 千m³, 95.8 %, EL 406.63 m, 0.76 / 2.19 m³/s.
    expect(row('岩堂沢ダム')).toEqual({
      name: '岩堂沢ダム',
      capacityM3: 13_000_000,
      storageVolumeM3: 12_449_000,
      storageRate: 0.958,
      waterLevelM: 406.63,
      inflowM3s: 0.76,
      outflowM3s: 2.19,
    });
  });

  test('keeps a dam the PDF clamps at 100 % when volume exceeds 利水容量', () => {
    // 村田ダム 1,518 / 1,507 千m³ is printed as 100.0 % (the PDF's own footnote).
    const r = row('村田ダム');
    expect(r?.storageVolumeM3).toBe(1_518_000);
    expect(r?.storageRate).toBe(1);
  });

  test('reads a ため池 row: no level or flows, capacity from 満水貯水量', () => {
    // 愛子ダム 1,080.0 / 824.0 千m³ = 76.3 %.
    expect(row('愛子ダム')).toEqual({
      name: '愛子ダム',
      capacityM3: 1_080_000,
      storageVolumeM3: 824_000,
      storageRate: 0.763,
      waterLevelM: null,
      inflowM3s: null,
      outflowM3s: null,
    });
    expect(row('孫沢溜池')?.storageRate).toBeCloseTo(0.217, 3);
  });

  test('every stored rate is volume / capacity, or the 100 % clamp', () => {
    expect(parsed.rows).toHaveLength(26);
    for (const r of parsed.rows) {
      const implied = r.storageVolumeM3 / r.capacityM3;
      if (r.storageRate === 1 && implied >= 1) continue;
      expect(Math.abs(implied - r.storageRate)).toBeLessThan(0.015);
    }
  });
});

describe('report discovery', () => {
  test('picks the newest 現在 report from the index, not the first link', async () => {
    const html = await Bun.file(`${DIR}yousui_index_20260927.html`).text();
    expect(findLatestReportUrl(html)).toBe(
      'https://www.pref.miyagi.jp/soshiki/nosonshin/yousui08-0915.html',
    );
  });

  test('finds the report PDF on the report page', async () => {
    const html = await Bun.file(`${DIR}yousui08-0915.html`).text();
    expect(findReportPdfUrl(html)).toBe('https://www.pref.miyagi.jp/documents/66918/202609015.pdf');
  });
});

describe('chooseMaster', () => {
  const m = (
    id: number,
    name: string,
    completedYear: number | null = null,
    stamp: string | null = null,
  ) => ({ id: BigInt(id), name, completedYear, stamp }) as BindableMaster;

  test('binds a ため池 printed as ダム to the master 溜池', () => {
    expect(chooseMaster('愛子ダム', [m(1, '愛子溜池'), m(2, '青下第1')])).toBe(1n);
  });

  test('prefers the exact stem over a longer name', () => {
    expect(chooseMaster('南川ダム', [m(1, '南川鞍部'), m(2, '南川')])).toBe(2n);
  });

  test('binds the completed （再） twin', () => {
    expect(chooseMaster('花山ダム', [m(1, '花山（元）', 1957), m(2, '花山（再）', 2020)])).toBe(2n);
  });

  test('a stamped row keeps the station', () => {
    expect(chooseMaster('南川ダム', [m(1, '南川鞍部', null, '南川ダム'), m(2, '南川')])).toBe(1n);
  });

  test('an unknown ため池 does not bind', () => {
    expect(chooseMaster('高松溜池', [m(1, '愛子溜池'), m(2, '孫沢溜池')])).toBeNull();
  });
});
