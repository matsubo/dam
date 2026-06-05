import { describe, expect, test } from 'bun:test';
import { parseKyotoTable, parseKyotoTimestamp } from './ingest_kyoto_bousai.ts';

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

describe('parseKyotoTable', () => {
  test('parses all rows with any measurement data (瀬田洗堰1 included, unmatched at DB stage)', () => {
    // 瀬田洗堰1 has non-null inflow/outflow so it passes the all-null filter.
    // It will fail master matching (not a dam) and be silently skipped then.
    const rows = parseKyotoTable(SAMPLE_HTML);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.kyotoName)).toEqual([
      '畑川ダム',
      '天ヶ瀬ダム',
      '瀬田洗堰1',
      '大野ダム',
    ]);
  });

  test('畑川ダム: all fields parsed correctly', () => {
    const r = parseKyotoTable(SAMPLE_HTML).find((x) => x.kyotoName === '畑川ダム');
    expect(r).toBeDefined();
    expect(r?.observedAt.toISOString()).toBe('2026-06-05T12:20:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(158.28);
    expect(r?.storageVolumeM3).toBeCloseTo(844_000);
    expect(r?.inflowM3s).toBeCloseTo(0.43);
    expect(r?.outflowM3s).toBeCloseTo(0.43);
  });

  test('storageVolumeM3 = ×10³m³ × 1000 (天ヶ瀬ダム: 15196×1000)', () => {
    const r = parseKyotoTable(SAMPLE_HTML).find((x) => x.kyotoName === '天ヶ瀬ダム');
    expect(r?.storageVolumeM3).toBeCloseTo(15_196_000);
    expect(r?.inflowM3s).toBeCloseTo(696.52);
    expect(r?.outflowM3s).toBeCloseTo(726.26);
  });

  test('大野ダム: timestamps with JST→UTC', () => {
    const r = parseKyotoTable(SAMPLE_HTML).find((x) => x.kyotoName === '大野ダム');
    expect(r?.observedAt.toISOString()).toBe('2026-06-05T12:20:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(155.43);
  });

  test('returns empty array for empty HTML', () => {
    expect(parseKyotoTable('')).toHaveLength(0);
    expect(parseKyotoTable('<table></table>')).toHaveLength(0);
  });
});
