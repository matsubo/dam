// apps/worker/src/tasks/ingest_jwa_yoshino.test.ts
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 吉野川上流総合管理所
// ダム情報掲示板 流域概況図 (water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/
// p000101.html) taken 2026-09-28 12:04 JST, 観測日時 2026年09月28日 12時00分:
//   池田   88.59 EL.m  流入量 71.55  全放流量 75.14 m³/s
//   早明浦 293.00 EL.m 流入量 20.45  全放流量  0.00 m³/s  利水貯水率[速報値] 15.0 %
//   新宮   220.77 EL.m 流入量  4.84  全放流量  1.57 m³/s
//   富郷   442.41 EL.m 流入量  4.96  全放流量  4.00 m³/s
//   柳瀬   279.18 EL.m 流入量  6.94  全放流量  6.43 m³/s
// Each value sits in the <td> after a <th> whose unit is markup
// (`流入量(<span class='unit'>m<sup>3</sup>/s</span>)`), followed by a trend
// arrow span.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseYoshinoHtml, parseYoshinoTimestamp } from './ingest_jwa_yoshino.ts';

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
  test('reads each value from its <td>, not the 3 of the m<sup>3</sup>/s unit', () => {
    const { observedAt, rows } = parseYoshinoHtml(HTML);
    expect(observedAt?.toISOString()).toBe('2026-09-28T03:00:00.000Z');
    expect(rows).toEqual([
      {
        yoshinoName: '池田ダム',
        waterLevelM: 88.59,
        storageRatePct: null,
        inflowM3s: 71.55,
        outflowM3s: 75.14,
      },
      {
        yoshinoName: '早明浦ダム',
        waterLevelM: 293,
        storageRatePct: 15,
        inflowM3s: 20.45,
        outflowM3s: 0,
      },
      {
        yoshinoName: '新宮ダム',
        waterLevelM: 220.77,
        storageRatePct: null,
        inflowM3s: 4.84,
        outflowM3s: 1.57,
      },
      {
        yoshinoName: '富郷ダム',
        waterLevelM: 442.41,
        storageRatePct: null,
        inflowM3s: 4.96,
        outflowM3s: 4,
      },
      {
        yoshinoName: '柳瀬ダム',
        waterLevelM: 279.18,
        storageRatePct: null,
        inflowM3s: 6.94,
        outflowM3s: 6.43,
      },
    ]);
  });

  test('a "CC" (閉局) cell is null, not a digit from the next row', () => {
    const html = HTML.replace('<td class="">15.0</td>', '<td class="">CC</td>')
      .replace('<td class="">4.96<span', '<td class="">CC<span')
      .replace('<td class="">4.00<span', '<td class="">CC<span');
    const { rows } = parseYoshinoHtml(html);
    expect(rows.find((r) => r.yoshinoName === '早明浦ダム')?.storageRatePct).toBeNull();
    const tomisato = rows.find((r) => r.yoshinoName === '富郷ダム');
    expect(tomisato?.inflowM3s).toBeNull();
    expect(tomisato?.outflowM3s).toBeNull();
    expect(tomisato?.waterLevelM).toBe(442.41);
  });

  test('skips a dam whose 貯水位 is "CC"', () => {
    const html = HTML.replace('<td class="">293.00<span', '<td class="">CC<span');
    const { rows } = parseYoshinoHtml(html);
    expect(rows.map((r) => r.yoshinoName)).toEqual([
      '池田ダム',
      '新宮ダム',
      '富郷ダム',
      '柳瀬ダム',
    ]);
  });
});
