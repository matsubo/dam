// apps/worker/src/tasks/ingest_ibaraki_bousai.test.ts

import { describe, expect, test } from 'bun:test';
import { parseIbarakiTable, parseIbarakiTimestamp } from './ingest_ibaraki_bousai.ts';

// Minimal fixture builder — wraps cells in two tables (page header + data).
function makeHtml(rows: string[]): string {
  const dataRows = rows.join('\n');
  return `
    <table><tr><td>ページヘッダ</td></tr></table>
    <table>
      <tr><th>管理者</th><th>河川名</th><th>局名</th><th>所在地</th><th>最新観測時刻</th>
          <th>貯水位</th><th>貯水量</th><th>流入量</th><th>全放流量</th></tr>
      <tr><td></td><td></td><td></td><td></td><td></td>
          <td>[m]</td><td>[10³m³]</td><td>[m³/s]</td><td>[m³/s]</td></tr>
      ${dataRows}
    </table>
  `;
}

function makeRow(
  manager: string,
  river: string,
  dam: string,
  city: string,
  ts: string,
  level: string,
  storage: string,
  inflow: string,
  outflow: string,
): string {
  return `<tr>
    <td>${manager}</td>
    <td>${river}</td>
    <td>${dam}</td>
    <td>${city}</td>
    <td>${ts}</td>
    <td>&nbsp;&rarr;&nbsp;${level}</td>
    <td>&nbsp;&rarr;&nbsp;${storage}</td>
    <td>&nbsp;&rarr;&nbsp;${inflow}</td>
    <td>&nbsp;&rarr;&nbsp;${outflow}</td>
  </tr>`;
}

describe('parseIbarakiTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseIbarakiTimestamp('2026 06/05 13:40');
    expect(d).not.toBeNull();
    // 13:40 JST = 04:40 UTC
    expect(d?.toISOString()).toBe('2026-06-05T04:40:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseIbarakiTimestamp('2026 06/05 08:00');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → JS normalizes to 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('handles single-digit month', () => {
    const d = parseIbarakiTimestamp('2026 3/01 09:00');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseIbarakiTimestamp('bad')).toBeNull();
    expect(parseIbarakiTimestamp('')).toBeNull();
    expect(parseIbarakiTimestamp('20260605')).toBeNull();
  });
});

describe('parseIbarakiTable', () => {
  test('extracts all fields from a typical dam row', () => {
    const html = makeHtml([
      makeRow(
        '高萩工事事務所',
        '大北川',
        '小山ダム',
        '高萩市',
        '2026 06/05 13:40',
        '291.70',
        '1391',
        '1.360',
        '1.360',
      ),
    ]);
    const rows = parseIbarakiTable(html);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.ibarakiName).toBe('小山ダム');
    expect(r?.riverName).toBe('大北川');
    expect(r?.observedAt?.toISOString()).toBe('2026-06-05T04:40:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(291.7);
    // 1391 千m³ × 1000 = 1,391,000 m³
    expect(r?.storageVolumeM3).toBe(1_391_000);
    expect(r?.inflowM3s).toBeCloseTo(1.36);
    expect(r?.outflowM3s).toBeCloseTo(1.36);
    // No storage rate column → null
    expect(r).not.toHaveProperty('storageRate');
  });

  test('skips header and unit rows (no ダム in col 2)', () => {
    const html = makeHtml([
      makeRow(
        '高萩工事事務所',
        '大北川',
        '小山ダム',
        '高萩市',
        '2026 06/05 13:40',
        '291.70',
        '1391',
        '1.360',
        '1.360',
      ),
    ]);
    const rows = parseIbarakiTable(html);
    // Only one data row, header and unit rows must be filtered
    expect(rows).toHaveLength(1);
  });

  test('parses multiple dams', () => {
    const html = makeHtml([
      makeRow(
        '高萩工事事務所',
        '大北川',
        '小山ダム',
        '高萩市',
        '2026 06/05 13:40',
        '291.70',
        '1391',
        '1.360',
        '1.360',
      ),
      makeRow(
        '常陸太田工事事務所',
        '竜神川',
        '竜神ダム',
        '常陸太田市',
        '2026 06/05 13:40',
        '163.25',
        '33520',
        '5.200',
        '4.800',
      ),
    ]);
    const rows = parseIbarakiTable(html);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ibarakiName)).toEqual(['小山ダム', '竜神ダム']);
  });

  test('storageVolumeM3 scales 千m³ × 1000', () => {
    const html = makeHtml([
      makeRow(
        '笠間工事事務所',
        '飯田川',
        '飯田ダム',
        '笠間市',
        '2026 06/05 13:40',
        '80.50',
        '42',
        '0.080',
        '0.080',
      ),
    ]);
    const rows = parseIbarakiTable(html);
    // 42 千m³ × 1000 = 42,000 m³
    expect(rows[0]?.storageVolumeM3).toBe(42_000);
  });

  test('returns empty array for empty HTML', () => {
    expect(parseIbarakiTable('')).toHaveLength(0);
  });

  test('strips trend arrows (→↑↓) from numeric cells', () => {
    const html = makeHtml([
      makeRow(
        '高萩工事事務所',
        '大北川',
        '小山ダム',
        '高萩市',
        '2026 06/05 13:40',
        '291.70',
        '1391',
        '1.360',
        '1.360',
      ),
    ]);
    const rows = parseIbarakiTable(html);
    // Trend arrows must be stripped — values must be numeric
    expect(rows[0]?.waterLevelM).toBeCloseTo(291.7);
    expect(rows[0]?.inflowM3s).toBeCloseTo(1.36);
  });

  test('handles 貯水池 dam name variant', () => {
    const html = makeHtml([
      makeRow(
        '笠間工事事務所',
        '飯田川',
        '笠間貯水池',
        '笠間市',
        '2026 06/05 10:00',
        '40.00',
        '100',
        '0.5',
        '0.5',
      ),
    ]);
    const rows = parseIbarakiTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ibarakiName).toBe('笠間貯水池');
  });
});
