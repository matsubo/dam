// apps/worker/src/tasks/ingest_cgr_okakawa.test.ts
//
// Fixture is the verbatim PDF 国土交通省 岡山河川事務所 publishes as
// 「三水系の主要ダムの貯水状況」 (kassui_pdf/3kasenndamukeika.pdf), captured
// 2026-09-27 — the 2026-09-25 午前9時 edition. Parsing runs through unpdf, so
// the test covers the extraction order as well as the line parser: unpdf emits
// the 湯原 row with its 貯水率 and 前日との増減 *before* the dam name.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  assertUsableRows,
  chooseMaster,
  parseOkakawaDate,
  parseOkakawaPdfText,
  pdfToText,
} from './ingest_cgr_okakawa.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/okakawa_kassui/3kasenndamukeika_2026-09-25.pdf',
);

const text = await pdfToText(new Uint8Array(await Bun.file(FIXTURE).arrayBuffer()));
const parsed = parseOkakawaPdfText(text);
const row = (name: string) => parsed.rows.find((r) => r.name === name);

describe('parseOkakawaDate', () => {
  test('reads the full-width 午前 header as JST', () => {
    expect(parseOkakawaDate('(2026年9月25日 午前９時現在）')?.toISOString()).toBe(
      '2026-09-25T00:00:00.000Z',
    );
  });

  test('shifts 午後 by twelve hours', () => {
    expect(parseOkakawaDate('(2026年9月25日 午後３時現在)')?.toISOString()).toBe(
      '2026-09-25T06:00:00.000Z',
    );
  });

  test('returns null without a 現在 anchor', () => {
    expect(parseOkakawaDate('2026年9月25日 午前９時')).toBeNull();
  });
});

describe('parseOkakawaPdfText — the real 2026-09-25 PDF', () => {
  test('publishes all 13 dams and weirs of the three river systems, no 計 rows', () => {
    expect(parsed.published.sort()).toEqual(
      [
        '千屋ダム',
        '河本ダム',
        '高瀬川ダム',
        '三室川ダム',
        '小阪部川ダム',
        '新成羽川ダム',
        '湯原ダム',
        '旭川ダム',
        '苫田ダム',
        '津川ダム',
        '八塔寺川ダム',
        '新田原井堰',
        '坂根堰',
      ].sort(),
    );
    expect(parsed.rows).toHaveLength(13);
  });

  test('reads 小阪部川 volume in m³ and rate as a fraction at 09:00 JST', () => {
    // 利水容量 15,136 / 貯水量 3,809 千m³ / 25.2 %.
    const kosakabe = row('小阪部川ダム');
    expect(kosakabe?.observedAt.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(kosakabe?.storageVolumeM3).toBe(3_809_000);
    expect(kosakabe?.storageRate).toBeCloseTo(0.252, 6);
  });

  test('reads weirs as well as dams', () => {
    expect(row('坂根堰')?.storageVolumeM3).toBe(1_600_000);
    expect(row('坂根堰')?.storageRate).toBe(1);
    expect(row('新田原井堰')?.storageVolumeM3).toBe(2_000_000);
  });

  test('reads 湯原 although unpdf prints its rate before the name', () => {
    // 「51.5 -112湯 原 ダ ム 72,000 37,064」
    expect(row('湯原ダム')?.storageVolumeM3).toBe(37_064_000);
    expect(row('湯原ダム')?.storageRate).toBeCloseTo(0.515, 6);
  });

  test('does not take a side-note figure for the rate', () => {
    // 河本's line also carries 「６つのダムの貯水率は 25.0 ％です。」
    expect(row('河本ダム')?.storageVolumeM3).toBe(2_022_000);
    expect(row('河本ダム')?.storageRate).toBeCloseTo(0.385, 6);
  });
});

describe('parseOkakawaPdfText — row guards', () => {
  const header = '高梁川水系 主要ダム貯水量 (2026年9月25日 午前９時現在）\n';

  test('drops a row whose printed rate is not 貯水量 / 利水容量', () => {
    const r = parseOkakawaPdfText(`${header}千 屋 ダ ム 14,200 7,392 12.1 -102\n`);
    expect(r.published).toEqual(['千屋ダム']);
    expect(r.rows).toEqual([]);
  });

  test('drops rows that precede any dated header', () => {
    const r = parseOkakawaPdfText('千 屋 ダ ム 14,200 7,392 52.1 -102\n');
    expect(r.published).toEqual(['千屋ダム']);
    expect(r.rows).toEqual([]);
  });

  test('clamps a rate above 100 % of the 洪水期 pool to 1', () => {
    const r = parseOkakawaPdfText(`${header}千 屋 ダ ム 14,200 14,910 105.0 20\n`);
    expect(r.rows[0]?.storageVolumeM3).toBe(14_910_000);
    expect(r.rows[0]?.storageRate).toBe(1);
  });
});

describe('assertUsableRows', () => {
  test('fails a run where no dam name matched at all', () => {
    // A notice or re-typeset PDF: nothing matches NAME_RE, so 0 names and 0 rows.
    const notice = parseOkakawaPdfText('お知らせ\n本日の貯水状況の掲載は休止しています。\n');
    expect(() => assertUsableRows(notice)).toThrow('0 usable rows from 0 published names');
  });

  test('fails a run where names matched but no row passed the rate check', () => {
    const header = '高梁川水系 主要ダム貯水量 (2026年9月25日 午前９時現在）\n';
    const misread = parseOkakawaPdfText(`${header}千 屋 ダ ム 14,200 7,392 12.1 -102\n`);
    expect(() => assertUsableRows(misread)).toThrow('0 usable rows from 1 published names');
  });
});

describe('chooseMaster', () => {
  const m = (id: number, name: string, stamp: string | null = null) => ({
    id: BigInt(id),
    name,
    completedYear: null,
    stamp,
  });
  // Real pref-33 master rows (prod ids).
  const masters = [
    m(10749, '苫田'),
    m(10750, '苫田鞍部'),
    m(10751, '坂根堰'),
    m(10785, '湯原'),
    m(10811, '小阪部川'),
  ];

  test('binds dams by stem and weirs by their full name', () => {
    expect(chooseMaster('小阪部川ダム', masters)).toBe(10811n);
    expect(chooseMaster('坂根堰', masters)).toBe(10751n);
  });

  test('binds 苫田ダム to 苫田, not the 苫田鞍部 saddle dam', () => {
    expect(chooseMaster('苫田ダム', masters)).toBe(10749n);
  });

  test('leaves a weir with no master row unmatched', () => {
    expect(chooseMaster('新田原井堰', masters)).toBeNull();
  });

  test('keeps the row already stamped with the station', () => {
    expect(chooseMaster('湯原ダム', [...masters, m(99999, '湯原', '湯原ダム')])).toBe(99999n);
  });
});
