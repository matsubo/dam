// apps/worker/src/tasks/ingest_oita_bousai.test.ts

import { describe, expect, test } from 'bun:test';
import { type ParsedRow, parseOitaTable, parseOitaTimestamp } from './ingest_oita_bousai.ts';

// Oita table has TWO tables. The data table (index 1) has 10 columns:
// Col 0: 管理者名, Col 1: 河川名, Col 2: 局名(dam, inside <a class="site">),
// Col 3: 所在地, Col 4: 最新観測時刻 (YYYY&nbsp;MM/DD&nbsp;HH:MM JST),
// Col 5: 貯水位[m], Col 6: 流入量[m³/s], Col 7: 貯水量[千m³],
// Col 8: 貯水率[%], Col 9: 放流量[m³/s]
function makeHtml(rows: string[]): string {
  const dataRows = rows.join('\n');
  return `
    <table><tr><td>dummy header table</td></tr></table>
    <table>
      <tr>
        <th>管理者名</th><th>河川名</th><th>局名</th><th>所在地</th>
        <th>最新観測時刻</th><th>貯水位</th><th>流入量</th>
        <th>貯水量</th><th>貯水率</th><th>放流量</th>
      </tr>
      <tr>
        <td>[m]</td><td></td><td></td><td></td><td></td>
        <td>[m]</td><td>[m3/s]</td><td>[千m³]</td><td>[%]</td><td>[m3/s]</td>
      </tr>
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
  inflow: string,
  storage: string,
  rate: string,
  outflow: string,
): string {
  return `<tr>
    <td nowrap class="odd">${manager}</td>
    <td nowrap class="odd">${river}</td>
    <td nowrap class="odd"><a class="site" href="javascript:void(0)">${dam}</a></td>
    <td nowrap class="odd">${city}</td>
    <td nowrap class="odd">${ts}</td>
    <td nowrap class="odd">&rarr;&nbsp;&nbsp;${level}</td>
    <td nowrap class="odd">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${inflow}</td>
    <td nowrap class="odd">&rarr;&nbsp;&nbsp;&nbsp;${storage}</td>
    <td nowrap class="odd">&rarr;&nbsp;&nbsp;${rate}</td>
    <td nowrap class="odd">&rarr;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${outflow}</td>
  </tr>`;
}

describe('parseOitaTimestamp', () => {
  test('parses JST timestamp with &nbsp; to UTC (subtract 9h)', () => {
    const d = parseOitaTimestamp('2026 06/05 14:20');
    expect(d).not.toBeNull();
    // 14:20 JST = 05:20 UTC
    expect(d?.toISOString()).toBe('2026-06-05T05:20:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseOitaTimestamp('2026 06/05 08:00');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseOitaTimestamp('bad')).toBeNull();
    expect(parseOitaTimestamp('')).toBeNull();
  });
});

describe('parseOitaTable', () => {
  test('extracts all fields from a typical dam row', () => {
    const html = makeHtml([
      makeRow(
        '国東土木',
        '安岐川',
        '安岐ダム',
        '国東市安岐町矢川',
        '2026&nbsp;06/05&nbsp;14:20',
        '154.19',
        '2.460',
        '1004',
        '100.0',
        '3.130',
      ),
    ]);
    const rows = parseOitaTable(html);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.oitaName).toBe('安岐ダム');
    expect(r?.riverName).toBe('安岐川');
    expect(r?.observedAt?.toISOString()).toBe('2026-06-05T05:20:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(154.19);
    expect(r?.inflowM3s).toBeCloseTo(2.46);
    expect(r?.storageVolumeM3).toBe(1_004_000);
    expect(r?.storageRate).toBeCloseTo(100.0);
    expect(r?.outflowM3s).toBeCloseTo(3.13);
  });

  test('storageVolumeM3 scales 千m³ × 1000', () => {
    const html = makeHtml([
      makeRow(
        '企業局',
        '芹川',
        '芹川ダム',
        '竹田市直入町下田北',
        '2026&nbsp;06/05&nbsp;14:20',
        '327.86',
        '8.420',
        '11688',
        '52.4',
        '2.600',
      ),
    ]);
    const rows = parseOitaTable(html);
    expect(rows[0]?.storageVolumeM3).toBe(11_688_000);
    expect(rows[0]?.storageRate).toBeCloseTo(52.4);
  });

  test('inflow is column [6], outflow is column [9]', () => {
    const html = makeHtml([
      makeRow(
        '企業局',
        '北川',
        '北川ダム',
        '佐伯市宇目南田原',
        '2026&nbsp;06/05&nbsp;14:20',
        '156.59',
        '25.650',
        '25177',
        '72.6',
        '23.690',
      ),
    ]);
    const r = parseOitaTable(html)[0];
    expect(r?.inflowM3s).toBeCloseTo(25.65);
    expect(r?.outflowM3s).toBeCloseTo(23.69);
  });

  test('parses multiple dams', () => {
    const html = makeHtml([
      makeRow(
        '国東土木',
        '安岐川',
        '安岐ダム',
        '国東市',
        '2026&nbsp;06/05&nbsp;14:20',
        '154.19',
        '2.460',
        '1004',
        '100.0',
        '3.130',
      ),
      makeRow(
        '佐伯土木',
        '堅田川',
        '黒沢ダム',
        '佐伯市青山',
        '2026&nbsp;06/05&nbsp;14:20',
        '95.69',
        '2.040',
        '800',
        '100.0',
        '2.140',
      ),
    ]);
    const rows = parseOitaTable(html);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.oitaName)).toEqual(['安岐ダム', '黒沢ダム']);
  });

  test('skips header and unit rows', () => {
    const html = makeHtml([
      makeRow(
        '国東土木',
        '安岐川',
        '安岐ダム',
        '国東市',
        '2026&nbsp;06/05&nbsp;14:20',
        '154.19',
        '2.460',
        '1004',
        '100.0',
        '3.130',
      ),
    ]);
    expect(parseOitaTable(html)).toHaveLength(1);
  });

  test('strips trend arrows from numeric cells', () => {
    const html = makeHtml([
      makeRow(
        '臼杵土木',
        '垣河内川',
        '野津ダム',
        '臼杵市',
        '2026&nbsp;06/05&nbsp;14:20',
        '238.20',
        '0.280',
        '129',
        '102.4',
        '0.280',
      ),
    ]);
    expect(parseOitaTable(html)[0]?.waterLevelM).toBeCloseTo(238.2);
    expect(parseOitaTable(html)[0]?.storageRate).toBeCloseTo(102.4);
  });

  test('returns empty array for empty HTML', () => {
    expect(parseOitaTable('')).toHaveLength(0);
  });

  test('handles 貯水池 dam name variant', () => {
    const html = makeHtml([
      makeRow(
        '企業局',
        '大野川',
        '稲葉貯水池',
        '竹田市',
        '2026&nbsp;06/05&nbsp;14:20',
        '437.95',
        '2.814',
        '718',
        '104.7',
        '4.041',
      ),
    ]);
    const rows = parseOitaTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oitaName).toBe('稲葉貯水池');
  });

  test('uses second table (index 1), not first', () => {
    // The first table is a dummy header; only the second has dam data.
    const html = makeHtml([
      makeRow(
        '竹田土木',
        '玉来川',
        '玉来ダム',
        '竹田市',
        '2026&nbsp;06/05&nbsp;14:20',
        '350.55',
        '3.240',
        '2',
        '0.0',
        '3.240',
      ),
    ]);
    expect(parseOitaTable(html)).toHaveLength(1);
    expect(parseOitaTable(html)[0]?.oitaName).toBe('玉来ダム');
  });
});
