// apps/worker/src/tasks/ingest_miyazaki_bousai.test.ts
//
// Table HTML → universe entries, no database: binding and writing belong to
// the ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Reading } from '../ingest/types.ts';
import { miyazakiEntries, parseMiyazakiTimestamp } from './ingest_miyazaki_bousai.ts';

function observation(e: Entry | undefined) {
  const r = e?.reading as Reading | undefined;
  if (r?.state !== 'values') throw new Error('no values');
  const o = r.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

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

describe('miyazakiEntries', () => {
  const iwaishi = makeRow(
    '祝子川',
    '祝子ダム',
    '延岡市',
    '',
    '2026 06/05 13:50',
    '312.01',
    '8.780',
    '7.670',
  );

  test('extracts all fields from a typical dam row', () => {
    const list = miyazakiEntries(makeHtml([iwaishi]));
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe('祝子ダム');
    expect(list[0]?.name).toBe('祝子ダム');
    expect(list[0]?.pref).toBe('45');
    const r = observation(list[0]);
    expect(r.observedAt.toISOString()).toBe('2026-06-05T04:50:00.000Z');
    expect(r.waterLevelM).toBeCloseTo(312.01);
    expect(r.inflowM3s).toBeCloseTo(8.78);
    expect(r.outflowM3s).toBeCloseTo(7.67);
    // No storage columns
    expect(r).not.toHaveProperty('storageVolumeM3');
    expect(r).not.toHaveProperty('storageRate');
  });

  test('skips header/unit rows', () => {
    expect(miyazakiEntries(makeHtml([iwaishi]))).toHaveLength(1);
  });

  test('parses multiple dams', () => {
    const html = makeHtml([
      iwaishi,
      makeRow('酒谷川', '日南ダム', '日南市', '', '2026 06/05 14:00', '107.61', '19.360', '18.990'),
    ]);
    expect(miyazakiEntries(html).map((e) => e.key)).toEqual(['祝子ダム', '日南ダム']);
  });

  test('strips trend arrows from numeric cells', () => {
    expect(observation(miyazakiEntries(makeHtml([iwaishi]))[0]).waterLevelM).toBeCloseTo(312.01);
  });

  test('returns empty array for empty HTML', () => {
    expect(miyazakiEntries('')).toHaveLength(0);
  });

  test('handles 貯水池 dam name variant, binding by the bare name', () => {
    const html = makeHtml([
      makeRow('本庄川', '綾南貯水池', '綾町', '', '2026 06/05 14:00', '337.34', '24.300', '10.010'),
    ]);
    const list = miyazakiEntries(html);
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe('綾南貯水池');
    expect(list[0]?.bind).toEqual({ name: '綾南' });
    expect(miyazakiEntries(makeHtml([iwaishi]))[0]?.bind).toBeUndefined();
  });

  test('uses single table (no header-table offset)', () => {
    // Unlike Ibaraki (2 tables), Miyazaki has 1 table — tableMatch[0] is the data table
    const html = makeHtml([
      makeRow('小丸川', '松尾ダム', '木城町', '', '2026 06/05 14:00', '196.31', '73.350', '73.210'),
    ]);
    expect(miyazakiEntries(html).map((e) => e.key)).toEqual(['松尾ダム']);
  });

  test('a dam marked in every value column is provider-marked empty', () => {
    const html = makeHtml([
      makeRow('祝子川', '祝子ダム', '延岡市', '', '2026 06/05 13:50', '***', '---', '###'),
    ]);
    expect((miyazakiEntries(html)[0]?.reading as Reading | undefined)?.state).toBe('empty');
  });

  test('an unparseable timestamp is unreadable, not dropped', () => {
    const html = makeHtml([
      makeRow('祝子川', '祝子ダム', '延岡市', '', '', '312.01', '8.780', '7.670'),
    ]);
    expect((miyazakiEntries(html)[0]?.reading as Reading | undefined)?.state).toBe('unreadable');
  });
});
