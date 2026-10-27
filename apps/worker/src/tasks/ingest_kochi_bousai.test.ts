// apps/worker/src/tasks/ingest_kochi_bousai.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// tests/fixtures/kochi_bousai holds a verbatim Shift_JIS capture of
// tableStatusDam_0_1_0_now.html at the 2026-10-27 00:40 JST update: all 11
// dams, 早明浦's 利水 rate blank.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import { kochiEntries, parseKochiTable, parseKochiTimestamp } from './ingest_kochi_bousai.ts';

const FIXTURE = join(
  import.meta.dir,
  '../../../../tests/fixtures/kochi_bousai/tableStatusDam_2026-10-27T0040.shiftjis.html',
);

function observation(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}

const entries = (html: string) => kochiEntries(parseKochiTable(html));

describe('parseKochiTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM" (JST) → UTC', () => {
    const d = parseKochiTimestamp('2026/06/05 20:40');
    expect(d?.toISOString()).toBe('2026-06-05T11:40:00.000Z');
  });

  test('handles midnight crossover (JST 00:00 → previous UTC day)', () => {
    const d = parseKochiTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseKochiTimestamp('')).toBeNull();
    expect(parseKochiTimestamp('bad')).toBeNull();
    expect(parseKochiTimestamp('2026/06/05')).toBeNull();
  });
});

// Minimal HTML matching the tableStatusDam format (two rows: pref-managed + MLIT)
const SAMPLE_HTML = `
<!DOCTYPE html>
<html><body>
<table>
<thead>
<tr>
<th rowspan="2">管理者名</th><th rowspan="2">河川名</th><th rowspan="2">観測所名</th>
<th rowspan="2">フリガナ</th><th rowspan="2">所在地</th><th rowspan="2">最新観測時刻</th>
<th>貯水率(有効)</th><th>貯水率(利水)</th><th>貯水位</th><th>貯水量</th>
<th>流入量</th><th>全放流量</th><th>洪水量</th><th>計画高水流量</th>
</tr>
<tr><th>[%]</th><th>[%]</th><th>[m]</th><th>[10³m³]</th>
<th>[m³/s]</th><th>[m³/s]</th><th>[m³/s]</th><th>[m³/s]</th></tr>
</thead>
<tbody>
<tr>
<td>高知（河）</td><td>和食川</td>
<td><a href="javascript:void(0)" onclick="myIn('10','202606052040','1')">和食ダム</a></td>
<td>ワジキダム</td><td>芸西村</td><td>2026/06/05 20:40</td>
<td>&nbsp;46.30</td><td>&nbsp;97.30</td><td>&nbsp;&nbsp;&nbsp;87.72</td>
<td>&nbsp;374.000</td><td>&nbsp;&nbsp;&nbsp;0.1630</td><td>&nbsp;&nbsp;&nbsp;0.0640</td>
<td>&nbsp;&nbsp;&nbsp;&nbsp;9.000</td><td>&nbsp;&nbsp;&nbsp;56.000</td>
</tr>
<tr>
<td>国交省</td><td>吉野川</td>
<td><a href="javascript:void(0)" onclick="myIn('8','202606052040','1')">早明浦ダム</a></td>
<td>サメウラダム</td><td>土佐町</td><td>2026/06/05 20:40</td>
<td>&nbsp;67.20</td><td>&nbsp;100.00</td><td>&nbsp;&nbsp;&nbsp;328.87</td>
<td>&nbsp;194160.000</td><td>&nbsp;&nbsp;&nbsp;78.9400</td><td>&nbsp;&nbsp;&nbsp;58.5000</td>
<td>&nbsp;&nbsp;&nbsp;800.000</td><td>&nbsp;&nbsp;&nbsp;4700.000</td>
</tr>
</tbody>
</table>
</body></html>
`;

describe('kochiEntries', () => {
  test('one entry per dam row, keyed by the printed name', () => {
    const list = entries(SAMPLE_HTML);
    expect(list.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['和食ダム', '和食ダム', '39'],
      ['早明浦ダム', '早明浦ダム', '39'],
    ]);
  });

  test('observedAt converted from JST to UTC', () => {
    for (const e of entries(SAMPLE_HTML)) {
      expect(observation(e)?.observedAt.toISOString()).toBe('2026-06-05T11:40:00.000Z');
    }
  });

  test('和食ダム: all fields parsed correctly', () => {
    const o = observation(entries(SAMPLE_HTML).find((x) => x.key === '和食ダム'));
    // 利水容量ベース column [7] = 97.30, not 有効容量ベース column [6] = 46.30.
    expect(o?.storageRate).toBeCloseTo(0.973);
    expect(o?.storageVolumeM3).toBeCloseTo(374_000);
    expect(o?.waterLevelM).toBeCloseTo(87.72);
    expect(o?.inflowM3s).toBeCloseTo(0.163);
    expect(o?.outflowM3s).toBeCloseTo(0.064);
  });

  test('早明浦ダム: large storage volume parsed correctly', () => {
    const o = observation(entries(SAMPLE_HTML).find((x) => x.key === '早明浦ダム'));
    // 利水容量ベース column [7] = 100.00, not 有効容量ベース column [6] = 67.20.
    expect(o?.storageRate).toBeCloseTo(1.0);
    expect(o?.storageVolumeM3).toBeCloseTo(194_160_000);
    expect(o?.waterLevelM).toBeCloseTo(328.87);
    expect(o?.inflowM3s).toBeCloseTo(78.94);
    expect(o?.outflowM3s).toBeCloseTo(58.5);
  });

  test('storageRate clamped to [0, 1]', () => {
    // 97.30 is 和食ダム's 利水容量ベース column [7] — the one actually used.
    const o = observation(entries(SAMPLE_HTML.replace('97.30', '105.00'))[0]);
    expect(o?.storageRate).toBe(1);
  });

  test('a row without a time, or without 貯水位 and 貯水量, is unreadable but listed', () => {
    const html = SAMPLE_HTML.replace('<td>2026/06/05 20:40</td>', '<td>&nbsp;</td>')
      .replace('&nbsp;&nbsp;&nbsp;328.87', '&nbsp;')
      .replace('&nbsp;194160.000', '&nbsp;');
    expect(entries(html).map((e) => e.reading)).toEqual([
      { state: 'unreadable', why: 'no 最新観測時刻' },
      { state: 'unreadable', why: 'no 貯水位 or 貯水量' },
    ]);
  });

  test('returns nothing for an empty table', () => {
    expect(entries('<html><body><table></table></body></html>')).toHaveLength(0);
  });
});

describe('kochiEntries — the live table', () => {
  test('lists all 11 dams; 早明浦 falls back to the 有効 rate when 利水 is blank', async () => {
    const html = new TextDecoder('shift_jis').decode(await readFile(FIXTURE));
    const list = entries(html);
    expect(list.map((e) => e.key)).toEqual([
      '和食ダム',
      '永瀬ダム',
      '鎌井谷ダム',
      '早明浦ダム',
      '鏡ダム',
      '大渡ダム',
      '桐見ダム',
      '坂本ダム',
      '中筋川ダム',
      '横瀬川ダム',
      '以布利川ダム',
    ]);
    const sameura = observation(list.find((e) => e.key === '早明浦ダム'));
    expect(sameura?.storageRate).toBeCloseTo(0.276, 6);
    expect(sameura?.storageVolumeM3).toBe(79_660_000);
    expect(sameura?.observedAt.toISOString()).toBe('2026-10-26T15:40:00.000Z');
  });
});
