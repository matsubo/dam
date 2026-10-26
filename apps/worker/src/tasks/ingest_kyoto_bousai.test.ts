// apps/worker/src/tasks/ingest_kyoto_bousai.test.ts
//
// Sample HTML → universe entries, no database: binding and writing belong to
// the ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { kyotoEntries, parseKyotoTable, parseKyotoTimestamp } from './ingest_kyoto_bousai.ts';

function observation(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}

const entries = (html: string) => kyotoEntries(parseKyotoTable(html));

describe('parseKyotoTimestamp', () => {
  test('parses "YYYY MM/DD HH:MM" (JST) → UTC', () => {
    const d = parseKyotoTimestamp('2026 06/05 21:20');
    expect(d?.toISOString()).toBe('2026-06-05T12:20:00.000Z');
  });

  test('handles non-breaking space (\\u00A0) as whitespace', () => {
    const d = parseKyotoTimestamp('2026 06/05 21:20');
    expect(d?.toISOString()).toBe('2026-06-05T12:20:00.000Z');
  });

  test('midnight crossover: JST 00:00 → previous UTC day', () => {
    const d = parseKyotoTimestamp('2026 06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for empty or malformed string', () => {
    expect(parseKyotoTimestamp('')).toBeNull();
    expect(parseKyotoTimestamp('2026/06/05 21:20')).toBeNull();
    expect(parseKyotoTimestamp('bad')).toBeNull();
  });
});

// Truncated HTML matching the actual page structure (Shift_JIS decoded to UTF-8)
const SAMPLE_HTML = `
<table class="data dam">
<tr>
<th rowspan="2">管理者名</th><th rowspan="2">河川名</th><th rowspan="2">局名</th>
<th rowspan="2">所在地</th><th rowspan="2">最新観測時刻</th>
<th colspan="2">流域平均雨量</th>
<th>貯水位</th><th>貯水量</th><th>流入量</th><th>放流量</th>
</tr>
<tr>
<th>時間</th><th>累計</th>
<th>[EL.m]</th><th>[×10³m³]</th><th>[m³/s]</th><th>[m³/s]</th>
</tr>
<tr>
<td nowrap class="odd">大野ダム</td>
<td nowrap class="odd">畑川</td>
<td nowrap class="odd"><a class="site" href="javascript:void(0)" onClick="myIn('9','202606052120','1')">畑川ダム</a></td>
<td nowrap class="odd">船井郡京丹波町</td>
<td nowrap class="odd">2026&nbsp;06/05&nbsp;21:20</td>
<td nowrap align="center" class="odd">&nbsp;&nbsp;&nbsp;0.0</td>
<td nowrap align="center" class="odd">&nbsp;&nbsp;&nbsp;0.0</td>
<td nowrap align="center" class="odd">&rarr;&nbsp;&nbsp;158.28</td>
<td nowrap align="center" class="odd">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;844</td>
<td nowrap align="center" class="odd">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.43</td>
<td nowrap align="center" class="odd">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.43</td>
</tr>
<tr>
<td nowrap class="">淀川ダム統管</td>
<td nowrap class="">宇治川</td>
<td nowrap class=""><a class="site" href="javascript:void(0)" onClick="myIn('6','202606052120','1')">天ヶ瀬ダム</a></td>
<td nowrap class="">宇治市槇島町</td>
<td nowrap class="">2026&nbsp;06/05&nbsp;21:10</td>
<td nowrap align="center" class="">&nbsp;</td>
<td nowrap align="center" class="">&nbsp;</td>
<td nowrap align="center" class="">&uarr;&nbsp;&nbsp;&nbsp;76.19</td>
<td nowrap align="center" class="">&uarr;&nbsp;&nbsp;15196</td>
<td nowrap align="center" class="">&uarr;&nbsp;&nbsp;&nbsp;&nbsp;696.52</td>
<td nowrap align="center" class="">&darr;&nbsp;&nbsp;&nbsp;&nbsp;726.26</td>
</tr>
<tr>
<td nowrap class="odd">琵琶湖河川</td>
<td nowrap class="odd">瀬田川</td>
<td nowrap class="odd"><a class="site" href="javascript:void(0)" onClick="myIn('7','202606052120','1')">瀬田洗堰1</a></td>
<td nowrap class="odd">大津市黒津</td>
<td nowrap class="odd">2026&nbsp;06/05&nbsp;21:20</td>
<td nowrap align="center" class="odd">&nbsp;</td>
<td nowrap align="center" class="odd">&nbsp;</td>
<td nowrap align="center" class="odd">&nbsp;&nbsp;</td>
<td nowrap align="center" class="odd">&nbsp;&nbsp;</td>
<td nowrap align="center" class="odd">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;218.29</td>
<td nowrap align="center" class="odd">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;716.10</td>
</tr>
<tr>
<td nowrap class="">大野ダム</td>
<td nowrap class="">由良川</td>
<td nowrap class=""><a class="site" href="javascript:void(0)" onClick="myIn('1','202606052120','1')">大野ダム</a></td>
<td nowrap class="">南丹市美山町</td>
<td nowrap class="">2026&nbsp;06/05&nbsp;21:20</td>
<td nowrap align="center" class="">&nbsp;&nbsp;&nbsp;0.0</td>
<td nowrap align="center" class="">&nbsp;&nbsp;89.8</td>
<td nowrap align="center" class="">&rarr;&nbsp;&nbsp;155.43</td>
<td nowrap align="center" class="">&rarr;&nbsp;&nbsp;&nbsp;4286</td>
<td nowrap align="center" class="">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;11.47</td>
<td nowrap align="center" class="">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;10.20</td>
</tr>
<tr>
<td nowrap align="right" colspan="11" class="page">1/1&nbsp;</td>
</tr>
</table>
`;

describe('kyotoEntries', () => {
  test('lists every row: 瀬田洗堰1 never bound, 天ヶ瀬 pinned to 天ヶ瀬（再）', () => {
    const list = entries(SAMPLE_HTML);
    // 天ヶ瀬's stem ties 天ヶ瀬（再）, 天ヶ瀬（元） and a bare 天ヶ瀬 row (no NDI).
    expect(list.map((e) => [e.key, e.bind])).toEqual([
      ['畑川ダム', undefined],
      ['天ヶ瀬ダム', { ndi: '1495' }],
      ['瀬田洗堰1', 'never'],
      ['大野ダム', undefined],
    ]);
    // 布目ダム sits in Nara (29) but appears in this feed.
    for (const e of list) expect(e.pref).toEqual(['26', '29']);
  });

  test('畑川ダム: all fields parsed correctly', () => {
    const o = observation(entries(SAMPLE_HTML).find((x) => x.key === '畑川ダム'));
    expect(o?.observedAt.toISOString()).toBe('2026-06-05T12:20:00.000Z');
    expect(o?.waterLevelM).toBeCloseTo(158.28);
    expect(o?.storageVolumeM3).toBeCloseTo(844_000);
    expect(o?.inflowM3s).toBeCloseTo(0.43);
    expect(o?.outflowM3s).toBeCloseTo(0.43);
  });

  test('storageVolumeM3 = ×10³m³ × 1000 (天ヶ瀬ダム: 15196×1000)', () => {
    const o = observation(entries(SAMPLE_HTML).find((x) => x.key === '天ヶ瀬ダム'));
    expect(o?.storageVolumeM3).toBeCloseTo(15_196_000);
    expect(o?.inflowM3s).toBeCloseTo(696.52);
    expect(o?.outflowM3s).toBeCloseTo(726.26);
  });

  test('大野ダム: timestamps with JST→UTC', () => {
    const o = observation(entries(SAMPLE_HTML).find((x) => x.key === '大野ダム'));
    expect(o?.observedAt.toISOString()).toBe('2026-06-05T12:20:00.000Z');
    expect(o?.waterLevelM).toBeCloseTo(155.43);
  });

  test('a row without a time, or with blank level and flows, is listed unreadable', () => {
    const html = SAMPLE_HTML.replace('2026&nbsp;06/05&nbsp;21:10', '&nbsp;')
      .replace('&rarr;&nbsp;&nbsp;&nbsp;&nbsp;218.29', '&nbsp;')
      .replace('&rarr;&nbsp;&nbsp;&nbsp;&nbsp;716.10', '&nbsp;');
    const states = entries(html).map((e) => (typeof e.reading === 'function' ? '' : e.reading));
    expect(states).toEqual([
      expect.objectContaining({ state: 'values' }),
      { state: 'unreadable', why: 'no 最新観測時刻' },
      { state: 'unreadable', why: 'no 貯水位 or flow' },
      expect.objectContaining({ state: 'values' }),
    ]);
  });

  test('returns nothing for empty HTML', () => {
    expect(entries('')).toHaveLength(0);
    expect(entries('<table></table>')).toHaveLength(0);
  });
});
