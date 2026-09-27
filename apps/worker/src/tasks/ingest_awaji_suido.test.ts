// apps/worker/src/tasks/ingest_awaji_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 淡路広域水道企業団「各水源地の貯水状況」
// (www.awaji-suido.jp/osirase-01.html) taken 2026-09-28, still showing the
// 令和8年8月20日 table (Last-Modified 2026-08-25).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAwajiChosui } from './ingest_awaji_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/awaji_suido/osirase-01_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

describe('parseAwajiChosui', () => {
  test('dates the table from 令和N年M月D日現在, at 00:00 JST', () => {
    expect(parseAwajiChosui(html).observedAt).toEqual(new Date('2026-08-19T15:00:00.000Z'));
  });

  test('reads every row in page order with its own 貯水量, never the 合計 cells', () => {
    // 猪鼻第１/第２ and 天川第１/第２ share rowspan=2 合計 cells (574,300 and
    // 167,800) that sit after the first row's own 貯水率.
    expect(parseAwajiChosui(html).rows).toEqual([
      { name: '猪鼻第1ダム', storageVolumeM3: 181_300 },
      { name: '猪鼻第2ダム', storageVolumeM3: 393_000 },
      { name: '竹原ダム', storageVolumeM3: 271_500 },
      { name: '天川第1ダム', storageVolumeM3: 86_700 },
      { name: '天川第2ダム', storageVolumeM3: 81_100 },
      { name: '成相・北富士ダム', storageVolumeM3: 1_890_150 },
      { name: '牛内ダム', storageVolumeM3: 529_321 },
      { name: '本庄川ダム', storageVolumeM3: 540_465 },
    ]);
  });

  test('keeps a row whose 貯水量 is a dash, with a null volume', () => {
    const dashed = html.replace(
      /(竹原ダム[\s\S]*?<font face="ＭＳ ゴシック" size="2">)271,500(<\/font>)/,
      '$1－$2',
    );
    const takehara = parseAwajiChosui(dashed).rows.find((r) => r.name === '竹原ダム');
    expect(takehara).toEqual({ name: '竹原ダム', storageVolumeM3: null });
  });

  test('refuses a table whose columns moved', () => {
    const swapped = html.replace('貯水量（ｍ3）</font></td>', '貯水率（％）</font></td>');
    expect(() => parseAwajiChosui(swapped)).toThrow(/layout/);
  });

  test('refuses a page without its 現在 date', () => {
    expect(() => parseAwajiChosui(html.replace('令和8年8月20日現在', '現在'))).toThrow(/date/);
  });
});
