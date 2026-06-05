// apps/worker/src/tasks/ingest_fukui_bousai.test.ts

import { describe, expect, test } from 'bun:test';
import { parseFukuiPage, parseFukuiTimestamp } from './ingest_fukui_bousai.ts';

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

describe('parseFukuiPage', () => {
  test('parses all 3 dam rows', () => {
    const rows = parseFukuiPage(SAMPLE_PAGE);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.fukuiName)).toEqual(['永平寺ダム', '真名川ダム', '開谷ダム']);
  });

  test('all rows share the same observedAt (2026-06-05T07:50Z)', () => {
    const rows = parseFukuiPage(SAMPLE_PAGE);
    const ts = '2026-06-05T07:50:00.000Z';
    for (const r of rows) {
      expect(r.observedAt.toISOString()).toBe(ts);
    }
  });

  test('永平寺ダム: all fields parsed correctly', () => {
    const rows = parseFukuiPage(SAMPLE_PAGE);
    const r = rows.find((x) => x.fukuiName === '永平寺ダム');
    expect(r).toBeDefined();
    expect(r?.storageRate).toBeCloseTo(0.9955);
    expect(r?.waterLevelM).toBeCloseTo(319.76);
    expect(r?.storageVolumeM3).toBe(438_000);
    expect(r?.inflowM3s).toBeCloseTo(0.17);
    expect(r?.outflowM3s).toBeCloseTo(0.17);
  });

  test('converts 有効貯水量 10³m³ → m³ (× 1000)', () => {
    const rows = parseFukuiPage(SAMPLE_PAGE);
    const r = rows.find((x) => x.fukuiName === '開谷ダム');
    expect(r?.storageVolumeM3).toBe(59_000);
  });

  test('真名川ダム: missing storage (&nbsp;) → null', () => {
    const rows = parseFukuiPage(SAMPLE_PAGE);
    const r = rows.find((x) => x.fukuiName === '真名川ダム');
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.storageRate).toBeCloseTo(0.559);
    expect(r?.inflowM3s).toBeCloseTo(2.36);
    expect(r?.outflowM3s).toBeCloseTo(10.46);
  });

  test('開谷ダム: "---" inflow/outflow → null', () => {
    const rows = parseFukuiPage(SAMPLE_PAGE);
    const r = rows.find((x) => x.fukuiName === '開谷ダム');
    expect(r?.inflowM3s).toBeNull();
    expect(r?.outflowM3s).toBeNull();
  });

  test('returns empty array for page with no dam rows', () => {
    expect(parseFukuiPage('<html><body>no data</body></html>')).toHaveLength(0);
  });

  test('returns empty array for empty string', () => {
    expect(parseFukuiPage('')).toHaveLength(0);
  });
});
