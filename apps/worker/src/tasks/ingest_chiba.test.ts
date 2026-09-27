// apps/worker/src/tasks/ingest_chiba.test.ts
//
// Fixture is a verbatim capture (2026-09-27) of 千葉県 県内ダムの貯水状況
// (pref.chiba.lg.jp/suisei/chosui/chosuijoukyou.html), 更新日 2026-09-15.
// Its heading reads 「県内ダム貯水状況（令和8年9月14日現在）」 while the chart
// image under it still carries last week's alt text 「令和8年9月7日9時現在…」
// (the image file itself is r080914.jpg).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseChibaPage, parseChibaTimestamp } from './ingest_chiba.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/chiba_suisei/chosuijoukyou_2026-09-27.html',
);

const html = (): Promise<string> => readFile(FIXTURE, 'utf8');

describe('parseChibaTimestamp', () => {
  test('dates the table by its heading, not the stale chart alt text', async () => {
    // 2026-09-14 09:00 JST, the survey hour every earlier snapshot carried.
    expect(parseChibaTimestamp(await html())?.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  test('returns null when the table heading is missing', async () => {
    const withoutHeading = (await html()).replace('県内ダム貯水状況（令和8年9月14日現在）', '');
    expect(parseChibaTimestamp(withoutHeading)).toBeNull();
  });
});

describe('parseChibaPage', () => {
  test('lists the 20 水道用 and 3 工業用水 dams, skipping subtotal rows', async () => {
    const rows = parseChibaPage(await html());
    expect(rows).toHaveLength(23);
    expect(rows.some((r) => /小計|合計/.test(r.pageName))).toBe(false);
  });

  test('reads m³ volumes and % rates as published', async () => {
    const rows = parseChibaPage(await html());
    const higashi2 = rows.find((r) => r.pageName === '東第二');
    expect(higashi2?.storageVolumeM3).toBe(181_447);
    expect(higashi2?.storageRate).toBeCloseTo(0.98, 6);
    const yamakura = rows.find((r) => r.pageName === '山倉');
    expect(yamakura?.storageVolumeM3).toBe(4_118_700);
    expect(yamakura?.storageRate).toBeCloseTo(0.92, 6);
  });
});
