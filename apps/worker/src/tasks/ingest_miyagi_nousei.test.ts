// Fixture → universe entries for 宮城県 農政部「農業用水の状況」, no database:
// binding and writing belong to the ingest run.
//
// Runs against the real 令和8年9月15日現在 PDF and the index / report pages
// as captured on 2026-09-27 (tests/fixtures/miyagi_nousei). The PDF's reading
// order scatters the table, so positional line rebuilding is the risky half —
// a hand-written text fixture would not exercise it.

import { describe, expect, test } from 'bun:test';
import type { Observed } from '../ingest/types.ts';
import {
  findLatestReportUrl,
  findReportPdfUrl,
  miyagiNouseiEntries,
  parseMiyagiNouseiLines,
  pdfToLines,
} from './ingest_miyagi_nousei.ts';

const DIR = new URL('../../../../tests/fixtures/miyagi_nousei/', import.meta.url).pathname;

const lines = await pdfToLines(new Uint8Array(await Bun.file(`${DIR}r8_0915.pdf`).arrayBuffer()));
const entries = miyagiNouseiEntries(lines);

function observed(name: string): Observed | undefined {
  const r = entries.find((e) => e.name === name)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') return undefined;
  return r.observations[0];
}

describe('miyagiNouseiEntries — the real 令和8年9月15日 PDF', () => {
  test('dates the survey at 09:00 JST on the reported day', () => {
    // 「（令和８年９月１５日現在）」 + 「貯水量は午前9時現在値」.
    expect(parseMiyagiNouseiLines(lines).reportDate?.toISOString()).toBe(
      '2026-09-15T00:00:00.000Z',
    );
    expect(observed('岩堂沢ダム')?.observedAt.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  test('lists all 17 dams and all 9 ため池, and nothing from the snow table', () => {
    const names = entries.map((e) => e.name);
    expect(names).toHaveLength(26);
    expect(names).toContain('岩堂沢ダム');
    expect(names).toContain('孫沢溜池');
    expect(names.filter((n) => n === '栗駒ダム')).toHaveLength(1);
    for (const e of entries) {
      expect(e.pref).toBe('04');
      expect(e.key).toBe(e.name);
    }
  });

  test('reads a dam row: volume, rate, level and flows in SI units', () => {
    // 岩堂沢ダム: 13,000 / 12,449 千m³, 95.8 %, EL 406.63 m, 0.76 / 2.19 m³/s.
    expect(observed('岩堂沢ダム')).toEqual({
      observedAt: new Date('2026-09-15T00:00:00.000Z'),
      storageVolumeM3: 12_449_000,
      storageRate: 0.958,
      waterLevelM: 406.63,
      inflowM3s: 0.76,
      outflowM3s: 2.19,
    });
  });

  test('keeps a dam the PDF clamps at 100 % when volume exceeds 利水容量', () => {
    // 村田ダム 1,518 / 1,507 千m³ is printed as 100.0 % (the PDF's own footnote).
    expect(observed('村田ダム')?.storageVolumeM3).toBe(1_518_000);
    expect(observed('村田ダム')?.storageRate).toBe(1);
  });

  test('reads a ため池 row: no level or flows', () => {
    // 愛子ダム 1,080.0 / 824.0 千m³ = 76.3 %.
    expect(observed('愛子ダム')).toEqual({
      observedAt: new Date('2026-09-15T00:00:00.000Z'),
      storageVolumeM3: 824_000,
      storageRate: 0.763,
    });
    expect(observed('孫沢溜池')?.storageRate).toBeCloseTo(0.217, 3);
  });

  test('every row reads: rate is volume / capacity, or the 100 % clamp', () => {
    for (const e of entries) expect(observed(e.name)).toBeDefined();
  });

  test('a row whose rate contradicts its own figures is unreadable, still listed', () => {
    const broken = miyagiNouseiEntries(lines.map((l) => l.replace('76.3%', '40.0%')));
    const r = broken.find((e) => e.name === '愛子ダム')?.reading;
    expect(r && typeof r !== 'function' ? r.state : null).toBe('unreadable');
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
