// apps/worker/src/tasks/ingest_tndam_hyogo.test.ts

import { describe, expect, test } from 'bun:test';
import { extractDataMap, parseTndamPage, parseTndamTimestamp } from './ingest_tndam_hyogo.ts';

// Sample page HTML matching the real tndam.pref.hyogo.lg.jp format.
function makeHtml(
  values: {
    waterLevel?: string;
    storageVol?: string;
    storageRate?: string;
    inflow?: string;
    overflow?: string;
    outflow?: string;
    rainfall?: string;
  },
  timestamp = '更新時刻：2026/06/22 20:00:55',
): string {
  const row = (label: string, value: string) =>
    `<tr>
      <td align="left" bgcolor="#aaffaa"><b>${label}</b></td>
      <td align="right" bgcolor="#aaffaa"><b>${value}<b>　</td>
    </tr>`;

  return `<html><body>
    <table>
      <tr><td bgcolor="#6666ff"><font><b>鍔市ダム　テレメータデータ</b></font></td></tr>
    </table>
    <table>
      ${row('貯水位(m)', values.waterLevel ?? '287.65')}
      ${row('貯水量(m<SUP>3</SUP>)', values.storageVol ?? '521250')}
      ${row('貯水率(%)', values.storageRate ?? '48.7')}
      ${row('流入量(m<SUP>3</SUP>/s)', values.inflow ?? '0.034')}
      ${row('越流量(m<SUP>3</SUP>/s)', values.overflow ?? '0.0000')}
      ${row('放流量(m<SUP>3</SUP>/s)', values.outflow ?? '0.0333')}
      ${row('時間雨量(mm)', values.rainfall ?? '0.0')}
    </table>
    <td colspan="2" bgcolor="#cccccc" align="center"><font color="#3333ff">${timestamp}</font></td>
  </body></html>`;
}

const OFFLINE_HTML = makeHtml(
  { waterLevel: '', storageVol: '', storageRate: '', inflow: '', outflow: '', rainfall: '' },
  '更新時刻：0000/00/00 00:00:00',
);

describe('parseTndamTimestamp', () => {
  test('parses JST timestamp → UTC', () => {
    const html = makeHtml({});
    // 20:00 JST = 11:00 UTC
    expect(parseTndamTimestamp(html)?.toISOString()).toBe('2026-06-22T11:00:00.000Z');
  });

  test('returns null for "0000/00/00 00:00:00" (offline)', () => {
    expect(parseTndamTimestamp(OFFLINE_HTML)).toBeNull();
  });

  test('handles midnight JST (00:00 → previous day 15:00 UTC)', () => {
    const html = makeHtml({}, '更新時刻：2026/06/22 00:00:55');
    // 00:00 JST = -9h UTC = June 21 15:00 UTC
    expect(parseTndamTimestamp(html)?.toISOString()).toBe('2026-06-21T15:00:00.000Z');
  });

  test('returns null when no timestamp pattern found', () => {
    expect(parseTndamTimestamp('<html>no timestamp</html>')).toBeNull();
  });
});

describe('extractDataMap', () => {
  test('extracts label-value pairs from aaffaa cells', () => {
    const html = makeHtml({ waterLevel: '287.65', storageVol: '521250' });
    const map = extractDataMap(html);
    expect(map.get('貯水位(m)')).toBe('287.65');
    expect(map.get('貯水量(m3)')).toBe('521250');
  });

  test('strips HTML tags from labels (SUP → plain text)', () => {
    const html = makeHtml({});
    const map = extractDataMap(html);
    // m<SUP>3</SUP> → m3
    expect(map.has('貯水量(m3)')).toBe(true);
    expect(map.has('流入量(m3/s)')).toBe(true);
    expect(map.has('放流量(m3/s)')).toBe(true);
  });

  test('returns empty map for HTML with no aaffaa cells', () => {
    const map = extractDataMap('<html><body>nothing</body></html>');
    expect(map.size).toBe(0);
  });
});

describe('parseTndamPage', () => {
  test('returns null for offline dam (0000/00/00 timestamp)', () => {
    const r = parseTndamPage(OFFLINE_HTML, 2, '八幡谷ダム');
    expect(r).toBeNull();
  });

  test('parses waterLevelM correctly', () => {
    const html = makeHtml({ waterLevel: '287.65' });
    const r = parseTndamPage(html, 1, '鍔市ダム');
    expect(r?.waterLevelM).toBeCloseTo(287.65);
  });

  test('storageVolumeM3 is direct m³ (no ×1000 conversion)', () => {
    const html = makeHtml({ storageVol: '521250' });
    const r = parseTndamPage(html, 1, '鍔市ダム');
    // 521250 is already m³
    expect(r?.storageVolumeM3).toBe(521250);
  });

  test('storageRate: % ÷ 100 → fraction', () => {
    const html = makeHtml({ storageRate: '48.7' });
    const r = parseTndamPage(html, 1, '鍔市ダム');
    expect(r?.storageRate).toBeCloseTo(0.487);
  });

  test('storageRate: 100% → 1.0', () => {
    const html = makeHtml({ storageRate: '100.0' });
    const r = parseTndamPage(html, 5, '黒石ダム');
    expect(r?.storageRate).toBeCloseTo(1.0);
  });

  test('inflowM3s and outflowM3s parse correctly', () => {
    const html = makeHtml({ inflow: '0.034', outflow: '0.0333' });
    const r = parseTndamPage(html, 1, '鍔市ダム');
    expect(r?.inflowM3s).toBeCloseTo(0.034);
    expect(r?.outflowM3s).toBeCloseTo(0.0333);
  });

  test('越流量 (spillway) is ignored — does not appear in reading', () => {
    const html = makeHtml({ overflow: '99.9' });
    const r = parseTndamPage(html, 1, '鍔市ダム');
    // The reading has no spillway field; overflow should not affect other fields
    expect(r?.outflowM3s).toBeCloseTo(0.0333); // still 放流量
  });

  test('rainfallMm parses correctly', () => {
    const html = makeHtml({ rainfall: '12.5' });
    const r = parseTndamPage(html, 1, '鍔市ダム');
    expect(r?.rainfallMm).toBeCloseTo(12.5);
  });

  test('observedAt converts JST to UTC', () => {
    const html = makeHtml({}, '更新時刻：2026/06/22 20:00:55');
    const r = parseTndamPage(html, 1, '鍔市ダム');
    expect(r?.observedAt?.toISOString()).toBe('2026-06-22T11:00:00.000Z');
  });

  test('sets psno and damName', () => {
    const html = makeHtml({});
    const r = parseTndamPage(html, 3, '藤岡ダム');
    expect(r?.psno).toBe(3);
    expect(r?.damName).toBe('藤岡ダム');
  });

  test('returns null when all data fields are absent', () => {
    const html = makeHtml({ waterLevel: '', storageVol: '', storageRate: '' });
    const r = parseTndamPage(html, 1, '鍔市ダム');
    expect(r).toBeNull();
  });
});
