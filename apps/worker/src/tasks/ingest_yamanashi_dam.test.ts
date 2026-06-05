import { describe, expect, test } from 'bun:test';
import {
  buildYamanashiUrl,
  parseYamanashiHtml,
  parseYamanashiTimestamp,
} from './ingest_yamanashi_dam.ts';

describe('parseYamanashiTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM" (JST) → UTC', () => {
    const d = parseYamanashiTimestamp('2026/06/05 20:00');
    expect(d?.toISOString()).toBe('2026-06-05T11:00:00.000Z');
  });

  test('handles midnight crossover (JST 00:00 → previous UTC day)', () => {
    const d = parseYamanashiTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('handles "24:00" notation (next-day 00:00 JST)', () => {
    // "2026/06/04 24:00" = 2026-06-05 00:00 JST = 2026-06-04T15:00:00Z
    const d = parseYamanashiTimestamp('2026/06/04 24:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseYamanashiTimestamp('')).toBeNull();
    expect(parseYamanashiTimestamp('bad')).toBeNull();
    expect(parseYamanashiTimestamp('2026/06/05')).toBeNull();
  });
});

describe('buildYamanashiUrl', () => {
  test('encodes JST datetime and dam code correctly', () => {
    // 2026-06-05 11:00 UTC = 2026-06-05 20:00 JST
    const url = buildYamanashiUrl(
      '5002',
      new Date('2026-06-05T11:00:00.000Z'),
      'http://www3.pref.yamanashi.jp/yamanashiweb/sub/dam/dam004.asp',
    );
    expect(url).toContain('P3=5002');
    expect(url).toContain('2026%2F06%2F05');
    expect(url).toContain('20%3A00');
  });
});

// Minimal HTML matching the dam004.asp format
const SAMPLE_HTML = `
<html><body>
<table>
<tr><th>計測時刻</th><th colspan="2">ダム地点雨量</th><th>貯水位 [EL.m]</th><th>流入量 [m3/s]</th><th>放流量 [m3/s]</th></tr>
<tr><th>&nbsp;</th><th>時間 [mm/h]</th><th>累計 [mm]</th><th>&nbsp;</th><th>&nbsp;</th><th>&nbsp;</th></tr>
<tr><td>2026/06/05 20:00</td><td>0</td><td>0</td><td>895.37</td><td>0.93</td><td>1.23</td></tr>
<tr><td>2026/06/05 19:00</td><td>0</td><td>0</td><td>895.38</td><td>0.97</td><td>1.16</td></tr>
</table>
</body></html>
`;

const MIDNIGHT_HTML = `
<html><body>
<table>
<tr><th>計測時刻</th><th colspan="2">ダム地点雨量</th><th>貯水位 [EL.m]</th><th>流入量 [m3/s]</th><th>放流量 [m3/s]</th></tr>
<tr><th>&nbsp;</th><th>時間 [mm/h]</th><th>累計 [mm]</th><th>&nbsp;</th><th>&nbsp;</th><th>&nbsp;</th></tr>
<tr><td>2026/06/04 24:00</td><td>1</td><td>5</td><td>895.40</td><td>1.40</td><td>1.17</td></tr>
</table>
</body></html>
`;

describe('parseYamanashiHtml', () => {
  test('parses latest row (most recent first)', () => {
    const row = parseYamanashiHtml(SAMPLE_HTML, '大門ダム');
    expect(row).not.toBeNull();
    expect(row?.yamanashiName).toBe('大門ダム');
    expect(row?.waterLevelM).toBeCloseTo(895.37);
    expect(row?.inflowM3s).toBeCloseTo(0.93);
    expect(row?.outflowM3s).toBeCloseTo(1.23);
    expect(row?.rainfallMm).toBeCloseTo(0);
    expect(row?.observedAt.toISOString()).toBe('2026-06-05T11:00:00.000Z');
  });

  test('handles "24:00" midnight notation', () => {
    const row = parseYamanashiHtml(MIDNIGHT_HTML, '大門ダム');
    expect(row).not.toBeNull();
    expect(row?.observedAt.toISOString()).toBe('2026-06-04T15:00:00.000Z');
    expect(row?.rainfallMm).toBeCloseTo(1);
  });

  test('returns null for empty table', () => {
    expect(parseYamanashiHtml('<html><body><table></table></body></html>', '大門ダム')).toBeNull();
  });
});
