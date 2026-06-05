// apps/worker/src/tasks/ingest_nara_kasen.test.ts

import { describe, expect, test } from 'bun:test';
import { parseNaraPage, parseNaraTimestamp } from './ingest_nara_kasen.ts';

// refDt = 2026-06-05 08:10 UTC (= 17:10 JST, same as page timestamp)
const REF_DT = new Date('2026-06-05T08:10:00.000Z');

describe('parseNaraTimestamp', () => {
  test('parses "06/05 17:10" (JST) → UTC', () => {
    const d = parseNaraTimestamp('06/05 17:10', REF_DT);
    expect(d?.toISOString()).toBe('2026-06-05T08:10:00.000Z');
  });

  test('handles midnight crossover (JST 01:00 → previous UTC day)', () => {
    const d = parseNaraTimestamp('06/05 01:00', REF_DT);
    expect(d?.toISOString()).toBe('2026-06-04T16:00:00.000Z');
  });

  test('year rollover: Dec 31 timestamp seen in early Jan → uses previous year', () => {
    const janRef = new Date('2026-01-01T01:00:00.000Z'); // 2026-01-01 10:00 JST
    const d = parseNaraTimestamp('12/31 23:50', janRef);
    expect(d?.toISOString()).toBe('2025-12-31T14:50:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseNaraTimestamp('', REF_DT)).toBeNull();
    expect(parseNaraTimestamp('bad', REF_DT)).toBeNull();
    expect(parseNaraTimestamp('06/05', REF_DT)).toBeNull();
  });
});

// Minimal sample page: 3 tables (天理/初瀬 with data, 岩井川 all-null/stale)
// Encoded as Shift_JIS source but we pass decoded string to the parser.
const SAMPLE_PAGE = `<html><body>
<table cellspacing="0" cellpadding="0" class="datatable bf">
<tr class="site">
<td colspan="4" class="ui-bar-f site"><span class="sitename">天理ダム</span></td>
</tr>
<th class="ui-bar-d">時刻</th><th class="ui-bar-d">貯水位</th><th class="ui-bar-d">流入量</th><th class="ui-bar-d">放流量</th>
<tr>
<td class="ui-bar-g">06/05&nbsp;17:10</td><td class="ui-bar-g cenval "><img height="13" width="13" src="../img/arrow/arw_d.gif">&nbsp;253.05</td><td class="ui-bar-g cenval "><img height="13" width="13" src="../img/arrow/arw_d.gif">&nbsp;&nbsp;&nbsp;&nbsp;0.210</td><td class="ui-bar-g cenval "><img height="13" width="13" src="../img/arrow/arw_r.gif">&nbsp;&nbsp;&nbsp;&nbsp;0.380</td>
</tr>
</table>
<table cellspacing="0" cellpadding="0" class="datatable bf">
<tr class="site">
<td colspan="4" class="ui-bar-f site"><span class="sitename">初瀬ダム</span></td>
</tr>
<th class="ui-bar-d">時刻</th><th class="ui-bar-d">貯水位</th><th class="ui-bar-d">流入量</th><th class="ui-bar-d">放流量</th>
<tr>
<td class="ui-bar-g">06/05&nbsp;17:10</td><td class="ui-bar-g cenval "><img height="13" width="13" src="../img/arrow/arw_d.gif">&nbsp;221.72</td><td class="ui-bar-g cenval "><img height="13" width="13" src="../img/arrow/arw_d.gif">&nbsp;&nbsp;&nbsp;&nbsp;0.390</td><td class="ui-bar-g cenval "><img height="13" width="13" src="../img/arrow/arw_r.gif">&nbsp;&nbsp;&nbsp;&nbsp;0.700</td>
</tr>
</table>
<table cellspacing="0" cellpadding="0" class="datatable bf">
<tr class="site">
<td colspan="4" class="ui-bar-f site"><span class="sitename">岩井川ダム</span></td>
</tr>
<th class="ui-bar-d">時刻</th><th class="ui-bar-d">貯水位</th><th class="ui-bar-d">流入量</th><th class="ui-bar-d">放流量</th>
<tr>
<td class="ui-bar-g">03/23&nbsp;14:40</td><td class="ui-bar-g">&nbsp;</td><td class="ui-bar-g">&nbsp;</td><td class="ui-bar-g">&nbsp;</td>
</tr>
</table>
</body></html>`;

describe('parseNaraPage', () => {
  test('parses 2 dams with data (岩井川 all-null skipped)', () => {
    const rows = parseNaraPage(SAMPLE_PAGE, REF_DT);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.naraName)).toEqual(['天理ダム', '初瀬ダム']);
  });

  test('天理ダム: all fields parsed correctly', () => {
    const r = parseNaraPage(SAMPLE_PAGE, REF_DT).find((x) => x.naraName === '天理ダム');
    expect(r).toBeDefined();
    expect(r?.observedAt.toISOString()).toBe('2026-06-05T08:10:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(253.05);
    expect(r?.inflowM3s).toBeCloseTo(0.21);
    expect(r?.outflowM3s).toBeCloseTo(0.38);
  });

  test('初瀬ダム: all fields parsed correctly', () => {
    const r = parseNaraPage(SAMPLE_PAGE, REF_DT).find((x) => x.naraName === '初瀬ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(221.72);
    expect(r?.inflowM3s).toBeCloseTo(0.39);
    expect(r?.outflowM3s).toBeCloseTo(0.7);
  });

  test('岩井川ダム: all-null row excluded from results', () => {
    const rows = parseNaraPage(SAMPLE_PAGE, REF_DT);
    expect(rows.find((r) => r.naraName === '岩井川ダム')).toBeUndefined();
  });

  test('returns empty array for page without tables', () => {
    expect(parseNaraPage('<html><body>no data</body></html>', REF_DT)).toHaveLength(0);
  });
});
