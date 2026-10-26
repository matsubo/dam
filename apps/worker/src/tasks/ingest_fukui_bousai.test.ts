// apps/worker/src/tasks/ingest_fukui_bousai.test.ts
//
// Page → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { fukuiEntries, parseFukuiTimestamp } from './ingest_fukui_bousai.ts';

function observed(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}
const states = (entries: Entry[]) =>
  entries.map((e) => [e.name, typeof e.reading === 'function' ? 'fn' : e.reading.state]);

describe('parseFukuiTimestamp', () => {
  test('parses "YYYY&nbsp;MM/DD&nbsp;HH:MM" JST → UTC', () => {
    const d = parseFukuiTimestamp('2026&nbsp;06/05&nbsp;16:50');
    expect(d?.toISOString()).toBe('2026-06-05T07:50:00.000Z');
  });

  test('handles midnight crossover (JST < 09:00 → previous UTC day)', () => {
    const d = parseFukuiTimestamp('2026&nbsp;06/05&nbsp;08:00');
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed or empty input', () => {
    expect(parseFukuiTimestamp('')).toBeNull();
    expect(parseFukuiTimestamp('bad')).toBeNull();
  });
});

// Minimal sample page: 3 dams covering the main data cases.
// Row layout (all on one line per dam):
//   name | location | timestamp | storageRate | waterLevel | storage | inflow | outflow | manager
const SAMPLE_PAGE = `<html><head><meta charset="Shift_JIS"></head><body>
<table>
<thead>
<tr>
<th rowspan="2" class="siteName">局名</th>
<th rowspan="2" class="location">所在地</th>
<th rowspan="2" class="latestTime">最新観測時刻</th>
<th>貯水率<br>(利水容量)</th><th>貯水位</th><th>有効<br>貯水量</th><th>流入量</th><th>放流量</th>
<th rowspan="2" class="manager">管理者名</th>
</tr>
<tr><th>[%]</th><th>[m]</th><th>[10<sup>3</sup>m<sup>3</sup>]</th><th>[m<sup>3</sup>/s]</th><th>[m<sup>3</sup>/s]</th></tr>
</thead>
<tbody>
<tr><td nowrap="nowrap" class="normal1"><a href="javascript:void(0)" onClick="myIn('2','202606051650','1')">永平寺ダム</a></td><td nowrap="nowrap" class="normal1">永平寺町志比</td><td nowrap="nowrap" class="normal1">2026&nbsp;06/05&nbsp;16:50</td><td nowrap="nowrap" class="normal1">&rarr;&nbsp;&nbsp;99.55</td><td nowrap="nowrap" class="normal1">&rarr;&nbsp;&nbsp;319.76</td><td nowrap="nowrap" class="normal1">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;438</td><td nowrap="nowrap" class="normal1">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.170</td><td nowrap="nowrap" class="normal1">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.170</td><td nowrap="nowrap" class="normal1">龍ヶ鼻・永平寺ダム統管</td></tr>
<tr><td nowrap="nowrap" class="normal0"><a href="javascript:void(0)" onClick="myIn('11','202606051650','1')">真名川ダム</a></td><td nowrap="nowrap" class="normal0">大野市下若生子</td><td nowrap="nowrap" class="normal0">2026&nbsp;06/05&nbsp;16:50</td><td nowrap="nowrap" class="normal0">&rarr;&nbsp;&nbsp;55.90</td><td nowrap="nowrap" class="normal0">&rarr;&nbsp;&nbsp;353.18</td><td nowrap="nowrap" class="normal0">&nbsp;</td><td nowrap="nowrap" class="normal0">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;2.360</td><td nowrap="nowrap" class="normal0">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;10.460</td><td nowrap="nowrap" class="normal0">九頭竜川ダム統管</td></tr>
<tr><td nowrap="nowrap" class="normal1"><a href="javascript:void(0)" onClick="myIn('18','202606051650','1')">開谷ダム</a></td><td nowrap="nowrap" class="normal1">越前町八田</td><td nowrap="nowrap" class="normal1">2026&nbsp;06/05&nbsp;16:50</td><td nowrap="nowrap" class="normal1">&rarr;&nbsp;&nbsp;58.40</td><td nowrap="nowrap" class="normal1">&rarr;&nbsp;&nbsp;120.49</td><td nowrap="nowrap" class="normal1">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;59</td><td nowrap="nowrap" class="normal1">---</td><td nowrap="nowrap" class="normal1">---</td><td nowrap="nowrap" class="normal1">越前町</td></tr>
</tbody>
</table>
</body></html>`;

describe('fukuiEntries', () => {
  const entries = fukuiEntries(SAMPLE_PAGE);
  const named = (n: string) => entries.find((e) => e.name === n);

  test('parses all 3 dam rows, keyed by name', () => {
    expect(entries.map((e) => [e.key, e.pref])).toEqual([
      ['永平寺ダム', '18'],
      ['真名川ダム', '18'],
      ['開谷ダム', '18'],
    ]);
  });

  test('all rows share the same observedAt (2026-06-05T07:50Z)', () => {
    for (const e of entries) {
      expect(observed(e)?.observedAt.toISOString()).toBe('2026-06-05T07:50:00.000Z');
    }
  });

  test('永平寺ダム: all fields parsed correctly', () => {
    const r = observed(named('永平寺ダム'));
    expect(r?.storageRate).toBeCloseTo(0.9955);
    expect(r?.waterLevelM).toBeCloseTo(319.76);
    expect(r?.storageVolumeM3).toBe(438_000);
    expect(r?.inflowM3s).toBeCloseTo(0.17);
    expect(r?.outflowM3s).toBeCloseTo(0.17);
  });

  test('converts 有効貯水量 10³m³ → m³ (× 1000)', () => {
    expect(observed(named('開谷ダム'))?.storageVolumeM3).toBe(59_000);
  });

  test('真名川ダム: missing storage (&nbsp;) → null', () => {
    const r = observed(named('真名川ダム'));
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.storageRate).toBeCloseTo(0.559);
    expect(r?.inflowM3s).toBeCloseTo(2.36);
    expect(r?.outflowM3s).toBeCloseTo(10.46);
  });

  test('開谷ダム: "---" inflow/outflow → null', () => {
    const r = observed(named('開谷ダム'));
    expect(r?.inflowM3s).toBeNull();
    expect(r?.outflowM3s).toBeNull();
  });

  test('lists nothing for a page with no dam rows', () => {
    expect(fukuiEntries('<html><body>no data</body></html>')).toHaveLength(0);
    expect(fukuiEntries('')).toHaveLength(0);
  });
});

// 滝波ダム as the live 現況表 printed it on 2026-09-28: a timestamp, then "---"
// and blanks in every value column.
const TAKINAMI_ROW =
  '<tr><td nowrap class="normal0"><a href="javascript:void(0)" onClick="myIn(\'16\',\'202609280820\',\'1\')">滝波ダム</a></td><td nowrap class="normal0">福井市清水町滝波</td><td nowrap class="normal0">2026&nbsp;09/28&nbsp;08:00</td><td nowrap class="normal0">---</td><td nowrap class="normal0">&nbsp;</td><td nowrap class="normal0">&nbsp;</td><td nowrap class="normal0">&nbsp;</td><td nowrap class="normal0">&nbsp;</td><td nowrap class="normal0">福井市</td>';

describe('fukuiEntries states', () => {
  test('lists every dam; the one whose value columns are all empty is provider-marked empty', () => {
    const page = SAMPLE_PAGE.replace('</tbody>', `${TAKINAMI_ROW}</tbody>`);
    expect(states(fukuiEntries(page))).toEqual([
      ['永平寺ダム', 'values'],
      ['真名川ダム', 'values'],
      ['開谷ダム', 'values'],
      ['滝波ダム', 'empty'],
    ]);
  });

  test('an unreadable value cell is unreadable, not "no value"', () => {
    // Garbage where a number belongs is more likely our parser than the
    // provider publishing nothing.
    const garbled = TAKINAMI_ROW.replace('>---<', '>12,3<');
    expect(states(fukuiEntries(garbled))).toEqual([['滝波ダム', 'unreadable']]);
  });

  test('a value without a readable 最新観測時刻 is unreadable', () => {
    const undated = SAMPLE_PAGE.replace('2026&nbsp;06/05&nbsp;16:50', '--/-- --:--');
    expect(states(fukuiEntries(undated))[0]).toEqual(['永平寺ダム', 'unreadable']);
  });
});
