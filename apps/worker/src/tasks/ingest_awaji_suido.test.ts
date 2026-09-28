// apps/worker/src/tasks/ingest_awaji_suido.test.ts
//
// Fixtures are verbatim UTF-8 captures of 淡路広域水道企業団「各水源地の貯水状況」
// (www.awaji-suido.jp/osirase-01.html), both taken 2026-09-28:
// - osirase-01_2026-09-28.html: the 令和8年8月20日 table (Last-Modified 2026-08-25).
// - osirase-01_2026-09-28b.html: the 令和8年9月23日 table (Last-Modified
//   2026-09-27 23:49 GMT), which prints 猪鼻第２ as 「479,2000」 at 100.0 %.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { implausibleVolume, PINNED, parseAwajiChosui } from './ingest_awaji_suido.ts';

const fixture = (name: string) =>
  readFile(
    join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/awaji_suido', name),
    'utf8',
  );

const html = await fixture('osirase-01_2026-09-28.html');
const typo = await fixture('osirase-01_2026-09-28b.html');

// Master 有効貯水容量 (prod dams.active_capacity_m3) of the written rows.
const ACTIVE: Record<string, number> = {
  猪鼻第1ダム: 304_000,
  猪鼻第2ダム: 479_000,
  竹原ダム: 618_000,
  本庄川ダム: 1_610_000,
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

describe('implausibleVolume', () => {
  const check = (page: string, name: string, patch: object = {}) => {
    const row = parseAwajiChosui(page).rows.find((r) => r.name === name);
    const pin = PINNED[name];
    if (!row || !pin) throw new Error(`no ${name}`);
    return implausibleVolume({ ...row, ...patch }, pin.basisM3, ACTIVE[name] ?? null);
  };

  test('passes every written row on both captured pages', () => {
    for (const page of [html, typo]) {
      for (const name of Object.keys(ACTIVE)) {
        const row = parseAwajiChosui(page).rows.find((r) => r.name === name);
        if (row?.storageVolumeM3 == null) continue;
        expect(check(page, name)).toBeNull();
      }
    }
  });

  test('rejects a volume whose implied capacity strays from the pinned basis', () => {
    // 「479,200」 misread by a factor of 10 would imply 4,792 千m³ at 100 %.
    expect(check(typo, '猪鼻第2ダム', { storageVolumeM3: 4_792_000 })).toMatch(/implies/);
    // A volume typed under the wrong dam: 393,000 at 竹原's 51.7 % implies 760 千m³.
    expect(check(html, '竹原ダム', { storageVolumeM3: 393_000 })).toMatch(/implies/);
  });

  test('rejects a volume well above the master 有効貯水容量, whatever the rate says', () => {
    // 猪鼻第１ on the utility's 311 千m³ basis, but 1.3× the master's 304.
    expect(check(html, '猪鼻第1ダム', { storageVolumeM3: 395_000, ratePct: 127 })).toMatch(
      /master/,
    );
  });

  test('rejects a volume it cannot check because the 貯水率 is missing', () => {
    expect(check(html, '竹原ダム', { ratePct: null })).toMatch(/貯水率/);
  });
});
