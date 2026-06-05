// apps/worker/src/tasks/ingest_akita_kasen.test.ts

import { describe, expect, test } from 'bun:test';
import { type ParsedRow, parseAkitaTable, parseAkitaTimestamp } from './ingest_akita_kasen.ts';

// Akita table has ONE table with 12 columns per data row:
// Col 0: 管轄, Col 1: 河川名, Col 2: 局名(dam),
// Col 3: 所在地, Col 4: 最新観測時刻 ("YYYY/MM/DD HH:MM" JST),
// Col 5: 貯水位[EL.m], Col 6: 流入量[m³/s], Col 7: 放流量[m³/s],
// Col 8-11: 水位・雨量 (not stored)
function makeHtml(rows: string[]): string {
  const dataRows = rows.join('\n');
  return `
    <table id="tablestatus" class="data">
      <tr>
        <th rowspan="2">管轄</th><th rowspan="2">河川名</th><th rowspan="2">局名</th>
        <th rowspan="2">所在地</th><th rowspan="2">最新観測時刻</th>
        <th rowspan="2">貯水位[EL.m]</th><th rowspan="2">流入量[m3/s]</th>
        <th rowspan="2">放流量[m3/s]</th>
        <th colspan="2">河川水位</th><th colspan="2">雨量</th>
      </tr>
      <tr>
        <th>上流水位[m]</th><th>下流水位[m]</th>
        <th>時間[mm]</th><th>累加[mm]</th>
      </tr>
      ${dataRows}
    </table>
  `;
}

function makeRow(
  area: string,
  river: string,
  dam: string,
  city: string,
  ts: string,
  level: string,
  inflow: string,
  outflow: string,
  extra = '<td class="odd">&nbsp;</td><td class="odd">0.37</td><td class="odd">---</td><td class="odd">0.0</td>',
): string {
  return `<tr>
    <td nowrap class="odd">${area}</td>
    <td nowrap class="odd">${river}</td>
    <td nowrap class="odd"><A class="site" href="javascript:void(0)" onClick="">${dam}</A></td>
    <td nowrap class="odd">${city}</td>
    <td nowrap class="odd">${ts}</td>
    <td nowrap class="odd" style="text-align:right">${level}</td>
    <td nowrap class="odd" style="text-align:right">${inflow}</td>
    <td nowrap class="odd" style="text-align:right">${outflow}</td>
    ${extra}
  </tr>`;
}

describe('parseAkitaTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM" JST → UTC (subtract 9h)', () => {
    const d = parseAkitaTimestamp('2026/06/05 15:00');
    expect(d).not.toBeNull();
    // 15:00 JST = 06:00 UTC
    expect(d?.toISOString()).toBe('2026-06-05T06:00:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseAkitaTimestamp('2026/06/05 08:00');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseAkitaTimestamp('bad')).toBeNull();
    expect(parseAkitaTimestamp('')).toBeNull();
    expect(parseAkitaTimestamp('2026/06/05')).toBeNull();
  });
});

describe('parseAkitaTable', () => {
  test('extracts all fields from a typical dam row', () => {
    const html = makeHtml([
      makeRow(
        '鹿角',
        '小坂川',
        '砂子沢ダム',
        '小坂町小坂',
        '2026/06/05&nbsp;15:00',
        '316.79',
        '0.47',
        '0.51',
      ),
    ]);
    const rows = parseAkitaTable(html);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.akitaName).toBe('砂子沢ダム');
    expect(r?.riverName).toBe('小坂川');
    expect(r?.observedAt?.toISOString()).toBe('2026-06-05T06:00:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(316.79);
    expect(r?.inflowM3s).toBeCloseTo(0.47);
    expect(r?.outflowM3s).toBeCloseTo(0.51);
  });

  test('&nbsp; between date and time is cleaned before timestamp parse', () => {
    const html = makeHtml([
      makeRow(
        '北秋田',
        '小阿仁川',
        '萩形ダム',
        '上小阿仁村南沢',
        '2026/06/05&nbsp;14:50',
        '208.78',
        '2.44',
        '2.03',
      ),
    ]);
    const rows = parseAkitaTable(html);
    expect(rows[0]?.observedAt?.toISOString()).toBe('2026-06-05T05:50:00.000Z');
  });

  test('strips trend arrows from numeric cells', () => {
    const html = makeHtml([
      makeRow(
        '秋田',
        '旭川',
        '旭川ダム',
        '秋田市',
        '2026/06/05&nbsp;15:00',
        '&rarr;&nbsp;245.12',
        '&rarr;&nbsp;5.20',
        '&rarr;&nbsp;4.80',
      ),
    ]);
    const rows = parseAkitaTable(html);
    expect(rows[0]?.waterLevelM).toBeCloseTo(245.12);
    expect(rows[0]?.inflowM3s).toBeCloseTo(5.2);
    expect(rows[0]?.outflowM3s).toBeCloseTo(4.8);
  });

  test('skips header and unit rows (fewer than 8 cells or no dam name)', () => {
    const html = makeHtml([
      makeRow(
        '鹿角',
        '小坂川',
        '砂子沢ダム',
        '小坂町小坂',
        '2026/06/05&nbsp;15:00',
        '316.79',
        '0.47',
        '0.51',
      ),
    ]);
    expect(parseAkitaTable(html)).toHaveLength(1);
  });

  test('skips non-dam rows (防潮水門 has no ダム/貯水池 in name)', () => {
    const html = makeHtml([
      makeRow(
        '秋田',
        '八郎湖',
        '八郎潟防潮水門',
        '大潟村',
        '2026/06/05&nbsp;15:00',
        '0.12',
        '---',
        '---',
      ),
      makeRow(
        '鹿角',
        '小坂川',
        '砂子沢ダム',
        '小坂町',
        '2026/06/05&nbsp;15:00',
        '316.79',
        '0.47',
        '0.51',
      ),
    ]);
    const rows = parseAkitaTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.akitaName).toBe('砂子沢ダム');
  });

  test('parses multiple dams', () => {
    const html = makeHtml([
      makeRow(
        '鹿角',
        '小坂川',
        '砂子沢ダム',
        '小坂町',
        '2026/06/05&nbsp;15:00',
        '316.79',
        '0.47',
        '0.51',
      ),
      makeRow(
        '北秋田',
        '小阿仁川',
        '萩形ダム',
        '上小阿仁村',
        '2026/06/05&nbsp;14:50',
        '208.78',
        '2.44',
        '2.03',
      ),
      makeRow(
        '北秋田',
        '小又川',
        '森吉ダム',
        '北秋田市',
        '2026/06/05&nbsp;14:50',
        '347.46',
        '4.32',
        '6.94',
      ),
    ]);
    const rows = parseAkitaTable(html);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.akitaName)).toEqual(['砂子沢ダム', '萩形ダム', '森吉ダム']);
  });

  test('handles 貯水池 dam name variant', () => {
    const html = makeHtml([
      makeRow(
        '企業局',
        '大仙川',
        '大仙貯水池',
        '大仙市',
        '2026/06/05&nbsp;15:00',
        '156.00',
        '1.00',
        '1.00',
      ),
    ]);
    const rows = parseAkitaTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.akitaName).toBe('大仙貯水池');
  });

  test('storageVolumeM3 and storageRate are always null', () => {
    const html = makeHtml([
      makeRow(
        '鹿角',
        '小坂川',
        '砂子沢ダム',
        '小坂町',
        '2026/06/05&nbsp;15:00',
        '316.79',
        '0.47',
        '0.51',
      ),
    ]);
    const rows = parseAkitaTable(html);
    // ParsedRow does not include storage fields — confirmed by interface
    expect((rows[0] as ParsedRow & { storageVolumeM3?: unknown }).storageVolumeM3).toBeUndefined();
  });

  test('returns empty array for empty HTML', () => {
    expect(parseAkitaTable('')).toHaveLength(0);
  });

  test('midnight crossover: JST 00:00 → UTC previous day 15:00', () => {
    const html = makeHtml([
      makeRow(
        '仙北',
        '玉川',
        '玉川ダム',
        '仙北市',
        '2026/06/05&nbsp;00:00',
        '482.10',
        '3.50',
        '3.50',
      ),
    ]);
    const rows = parseAkitaTable(html);
    // 00:00 JST = -9h UTC → 2026-06-04T15:00:00Z
    expect(rows[0]?.observedAt?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });
});
