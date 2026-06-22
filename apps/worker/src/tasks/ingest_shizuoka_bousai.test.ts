import { describe, expect, test } from 'bun:test';
import {
  detectColumns,
  parseBousaiTimestamp,
  parseBousaiWebTable,
  parseSiposJson,
  parseSiposTimestamp,
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

// --- SIPOS (静岡県土木総合防災情報) tests ------------------------------------

describe('parseSiposTimestamp', () => {
  test('parses YYYYMMDDHHmm JST → UTC', () => {
    const d = parseSiposTimestamp('202606221930');
    // 19:30 JST = 10:30 UTC
    expect(d?.toISOString()).toBe('2026-06-22T10:30:00.000Z');
  });

  test('handles midnight crossover (00:xx JST → previous UTC day)', () => {
    const d = parseSiposTimestamp('202606220800');
    // 08:00 JST = -1:00 UTC → previous day 23:00
    expect(d?.toISOString()).toBe('2026-06-21T23:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseSiposTimestamp('bad')).toBeNull();
    expect(parseSiposTimestamp('2026060')).toBeNull();
    expect(parseSiposTimestamp('')).toBeNull();
  });
});

describe('parseSiposJson', () => {
  const MASTER = {
    '2201200': '奥野ダム',
    '2201201': '太田川ダム',
    '8567001': '長島ダム（国）',
  };

  function makeEntry(overrides: Record<string, number> = {}) {
    return {
      lwtrlv: 13787, // ÷100 → 137.87m
      data_storagerate: 986, // ÷1000 → 0.986
      stwvol: 1558, // ×1000 → 1,558,000m³
      wflvol_in: 66, // ÷100 → 0.66m³/s
      wflvol_out: 349, // ÷100 → 3.49m³/s
      ...overrides,
    };
  }

  test('scales lwtrlv / 100 → waterLevelM', () => {
    const data = { '2201200': { dam: [makeEntry({ lwtrlv: 13787 })] } };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    expect(readings[0]?.waterLevelM).toBeCloseTo(137.87);
  });

  test('scales data_storagerate / 1000 → storageRate fraction', () => {
    const data = { '2201200': { dam: [makeEntry({ data_storagerate: 986 })] } };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    expect(readings[0]?.storageRate).toBeCloseTo(0.986);
  });

  test('scales stwvol * 1000 → storageVolumeM3', () => {
    const data = { '2201200': { dam: [makeEntry({ stwvol: 1558 })] } };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    expect(readings[0]?.storageVolumeM3).toBe(1_558_000);
  });

  test('scales wflvol_in and wflvol_out / 100 → m³/s', () => {
    const data = { '2201200': { dam: [makeEntry({ wflvol_in: 66, wflvol_out: 349 })] } };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    expect(readings[0]?.inflowM3s).toBeCloseTo(0.66);
    expect(readings[0]?.outflowM3s).toBeCloseTo(3.49);
  });

  test('returns null for no-data sentinel (-1111111111)', () => {
    const data = { '2201200': { dam: [makeEntry({ lwtrlv: -1111111111, stwvol: -1111111111 })] } };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    expect(readings[0]?.waterLevelM).toBeNull();
    expect(readings[0]?.storageVolumeM3).toBeNull();
  });

  test('returns null for not-available sentinel (-999999999)', () => {
    const data = { '2201200': { dam: [makeEntry({ data_storagerate: -999999999 })] } };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    expect(readings[0]?.storageRate).toBeNull();
  });

  test('uses master names for pointName', () => {
    const data = {
      '2201200': { dam: [makeEntry()] },
      '8567001': { dam: [makeEntry({ lwtrlv: 45000 })] },
    };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    const okuno = readings.find((r) => r.pointCode === '2201200');
    const nagashima = readings.find((r) => r.pointCode === '8567001');
    expect(okuno?.pointName).toBe('奥野ダム');
    expect(nagashima?.pointName).toBe('長島ダム（国）');
  });

  test('sets observedAt from timestamp', () => {
    const data = { '2201200': { dam: [makeEntry()] } };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    expect(readings[0]?.observedAt?.toISOString()).toBe('2026-06-22T10:30:00.000Z');
  });

  test('skips missing point codes', () => {
    const data = { '2201200': { dam: [makeEntry()] } };
    const readings = parseSiposJson(data, MASTER, '202606221930');
    // Only 1 of 6 point codes has data
    expect(readings).toHaveLength(1);
    expect(readings[0]?.pointCode).toBe('2201200');
  });
});
