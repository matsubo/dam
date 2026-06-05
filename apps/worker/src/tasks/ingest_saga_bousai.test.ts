import { describe, expect, test } from 'bun:test';
import { parseSagaPage, parseSagaTimestamp } from './ingest_saga_bousai.ts';

describe('parseSagaTimestamp', () => {
  test('parses "MM/DD HH:MM" (JST) with year → UTC', () => {
    const d = parseSagaTimestamp('06/05 21:00', 2026);
    expect(d?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('handles midnight crossover (JST 00:00 → previous UTC day)', () => {
    const d = parseSagaTimestamp('06/05 00:00', 2026);
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseSagaTimestamp('', 2026)).toBeNull();
    expect(parseSagaTimestamp('bad', 2026)).toBeNull();
    expect(parseSagaTimestamp('2026/06/05 21:00', 2026)).toBeNull();
  });
});

// Minimal transposed table HTML matching the Saga format (2 dams)
const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="SHIFT_JIS"></head>
<body>
<div>2026年06月05日21時00分 現在</div>
<table>
<tr><td>局名</td><td>岸川ダム</td><td>伊岐佐ダム</td></tr>
<tr><td>放流設備</td><td></td><td></td></tr>
<tr><td>観測時刻</td><td>06/05 21:00</td><td>06/05 21:00</td></tr>
<tr><td>サーチャージ水位　EL　[m]</td><td>216.50</td><td>271.50</td></tr>
<tr><td>常時満水位　EL　[m]</td><td>197.00</td><td>250.50</td></tr>
<tr><td>貯水位　EL [m]</td><td>198.05</td><td>250.13</td></tr>
<tr><td>全流入量　[m3/s]</td><td>5.250</td><td>0.266</td></tr>
<tr><td>全放流量　[m3/s]</td><td>5.250</td><td>0.228</td></tr>
<tr><td>貯水量　[1000m3]</td><td></td><td>114</td></tr>
<tr><td>貯水率　[%]</td><td></td><td>88.40</td></tr>
</table>
</body></html>
`;

// Page with no dams (edge case)
const EMPTY_HTML = '<html><body>2026年 <table></table></body></html>';

describe('parseSagaPage', () => {
  test('parses 2 dam rows from transposed table', () => {
    const rows = parseSagaPage(SAMPLE_HTML);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sagaName)).toEqual(['岸川ダム', '伊岐佐ダム']);
  });

  test('observedAt converted from JST to UTC', () => {
    const rows = parseSagaPage(SAMPLE_HTML);
    for (const r of rows) {
      expect(r.observedAt?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
    }
  });

  test('岸川ダム: water level and flows present, no storage volume/rate', () => {
    const r = parseSagaPage(SAMPLE_HTML).find((x) => x.sagaName === '岸川ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(198.05);
    expect(r?.inflowM3s).toBeCloseTo(5.25);
    expect(r?.outflowM3s).toBeCloseTo(5.25);
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.storageRate).toBeNull();
  });

  test('伊岐佐ダム: storageVolumeM3 × 1000 and storageRate ÷ 100', () => {
    const r = parseSagaPage(SAMPLE_HTML).find((x) => x.sagaName === '伊岐佐ダム');
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBeCloseTo(114_000);
    expect(r?.storageRate).toBeCloseTo(0.884);
    expect(r?.waterLevelM).toBeCloseTo(250.13);
  });

  test('returns empty array for empty table', () => {
    expect(parseSagaPage(EMPTY_HTML)).toHaveLength(0);
  });
});
