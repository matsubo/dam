// apps/worker/src/tasks/ingest_awaji_suido.test.ts
//
// Fixtures are verbatim UTF-8 captures of 淡路広域水道企業団「各水源地の貯水状況」
// (www.awaji-suido.jp/osirase-01.html):
// - osirase-01_2026-09-28.html: the 令和8年8月20日 table (Last-Modified 2026-08-25),
//   taken 2026-09-28.
// - osirase-01_2026-09-28b.html: the 令和8年9月23日 table (Last-Modified
//   2026-09-27 23:49 GMT), taken 2026-09-28, which prints 猪鼻第２ as
//   「479,2000」 at 100.0 %.
// - osirase-01_wayback_2023-03-30.html: the 令和5年3月19日 table as the Internet
//   Archive holds it (web.archive.org/web/20230330052415id_/…, raw bytes, fetched
//   2026-09-28), the one capture since 2013 with 天川第２ drawn down: 58,000 at 52.2 %.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type MasterCapacity,
  PINNED,
  parseAwajiChosui,
  type StoredVolume,
  storedVolume,
} from './ingest_awaji_suido.ts';

const fixture = (name: string) =>
  readFile(
    join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/awaji_suido', name),
    'utf8',
  );

const html = await fixture('osirase-01_2026-09-28.html');
const typo = await fixture('osirase-01_2026-09-28b.html');
const drawdown = await fixture('osirase-01_wayback_2023-03-30.html');

// Master 総 / 有効貯水容量 (prod dams.total_capacity_m3 / active_capacity_m3) of
// the written rows.
const MASTER: Record<string, { totalM3: number; activeM3: number }> = {
  猪鼻第1ダム: { totalM3: 306_000, activeM3: 304_000 },
  猪鼻第2ダム: { totalM3: 506_000, activeM3: 479_000 },
  竹原ダム: { totalM3: 804_000, activeM3: 618_000 },
  天川第2ダム: { totalM3: 112_000, activeM3: 53_000 },
  本庄川ダム: { totalM3: 1_720_000, activeM3: 1_610_000 },
};

describe('parseAwajiChosui', () => {
  test('dates the table from 令和N年M月D日現在, at 00:00 JST', () => {
    expect(parseAwajiChosui(html).observedAt).toEqual(new Date('2026-08-19T15:00:00.000Z'));
  });

  test('reads every row in page order with its own 貯水量 and 貯水率, never the 合計 cells', () => {
    // 猪鼻第１/第２ and 天川第１/第２ share rowspan=2 合計 cells (574,300 / 72.7 %
    // and 167,800 / 68.2 %) that sit after the first row's own 貯水率.
    expect(parseAwajiChosui(html).rows.map((r) => [r.name, r.storageVolumeM3, r.ratePct])).toEqual([
      ['猪鼻第1ダム', 181_300, 58.2],
      ['猪鼻第2ダム', 393_000, 82],
      ['竹原ダム', 271_500, 51.7],
      ['天川第1ダム', 86_700, 64.3],
      ['天川第2ダム', 81_100, 72.9],
      ['成相・北富士ダム', 1_890_150, 61],
      ['牛内ダム', 529_321, 48.1],
      ['本庄川ダム', 540_465, 76.1],
    ]);
  });

  test("recovers a volume whose thousands grouping is broken from its pair's 合計", () => {
    // 猪鼻第１ and 第２ share one rowspan=2 合計 of 783,200: 783,200 − 304,000 =
    // 479,200, which the printed 100.0 % of the 479.3 千m³ basis corroborates.
    const inohana2 = parseAwajiChosui(typo).rows.find((r) => r.name === '猪鼻第2ダム');
    expect(inohana2).toEqual({
      name: '猪鼻第2ダム',
      volumeText: '479,2000',
      storageVolumeM3: 479_200,
      volumeFromTotal: true,
      ratePct: 100,
    });
  });

  test('leaves a broken volume null when the pair cannot give it back', () => {
    // The partner's own volume is the one the 合計 is reduced by; without it
    // (or without a readable 合計) there is nothing to subtract.
    const partnerDash = typo.replace('>304,000<', '>－<');
    const totalBroken = typo.replace('>783,200<', '>783,2000<');
    for (const page of [partnerDash, totalBroken]) {
      const inohana2 = parseAwajiChosui(page).rows.find((r) => r.name === '猪鼻第2ダム');
      expect(inohana2?.storageVolumeM3).toBeNull();
      expect(inohana2?.volumeFromTotal).toBe(false);
    }
  });

  test('never reads a well-formed volume from the 合計', () => {
    const rows = parseAwajiChosui(typo).rows.filter((r) => r.name !== '猪鼻第2ダム');
    expect(rows.every((r) => !r.volumeFromTotal)).toBe(true);
  });

  test('keeps a row whose 貯水量 is a dash, with a null volume', () => {
    const dashed = html.replace(
      /(竹原ダム[\s\S]*?<font face="ＭＳ ゴシック" size="2">)271,500(<\/font>)/,
      '$1－$2',
    );
    const takehara = parseAwajiChosui(dashed).rows.find((r) => r.name === '竹原ダム');
    expect(takehara?.storageVolumeM3).toBeNull();
    expect(takehara?.ratePct).toBe(51.7);
  });

  test('refuses a table whose columns moved', () => {
    const swapped = html.replace('貯水量（ｍ3）</font></td>', '貯水率（％）</font></td>');
    expect(() => parseAwajiChosui(swapped)).toThrow(/layout/);
  });

  test('refuses a page without its 現在 date', () => {
    expect(() => parseAwajiChosui(html.replace('令和8年8月20日現在', '現在'))).toThrow(/date/);
  });
});

describe('storedVolume', () => {
  const store = (
    page: string,
    name: string,
    patch: object = {},
    master: MasterCapacity | undefined = MASTER[name],
  ) => {
    const row = parseAwajiChosui(page).rows.find((r) => r.name === name);
    const pin = PINNED[name];
    if (!row || !pin || !master) throw new Error(`no ${name}`);
    return storedVolume({ ...row, ...patch }, pin, master);
  };
  const problem = (s: StoredVolume) => ('problem' in s ? s.problem : null);

  test('stores the printed volume of every 有効-basis row on the captured pages', () => {
    for (const page of [html, typo]) {
      for (const name of ['猪鼻第1ダム', '猪鼻第2ダム', '竹原ダム', '本庄川ダム']) {
        const row = parseAwajiChosui(page).rows.find((r) => r.name === name);
        if (row?.storageVolumeM3 == null) continue;
        expect(store(page, name)).toEqual({ volumeM3: row.storageVolumeM3 });
      }
    }
  });

  test('stores 天川第２ as water above 最低水位: 貯水量 less the master 総 − 有効', () => {
    // 111,000 at 99.8 % is on the ~111 千m³ 総 basis; 112,000 − 53,000 = 59,000
    // lies below the intake, so 52,000 of the 53,000 有効 is left.
    expect(store(typo, '天川第2ダム')).toEqual({ volumeM3: 52_000 });
    // 81,100 at 72.9 %: 22,100 m³, 42 % of 有効 — not the page's 72.9 %.
    expect(store(html, '天川第2ダム')).toEqual({ volumeM3: 22_100 });
  });

  test('stores a 天川第２ drawn down to its dead pool as empty, never negative', () => {
    // 2023-03-19: 58,000 at 52.2 %, 1,000 m³ under the 59,000 below 最低水位.
    expect(store(drawdown, '天川第2ダム')).toEqual({ volumeM3: 0 });
  });

  test('stores no 天川第２ once the master 総貯水容量 stops matching the page basis', () => {
    // e.g. 兵庫県's 126 千m³ (ダム年鑑 2011) replacing ダム便覧's 112 would move
    // the dead pool by 14,000 m³ — a quarter of 有効.
    const moved = store(typo, '天川第2ダム', {}, { totalM3: 126_000, activeM3: 53_000 });
    expect(problem(moved)).toMatch(/総貯水容量/);
  });

  test('stores no 天川第２ without both master capacities', () => {
    for (const master of [
      { totalM3: null, activeM3: 53_000 },
      { totalM3: 112_000, activeM3: null },
    ]) {
      expect(problem(store(typo, '天川第2ダム', {}, master))).toMatch(/master/);
    }
  });

  test('rejects a volume whose implied capacity strays from the pinned basis', () => {
    // 「479,200」 misread by a factor of 10 would imply 4,792 千m³ at 100 %.
    expect(problem(store(typo, '猪鼻第2ダム', { storageVolumeM3: 4_792_000 }))).toMatch(/implies/);
    // A volume typed under the wrong dam: 393,000 at 竹原's 51.7 % implies 760 千m³.
    expect(problem(store(html, '竹原ダム', { storageVolumeM3: 393_000 }))).toMatch(/implies/);
  });

  test('rejects a volume well above the master 有効貯水容量, whatever the rate says', () => {
    // 猪鼻第１ on the utility's 311 千m³ basis, but 1.3× the master's 304.
    const over = store(html, '猪鼻第1ダム', { storageVolumeM3: 395_000, ratePct: 127 });
    expect(problem(over)).toMatch(/master/);
    // 天川第２ at 118.8 % (2025-09-21, 132,100): 73,100 above 最低水位 is 1.38× 有効.
    const spill = store(typo, '天川第2ダム', { storageVolumeM3: 132_100, ratePct: 118.8 });
    expect(problem(spill)).toMatch(/master/);
  });

  test('rejects a volume it cannot check because the 貯水率 is missing', () => {
    expect(problem(store(html, '竹原ダム', { ratePct: null }))).toMatch(/貯水率/);
  });
});
