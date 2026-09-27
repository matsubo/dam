// apps/worker/src/tasks/ingest_mc_tottori_hydro.test.ts
//
// Fixture is a verbatim UTF-8 capture of M&C鳥取水力発電 発電所・ダム運転情報
// (mchp-k.co.jp/business/list.php) taken 2026-09-27 21:42 JST; the page's own
// 時刻 reads 21:42 (it advances every minute). Eight modal blocks: four 発電所
// (出力 / 使用水量) and four dams (茗荷谷ダム / 三朝調整池 / 中津ダム / 菅沢ダム),
// each a two-column 年月日 / 時刻 / value table.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, parseMcTottoriHydro } from './ingest_mc_tottori_hydro.ts';

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

describe('chooseMaster', () => {
  const m = (id: number, name: string, stamp: string | null = null) => ({
    id: BigInt(id),
    name,
    completedYear: null,
    stamp,
  });
  // Real pref-31 ids from the master.
  const masters = [m(10963, '茗荷谷'), m(10967, '三朝'), m(10968, '中津'), m(10979, '菅沢')];

  test('binds 調整池 and ダム names to their master stems', () => {
    expect(chooseMaster('三朝調整池', masters)).toBe(10967n);
    expect(chooseMaster('茗荷谷ダム', masters)).toBe(10963n);
    expect(chooseMaster('中津ダム', masters)).toBe(10968n);
  });

  test('keeps the row already stamped with the station', () => {
    expect(chooseMaster('中津ダム', [m(1, '中津'), m(2, '中津', '中津ダム')])).toBe(2n);
  });

  test('does not bind to a master that merely contains the stem', () => {
    expect(chooseMaster('中津ダム', [m(1, '中津川')])).toBeNull();
  });
});
