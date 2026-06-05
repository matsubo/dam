import { describe, expect, test } from 'bun:test';
import {
  detectColumns,
  parseBousaiTimestamp,
  parseBousaiWebTable,
} from './ingest_shizuoka_bousai.ts';

describe('parseBousaiTimestamp', () => {
  test('parses YYYY/MM/DD HH:MM JST → UTC', () => {
    const d = parseBousaiTimestamp('2026/06/05 10:00');
    expect(d?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
  });

  test('parses YYYY MM/DD HH:MM (with space separator)', () => {
    const d = parseBousaiTimestamp('2026 06/05 10:00');
    expect(d?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
  });

  test('handles &nbsp; in timestamp string', () => {
    const d = parseBousaiTimestamp('2026&nbsp;06/05&nbsp;10:00');
    expect(d?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
  });

  test('handles midnight correctly (00:00 JST = -9h UTC)', () => {
    const d = parseBousaiTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for invalid input', () => {
    expect(parseBousaiTimestamp('')).toBeNull();
    expect(parseBousaiTimestamp('invalid')).toBeNull();
  });
});

describe('detectColumns', () => {
  test('detects standard 防災Web header layout (Akita-style)', () => {
    const headers = [
      '管轄',
      '河川名',
      '局名',
      '所在地',
      '最新観測時刻',
      '貯水位[EL.m]',
      '流入量[m³/s]',
      '放流量[m³/s]',
    ];
    const cols = detectColumns(headers);
    expect(cols.damName).toBe(2);
    expect(cols.timestamp).toBe(4);
    expect(cols.waterLevel).toBe(5);
    expect(cols.inflow).toBe(6);
    expect(cols.outflow).toBe(7);
  });

  test('detects Fukui-style layout with storage fields', () => {
    const headers = [
      '局名',
      '所在地',
      '最新観測時刻',
      '貯水率[%]',
      '貯水位[m]',
      '有効貯水量[10³m³]',
      '流入量[m³/s]',
      '放流量[m³/s]',
      '管理者名',
    ];
    const cols = detectColumns(headers);
    expect(cols.damName).toBe(0);
    expect(cols.timestamp).toBe(2);
    expect(cols.storageRate).toBe(3);
    expect(cols.waterLevel).toBe(4);
    expect(cols.storageVolume).toBe(5);
    expect(cols.inflow).toBe(6);
    expect(cols.outflow).toBe(7);
  });

  test('returns -1 for missing columns', () => {
    const cols = detectColumns(['col1', 'col2']);
    expect(cols.damName).toBe(-1);
    expect(cols.timestamp).toBe(-1);
  });

  test('distinguishes 貯水率 from 貯水量', () => {
    const headers = ['局名', '貯水率[%]', '有効貯水量[10³m³]'];
    const cols = detectColumns(headers);
    expect(cols.storageRate).toBe(1);
    expect(cols.storageVolume).toBe(2);
  });
});

// Sample 防災Web HTML fixture (Akita column layout)
const SAMPLE_HTML = `<!DOCTYPE html>
<html><body>
<table>
<tr>
<th>管轄</th><th>河川名</th><th>局名</th><th>所在地</th>
<th>最新観測時刻</th><th>貯水位[EL.m]</th><th>流入量[m³/s]</th><th>放流量[m³/s]</th>
</tr>
<tr>
<td class="normal0">静岡</td>
<td class="normal0">安倍川</td>
<td class="normal0"><a href="#">池田ダム</a></td>
<td class="normal0">静岡市</td>
<td class="normal0">2026/06/05 10:00</td>
<td class="normal0">234.56</td>
<td class="normal0">12.3</td>
<td class="normal0">8.5</td>
</tr>
<tr>
<td class="normal1">静岡</td>
<td class="normal1">大井川</td>
<td class="normal1"><a href="#">瀬戸ダム</a></td>
<td class="normal1">静岡市</td>
<td class="normal1">2026/06/05 10:00</td>
<td class="normal1">345.67</td>
<td class="normal1">45.6</td>
<td class="normal1">---</td>
</tr>
</table>
</body></html>`;

// Sample with storage columns (Fukui-style)
const SAMPLE_HTML_WITH_STORAGE = `<!DOCTYPE html>
<html><body>
<table>
<tr>
<th>局名</th><th>所在地</th><th>最新観測時刻</th>
<th>貯水率[%]</th><th>貯水位[m]</th><th>有効貯水量[10³m³]</th>
<th>流入量[m³/s]</th><th>放流量[m³/s]</th><th>管理者名</th>
</tr>
<tr>
<td class="normal0"><a href="#">太田川ダム</a></td>
<td class="normal0">浜松市</td>
<td class="normal0">2026/06/05 10:00</td>
<td class="normal0">75.3</td>
<td class="normal0">156.78</td>
<td class="normal0">1234</td>
<td class="normal0">5.6</td>
<td class="normal0">3.2</td>
<td class="normal0">静岡県</td>
</tr>
</table>
</body></html>`;

describe('parseBousaiWebTable', () => {
  test('extracts dam rows from Akita-style table', () => {
    const rows = parseBousaiWebTable(SAMPLE_HTML);
    expect(rows).toHaveLength(2);
  });

  test('correctly parses 池田ダム row', () => {
    const rows = parseBousaiWebTable(SAMPLE_HTML);
    const ikeda = rows.find((r) => r.damName === '池田ダム');
    expect(ikeda).not.toBeUndefined();
    expect(ikeda?.observedAt?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
    expect(ikeda?.waterLevelM).toBeCloseTo(234.56);
    expect(ikeda?.inflowM3s).toBeCloseTo(12.3);
    expect(ikeda?.outflowM3s).toBeCloseTo(8.5);
    expect(ikeda?.storageVolumeM3).toBeNull();
    expect(ikeda?.storageRate).toBeNull();
  });

  test('handles "---" as null for missing values', () => {
    const rows = parseBousaiWebTable(SAMPLE_HTML);
    const seto = rows.find((r) => r.damName === '瀬戸ダム');
    expect(seto?.outflowM3s).toBeNull();
  });

  test('extracts storage columns from Fukui-style table', () => {
    const rows = parseBousaiWebTable(SAMPLE_HTML_WITH_STORAGE);
    expect(rows).toHaveLength(1);
    const ota = rows[0];
    expect(ota?.damName).toBe('太田川ダム');
    expect(ota?.storageRate).toBeCloseTo(75.3);
    expect(ota?.waterLevelM).toBeCloseTo(156.78);
    // 1234 千m³ × 1000 = 1,234,000 m³
    expect(ota?.storageVolumeM3).toBeCloseTo(1_234_000);
    expect(ota?.inflowM3s).toBeCloseTo(5.6);
    expect(ota?.outflowM3s).toBeCloseTo(3.2);
  });

  test('returns empty array for non-dam HTML', () => {
    expect(parseBousaiWebTable('<html><body>no dams</body></html>')).toHaveLength(0);
    expect(parseBousaiWebTable('')).toHaveLength(0);
  });

  test('skips rows without ダム or 貯水池 in name', () => {
    const html = `<table>
    <tr><th>局名</th><th>最新観測時刻</th><th>貯水位[m]</th></tr>
    <tr><td>水門A</td><td>2026/06/05 10:00</td><td>10.5</td></tr>
    </table>`;
    expect(parseBousaiWebTable(html)).toHaveLength(0);
  });
});
