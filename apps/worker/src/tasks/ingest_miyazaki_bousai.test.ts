// apps/worker/src/tasks/ingest_miyazaki_bousai.test.ts

import { describe, expect, test } from 'bun:test';
import { parseMiyazakiTable, parseMiyazakiTimestamp } from './ingest_miyazaki_bousai.ts';

// Miyazaki table has ONE table (not two like Ibaraki): 8 columns.
// Col 0: 河川名, Col 1: 局名(dam), Col 2: 所在地, Col 3: 状態,
// Col 4: 最新観測時刻, Col 5: 貯水位[m], Col 6: 流入量[m³/s], Col 7: 全放流量[m³/s]
function makeHtml(rows: string[]): string {
  const dataRows = rows.join('\n');
  return `
    <table>
      <tr><th>河川名</th><th>局名</th><th>所在地</th><th>状態</th><th>最新観測時刻</th>
          <th>貯水位</th><th>流入量</th><th>全放流量</th></tr>
      <tr><td></td><td></td><td></td><td></td><td></td>
          <td>[m]</td><td>[m3/s]</td><td>[m3/s]</td></tr>
      ${dataRows}
    </table>
  `;
}

function makeRow(
  river: string,
  dam: string,
  city: string,
  status: string,
  ts: string,
  level: string,
  inflow: string,
  outflow: string,
): string {
  return `<tr>
    <td>${river}</td>
    <td>${dam}</td>
    <td>${city}</td>
    <td>${status}</td>
    <td>${ts}</td>
    <td>&nbsp;&rarr;&nbsp;${level}</td>
    <td>&nbsp;&rarr;&nbsp;${inflow}</td>
    <td>&nbsp;&rarr;&nbsp;${outflow}</td>
  </tr>`;
}

describe('parseMiyazakiTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseMiyazakiTimestamp('2026 06/05 13:50');
    expect(d).not.toBeNull();
    // 13:50 JST = 04:50 UTC
    expect(d?.toISOString()).toBe('2026-06-05T04:50:00.000Z');
  });

  test('handles midnight crossover', () => {
    const d = parseMiyazakiTimestamp('2026 06/05 08:00');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseMiyazakiTimestamp('bad')).toBeNull();
    expect(parseMiyazakiTimestamp('')).toBeNull();
  });
});

describe('parseMiyazakiTable', () => {
  test('extracts all fields from a typical dam row', () => {
    const html = makeHtml([
      makeRow('祝子川', '祝子ダム', '延岡市', '', '2026 06/05 13:50', '312.01', '8.780', '7.670'),
    ]);
    const rows = parseMiyazakiTable(html);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.miyazakiName).toBe('祝子ダム');
    expect(r?.riverName).toBe('祝子川');
    expect(r?.observedAt?.toISOString()).toBe('2026-06-05T04:50:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(312.01);
    expect(r?.inflowM3s).toBeCloseTo(8.78);
    expect(r?.outflowM3s).toBeCloseTo(7.67);
    // No storage columns
    expect(r).not.toHaveProperty('storageVolumeM3');
    expect(r).not.toHaveProperty('storageRate');
  });

  test('skips header/unit rows', () => {
    const html = makeHtml([
      makeRow('祝子川', '祝子ダム', '延岡市', '', '2026 06/05 13:50', '312.01', '8.780', '7.670'),
    ]);
    expect(parseMiyazakiTable(html)).toHaveLength(1);
  });

  test('parses multiple dams', () => {
    const html = makeHtml([
      makeRow('祝子川', '祝子ダム', '延岡市', '', '2026 06/05 13:50', '312.01', '8.780', '7.670'),
      makeRow('酒谷川', '日南ダム', '日南市', '', '2026 06/05 14:00', '107.61', '19.360', '18.990'),
    ]);
    const rows = parseMiyazakiTable(html);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.miyazakiName)).toEqual(['祝子ダム', '日南ダム']);
  });

  test('strips trend arrows from numeric cells', () => {
    const html = makeHtml([
      makeRow('祝子川', '祝子ダム', '延岡市', '', '2026 06/05 13:50', '312.01', '8.780', '7.670'),
    ]);
    expect(parseMiyazakiTable(html)[0]?.waterLevelM).toBeCloseTo(312.01);
  });

  test('returns empty array for empty HTML', () => {
    expect(parseMiyazakiTable('')).toHaveLength(0);
  });

  test('handles 貯水池 dam name variant', () => {
    const html = makeHtml([
      makeRow('本庄川', '綾南貯水池', '綾町', '', '2026 06/05 14:00', '337.34', '24.300', '10.010'),
    ]);
    const rows = parseMiyazakiTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.miyazakiName).toBe('綾南貯水池');
  });

  test('uses single table (no header-table offset)', () => {
    // Unlike Ibaraki (2 tables), Miyazaki has 1 table — tableMatch[0] is the data table
    const html = makeHtml([
      makeRow('小丸川', '松尾ダム', '木城町', '', '2026 06/05 14:00', '196.31', '73.350', '73.210'),
    ]);
    const rows = parseMiyazakiTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.miyazakiName).toBe('松尾ダム');
  });
});
