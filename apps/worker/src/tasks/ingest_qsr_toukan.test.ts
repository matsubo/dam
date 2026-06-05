import { describe, expect, test } from 'bun:test';
import { parseToukantable, parseToukantimestamp } from './ingest_qsr_toukan.ts';

describe('parseToukantimestamp', () => {
  test('parses JST timestamp to UTC', () => {
    const d = parseToukantimestamp('2026/06/05 19:00');
    expect(d?.toISOString()).toBe('2026-06-05T10:00:00.000Z');
    // JST 19:00 = UTC 10:00
    expect(d?.getUTCHours()).toBe(10);
    expect(d?.getUTCDate()).toBe(5);
  });

  test('returns null for invalid', () => {
    expect(parseToukantimestamp('')).toBeNull();
    expect(parseToukantimestamp('bad timestamp')).toBeNull();
  });

  test('handles midnight JST (UTC previous day)', () => {
    const d = parseToukantimestamp('2026/06/05 00:00');
    // JST 00:00 = UTC 2026/06/04 15:00
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });
});

describe('parseToukantable', () => {
  const sampleHtml = `
<table>decorative</table>
<table>
  <tr><th>観測時刻</th><th>貯水位[m]</th><th>流入量[m3/s]</th><th>ゲート放流量[m3/s]</th><th>発電使用水量[m3/s]</th><th>全放流量[m3/s]</th><th>地点雨量</th><th colspan="3">流域</th></tr>
  <tr><th>時間[mm]</th><th>累加[mm]</th><th>時間[mm]</th><th>累加[mm]</th></tr>
  <tr><td>2026/06/05 19:00</td><td>249.17</td><td>34.45</td><td>33.49</td><td>0.00</td><td>33.49</td><td>0</td><td>0</td><td>0.0</td><td>0.0</td></tr>
</table>
<table>
  <tr><th>観測時刻</th><th>貯水位[m]</th><th>流入量[m3/s]</th><th>ゲート放流量[m3/s]</th><th>発電使用水量[m3/s]</th><th>全放流量[m3/s]</th><th>地点雨量</th><th colspan="3">流域</th></tr>
  <tr><th>時間[mm]</th><th>累加[mm]</th><th>時間[mm]</th><th>累加[mm]</th></tr>
  <tr><td>2026/06/05 19:00</td><td>296.67</td><td>15.65</td><td>0.00</td><td>22.65</td><td>22.65</td><td>0</td><td>0</td><td>0.0</td><td>0.0</td></tr>
</table>
`;

  test('parses 松原ダム (table index 1)', () => {
    const row = parseToukantable(sampleHtml, 1);
    expect(row).not.toBeNull();
    expect(row?.waterLevelM).toBe(249.17);
    expect(row?.inflowM3s).toBe(34.45);
    expect(row?.outflowM3s).toBe(33.49); // 全放流量 col[5]
    expect(row?.rainfallMm).toBe(0);
    expect(row?.observedAt.getUTCHours()).toBe(10); // JST 19:00 → UTC 10:00
  });

  test('parses 下筌ダム (table index 2)', () => {
    const row = parseToukantable(sampleHtml, 2);
    expect(row).not.toBeNull();
    expect(row?.waterLevelM).toBe(296.67);
    expect(row?.inflowM3s).toBe(15.65);
    expect(row?.outflowM3s).toBe(22.65); // 全放流量 = gate + power
    expect(row?.rainfallMm).toBe(0);
  });

  test('returns null if table index out of range', () => {
    expect(parseToukantable(sampleHtml, 5)).toBeNull();
  });

  test('returns null if data row has missing values', () => {
    const emptyTable = `
<table>decorative</table>
<table>
  <tr><th>観測時刻</th></tr>
  <tr></tr>
  <tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>
</table>
`;
    expect(parseToukantable(emptyTable, 1)).toBeNull();
  });

  test('handles rain column with decimal values', () => {
    const html = `
<table>decorative</table>
<table>
  <tr><th>観測時刻</th><th>貯水位[m]</th><th>流入量[m3/s]</th><th>ゲート</th><th>発電</th><th>全放流量[m3/s]</th><th>地点</th></tr>
  <tr><th>h</th><th>acc</th><th>h2</th><th>acc2</th></tr>
  <tr><td>2026/06/05 05:00</td><td>250.00</td><td>100.50</td><td>80.00</td><td>10.00</td><td>90.00</td><td>5.5</td></tr>
</table>
`;
    const row = parseToukantable(html, 1);
    expect(row?.waterLevelM).toBe(250.0);
    expect(row?.inflowM3s).toBe(100.5);
    expect(row?.outflowM3s).toBe(90.0);
    expect(row?.rainfallMm).toBe(5.5);
  });
});
