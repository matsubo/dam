// apps/worker/src/tasks/ingest_mc_tottori_hydro.test.ts
//
// Fixture is a verbatim UTF-8 capture of M&C鳥取水力発電 発電所・ダム運転情報
// (mchp-k.co.jp/business/list.php) taken 2026-09-27 21:42 JST; the page's own
// 時刻 reads 21:42 (it advances every minute). Eight modal blocks: four 発電所
// (出力 / 使用水量) and four dams (茗荷谷ダム / 三朝調整池 / 中津ダム / 菅沢ダム),
// each a two-column 年月日 / 時刻 / value table.
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mcTottoriEntries, parseMcTottoriHydro } from './ingest_mc_tottori_hydro.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/mc_tottori_hydro/list_2026-09-27.html',
);

async function fixtureHtml(): Promise<string> {
  return readFile(FIXTURE, 'utf8');
}

describe('parseMcTottoriHydro', () => {
  test('lists the four dams and none of the power stations', async () => {
    const rows = parseMcTottoriHydro(await fixtureHtml());
    expect(rows.map((r) => r.name)).toEqual(['茗荷谷ダム', '三朝調整池', '中津ダム', '菅沢ダム']);
  });

  test('reads 中津 inflow, gate release and the JST observation time', async () => {
    const nakatsu = parseMcTottoriHydro(await fixtureHtml()).find((r) => r.name === '中津ダム');
    expect(nakatsu?.observedAt?.toISOString()).toBe('2026-09-27T12:42:00.000Z');
    expect(nakatsu?.inflowM3s).toBe(0.87);
    expect(nakatsu?.outflowM3s).toBe(0);
  });

  test('takes 三朝調整池 10分間流入量, not the 制水門 intake, and has no release', async () => {
    const misasa = parseMcTottoriHydro(await fixtureHtml()).find((r) => r.name === '三朝調整池');
    expect(misasa?.inflowM3s).toBe(0.35);
    expect(misasa?.outflowM3s).toBeNull();
  });

  test('blank or non-numeric cells read as null', async () => {
    // 茗荷谷 is the first block carrying 10分間流入量.
    const html = (await fixtureHtml()).replace(
      /(10分間流入量\(m<sup>3<\/sup>\/s\)<\/td>\s*<td>)1\.72</,
      '$1欠測<',
    );
    const myogadani = parseMcTottoriHydro(html).find((r) => r.name === '茗荷谷ダム');
    expect(myogadani?.inflowM3s).toBeNull();
    expect(myogadani?.outflowM3s).toBe(0);
  });
});

describe('mcTottoriEntries', () => {
  test('binds 調整池 and ダム names by their exact stems, never a 中津川', async () => {
    const entries = mcTottoriEntries(await fixtureHtml());
    expect(entries.map((e) => [e.key, e.pref, e.bind])).toEqual([
      ['茗荷谷ダム', '31', { name: '茗荷谷ダム', exact: true }],
      ['三朝調整池', '31', { name: '三朝', exact: true }],
      ['中津ダム', '31', { name: '中津ダム', exact: true }],
      ['菅沢ダム', '31', { name: '菅沢ダム', exact: true }],
    ]);
  });

  test('reads 中津 as values at the JST observation time', async () => {
    const nakatsu = mcTottoriEntries(await fixtureHtml()).find((e) => e.key === '中津ダム');
    expect(nakatsu?.reading).toEqual({
      state: 'values',
      observations: [
        { observedAt: new Date('2026-09-27T12:42:00.000Z'), inflowM3s: 0.87, outflowM3s: 0 },
      ],
    });
  });

  test('a dam without its 時刻 is unreadable, still listed', async () => {
    const html = (await fixtureHtml()).replace(
      /(<td class="th">時刻<\/td>\s*<td[^>]*>)[^<]*/g,
      '$1',
    );
    for (const e of mcTottoriEntries(html)) {
      expect(e.reading).toEqual({ state: 'unreadable', why: 'no 年月日 / 時刻' });
    }
  });
});
