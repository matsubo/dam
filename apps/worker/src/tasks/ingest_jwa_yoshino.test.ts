// apps/worker/src/tasks/ingest_jwa_yoshino.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 吉野川上流総合管理所
// ダム情報掲示板 流域概況図 (water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/
// p000101.html) taken 2026-09-28 12:04 JST, 観測日時 2026年09月28日 12時00分:
//   池田   88.59 EL.m  流入量 71.55  全放流量 75.14 m³/s
//   早明浦 293.00 EL.m 流入量 20.45  全放流量  0.00 m³/s  利水貯水率[速報値] 15.0 %
//   新宮   220.77 EL.m 流入量  4.84  全放流量  1.57 m³/s
//   富郷   442.41 EL.m 流入量  4.96  全放流量  4.00 m³/s
//   柳瀬   279.18 EL.m 流入量  6.94  全放流量  6.43 m³/s
// plus four weirs and a 鏡ダム 自流量 point, which print no 貯水位.
// Each value sits in the <td> after a <th> whose unit is markup
// (`流入量(<span class='unit'>m<sup>3</sup>/s</span>)`), followed by a trend
// arrow span.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import { parseYoshinoHtml, parseYoshinoTimestamp, yoshinoEntries } from './ingest_jwa_yoshino.ts';

const HTML = await readFile(
  join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'tests/fixtures/jwa_yoshino/p000101_2026-09-28.html',
  ),
  'utf8',
);

/** The single observation of an entry in state `values`, else null. */
function observed(e: Entry | undefined): Observed | null {
  const r = e?.reading;
  return r && typeof r !== 'function' && r.state === 'values' ? (r.observations[0] ?? null) : null;
}
const stateOf = (e: Entry | undefined) =>
  e && typeof e.reading !== 'function' ? e.reading.state : undefined;

describe('parseYoshinoTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseYoshinoTimestamp('観測日時：2026年06月05日 10時00分');
    expect(d).not.toBeNull();
    // 10:00 JST = 01:00 UTC same day
    expect(d?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 wraps to previous UTC day)', () => {
    const d = parseYoshinoTimestamp('観測日時：2026年06月05日 08時00分');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → 23:00 UTC previous day
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null when no timestamp present', () => {
    expect(parseYoshinoTimestamp('no timestamp here')).toBeNull();
  });
});

describe('parseYoshinoHtml', () => {
  test('lists every facility block in page order: five reservoirs, then weirs and 鏡ダム', () => {
    expect(parseYoshinoHtml(HTML).rows.map((r) => [r.yoshinoName, r.reservoir])).toEqual([
      ['池田ダム', true],
      ['早明浦ダム', true],
      ['新宮ダム', true],
      ['富郷ダム', true],
      ['柳瀬ダム', true],
      ['新井堰(床鍋)', false],
      ['影井堰', false],
      ['瀬戸川取水堰', false],
      ['地蔵寺川取水堰', false],
      ['鏡ダム', false],
    ]);
  });
});

describe('yoshinoEntries', () => {
  test('reads each value from its <td>, not the 3 of the m<sup>3</sup>/s unit', () => {
    const entries = yoshinoEntries(HTML);
    const at = new Date('2026-09-28T03:00:00.000Z');
    expect(entries.slice(0, 5).map((e) => [e.key, observed(e)])).toEqual([
      [
        '池田ダム',
        {
          observedAt: at,
          waterLevelM: 88.59,
          inflowM3s: 71.55,
          outflowM3s: 75.14,
          storageRate: null,
        },
      ],
      [
        '早明浦ダム',
        { observedAt: at, waterLevelM: 293, inflowM3s: 20.45, outflowM3s: 0, storageRate: 0.15 },
      ],
      [
        '新宮ダム',
        {
          observedAt: at,
          waterLevelM: 220.77,
          inflowM3s: 4.84,
          outflowM3s: 1.57,
          storageRate: null,
        },
      ],
      [
        '富郷ダム',
        { observedAt: at, waterLevelM: 442.41, inflowM3s: 4.96, outflowM3s: 4, storageRate: null },
      ],
      [
        '柳瀬ダム',
        {
          observedAt: at,
          waterLevelM: 279.18,
          inflowM3s: 6.94,
          outflowM3s: 6.43,
          storageRate: null,
        },
      ],
    ]);
  });

  test('keys each dam by its printed name, scoped to its prefectures', () => {
    const entries = yoshinoEntries(HTML);
    expect(entries.every((e) => e.key === e.name)).toBe(true);
    expect(entries.find((e) => e.key === '池田ダム')?.pref).toBe('36');
    expect(entries.find((e) => e.key === '新宮ダム')?.pref).toEqual(['36', '38']);
  });

  test('the weirs and the 鏡ダム 自流量 point are never bound, read as they print', () => {
    const entries = yoshinoEntries(HTML).filter((e) => e.bind === 'never');
    const at = new Date('2026-09-28T03:00:00.000Z');
    expect(entries.map((e) => [e.key, e.pref, observed(e)])).toEqual([
      [
        '新井堰(床鍋)',
        ['36', '38', '39'],
        { observedAt: at, waterLevelM: 0.3, inflowM3s: 2.223, outflowM3s: null, storageRate: null },
      ],
      [
        '影井堰',
        ['36', '38', '39'],
        {
          observedAt: at,
          waterLevelM: 191.13,
          inflowM3s: 2.14,
          outflowM3s: 0.17,
          storageRate: null,
        },
      ],
      [
        '瀬戸川取水堰',
        ['36', '38', '39'],
        { observedAt: at, waterLevelM: null, inflowM3s: 2.96, outflowM3s: null, storageRate: null },
      ],
      [
        '地蔵寺川取水堰',
        ['36', '38', '39'],
        {
          observedAt: at,
          waterLevelM: null,
          inflowM3s: null,
          outflowM3s: 0.302,
          storageRate: null,
        },
      ],
      [
        '鏡ダム',
        ['36', '38', '39'],
        {
          observedAt: at,
          waterLevelM: null,
          inflowM3s: 1.542,
          outflowM3s: null,
          storageRate: null,
        },
      ],
    ]);
    expect(yoshinoEntries(HTML).filter((e) => e.bind !== undefined)).toHaveLength(5);
  });

  test('a "CC" (閉局) cell is null, not a digit from the next row', () => {
    const html = HTML.replace('<td class="">15.0</td>', '<td class="">CC</td>')
      .replace('<td class="">4.96<span', '<td class="">CC<span')
      .replace('<td class="">4.00<span', '<td class="">CC<span');
    const entries = yoshinoEntries(html);
    expect(observed(entries.find((e) => e.key === '早明浦ダム'))?.storageRate).toBeNull();
    const tomisato = observed(entries.find((e) => e.key === '富郷ダム'));
    expect(tomisato?.inflowM3s).toBeNull();
    expect(tomisato?.outflowM3s).toBeNull();
    expect(tomisato?.waterLevelM).toBe(442.41);
  });

  test('a dam whose 貯水位 is "CC" keeps its flows', () => {
    const html = HTML.replace('<td class="">293.00<span', '<td class="">CC<span');
    const sameura = observed(yoshinoEntries(html).find((e) => e.key === '早明浦ダム'));
    expect(sameura?.waterLevelM).toBeNull();
    expect(sameura?.inflowM3s).toBe(20.45);
  });

  test('a dam marked CC on every field is provider-marked empty', () => {
    const html = HTML.replace('<td class="">293.00<span', '<td class="">CC<span')
      .replace('<td class="">20.45<span', '<td class="">CC<span')
      .replace('<td class="">0.00<span', '<td class="">CC<span')
      .replace('<td class="">15.0</td>', '<td class="">CC</td>');
    expect(stateOf(yoshinoEntries(html).find((e) => e.key === '早明浦ダム'))).toBe('empty');
  });

  test('a page without its 観測日時 is unreadable, every facility still listed', () => {
    const entries = yoshinoEntries(HTML.replace(/\d{4}年\d{2}月\d{2}日\s+\d{1,2}時\d{2}分/g, ''));
    expect(entries).toHaveLength(10);
    expect(entries.every((e) => stateOf(e) === 'unreadable')).toBe(true);
  });
});
