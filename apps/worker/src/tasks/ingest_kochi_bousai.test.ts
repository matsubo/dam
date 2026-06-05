import { describe, expect, test } from 'bun:test';
import { parseKochiTable, parseKochiTimestamp } from './ingest_kochi_bousai.ts';

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

describe('parseKochiTable', () => {
  test('parses 2 dam rows', () => {
    const rows = parseKochiTable(SAMPLE_HTML);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kochiName)).toEqual(['和食ダム', '早明浦ダム']);
  });

  test('observedAt converted from JST to UTC', () => {
    const rows = parseKochiTable(SAMPLE_HTML);
    for (const r of rows) {
      expect(r.observedAt?.toISOString()).toBe('2026-06-05T11:40:00.000Z');
    }
  });

  test('和食ダム: all fields parsed correctly', () => {
    const r = parseKochiTable(SAMPLE_HTML).find((x) => x.kochiName === '和食ダム');
    expect(r).toBeDefined();
    expect(r?.storageRate).toBeCloseTo(0.463);
    expect(r?.storageVolumeM3).toBeCloseTo(374_000);
    expect(r?.waterLevelM).toBeCloseTo(87.72);
    expect(r?.inflowM3s).toBeCloseTo(0.163);
    expect(r?.outflowM3s).toBeCloseTo(0.064);
  });

  test('早明浦ダム: large storage volume parsed correctly', () => {
    const r = parseKochiTable(SAMPLE_HTML).find((x) => x.kochiName === '早明浦ダム');
    expect(r).toBeDefined();
    expect(r?.storageRate).toBeCloseTo(0.672);
    expect(r?.storageVolumeM3).toBeCloseTo(194_160_000);
    expect(r?.waterLevelM).toBeCloseTo(328.87);
    expect(r?.inflowM3s).toBeCloseTo(78.94);
    expect(r?.outflowM3s).toBeCloseTo(58.5);
  });

  test('storageRate clamped to [0, 1]', () => {
    const html = SAMPLE_HTML.replace('46.30', '105.00');
    const rows = parseKochiTable(html);
    const r = rows.find((x) => x.kochiName === '和食ダム');
    expect(r?.storageRate).toBe(1);
  });

  test('returns empty array for empty table', () => {
    expect(parseKochiTable('<html><body><table></table></body></html>')).toHaveLength(0);
  });
});
