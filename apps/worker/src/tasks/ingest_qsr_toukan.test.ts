// apps/worker/src/tasks/ingest_qsr_toukan.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// The fixture is a verbatim capture of qsr.mlit.go.jp/toukan/bousaijouhou.php
// taken 2026-10-27 (00:00 JST rows).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Reading } from '../ingest/types.ts';
import { parseToukantimestamp, toukanEntries, toukanReading } from './ingest_qsr_toukan.ts';

const FIXTURE = join(
  import.meta.dir,
  '../../../../tests/fixtures/qsr_toukan/bousaijouhou_2026-10-27T0000.html',
);

function readingOf(e: Entry | undefined): Reading {
  if (!e || typeof e.reading === 'function') throw new Error('expected a static reading');
  return e.reading;
}
function observed(r: Reading) {
  if (r.state !== 'values') throw new Error(`expected values, got ${r.state}`);
  const [o] = r.observations;
  if (!o) throw new Error('no observation');
  return o;
}

describe('parseToukantimestamp', () => {
  test('parses JST timestamp to UTC', () => {
    const d = parseToukantimestamp('2026/06/05 19:00');
    expect(d?.toISOString()).toBe('2026-06-05T10:00:00.000Z');
    // JST 19:00 = UTC 10:00
    expect(d?.getUTCHours()).toBe(10);
    expect(d?.getUTCDate()).toBe(5);
  });

  test('returns null for invalid', () => {
    expect(parseToukantimestamp('')).toBeNull();
    expect(parseToukantimestamp('bad timestamp')).toBeNull();
  });

  test('handles midnight JST (UTC previous day)', () => {
    const d = parseToukantimestamp('2026/06/05 00:00');
    // JST 00:00 = UTC 2026/06/04 15:00
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });
});

describe('toukanReading', () => {
  const sampleHtml = `
<table>decorative</table>
<table>
  <tr><th>観測時刻</th><th>貯水位[m]</th><th>流入量[m3/s]</th><th>ゲート放流量[m3/s]</th><th>発電使用水量[m3/s]</th><th>全放流量[m3/s]</th><th>地点雨量</th><th colspan="3">流域</th></tr>
  <tr><th>時間[mm]</th><th>累加[mm]</th><th>時間[mm]</th><th>累加[mm]</th></tr>
  <tr><td>2026/06/05 19:00</td><td>249.17</td><td>34.45</td><td>33.49</td><td>0.00</td><td>33.49</td><td>0</td><td>0</td><td>0.0</td><td>0.0</td></tr>
</table>
<table>
  <tr><th>観測時刻</th><th>貯水位[m]</th><th>流入量[m3/s]</th><th>ゲート放流量[m3/s]</th><th>発電使用水量[m3/s]</th><th>全放流量[m3/s]</th><th>地点雨量</th><th colspan="3">流域</th></tr>
  <tr><th>時間[mm]</th><th>累加[mm]</th><th>時間[mm]</th><th>累加[mm]</th></tr>
  <tr><td>2026/06/05 19:00</td><td>296.67</td><td>15.65</td><td>0.00</td><td>22.65</td><td>22.65</td><td>0</td><td>0</td><td>0.0</td><td>0.0</td></tr>
</table>
`;

  test('parses 松原ダム (table index 1)', () => {
    const o = observed(toukanReading(sampleHtml, 1));
    expect(o.waterLevelM).toBe(249.17);
    expect(o.inflowM3s).toBe(34.45);
    expect(o.outflowM3s).toBe(33.49); // 全放流量 col[5]
    expect(o.rainfallMm).toBe(0);
    expect(o.observedAt.getUTCHours()).toBe(10); // JST 19:00 → UTC 10:00
  });

  test('parses 下筌ダム (table index 2)', () => {
    const o = observed(toukanReading(sampleHtml, 2));
    expect(o.waterLevelM).toBe(296.67);
    expect(o.inflowM3s).toBe(15.65);
    expect(o.outflowM3s).toBe(22.65); // 全放流量 = gate + power
    expect(o.rainfallMm).toBe(0);
  });

  test('a table index out of range is unreadable', () => {
    expect(toukanReading(sampleHtml, 5).state).toBe('unreadable');
  });

  test('a data row with blank cells is unreadable', () => {
    const emptyTable = `
<table>decorative</table>
<table>
  <tr><th>観測時刻</th></tr>
  <tr></tr>
  <tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>
</table>
`;
    expect(toukanReading(emptyTable, 1).state).toBe('unreadable');
  });

  test('欠測 in every stored column is provider-marked empty', () => {
    const html = `
<table>decorative</table>
<table>
  <tr><th>観測時刻</th></tr>
  <tr><th>h</th></tr>
  <tr><td>2026/06/05 05:00</td><td>欠測</td><td>欠測</td><td>欠測</td><td>欠測</td><td>欠測</td><td>0</td></tr>
</table>
`;
    expect(toukanReading(html, 1).state).toBe('empty');
  });

  test('handles rain column with decimal values', () => {
    const html = `
<table>decorative</table>
<table>
  <tr><th>観測時刻</th><th>貯水位[m]</th><th>流入量[m3/s]</th><th>ゲート</th><th>発電</th><th>全放流量[m3/s]</th><th>地点</th></tr>
  <tr><th>h</th><th>acc</th><th>h2</th><th>acc2</th></tr>
  <tr><td>2026/06/05 05:00</td><td>250.00</td><td>100.50</td><td>80.00</td><td>10.00</td><td>90.00</td><td>5.5</td></tr>
</table>
`;
    const o = observed(toukanReading(html, 1));
    expect(o.waterLevelM).toBe(250.0);
    expect(o.inflowM3s).toBe(100.5);
    expect(o.outflowM3s).toBe(90.0);
    expect(o.rainfallMm).toBe(5.5);
  });
});

describe('toukanEntries', () => {
  test('lists 松原 and 下筌 by page name in 大分, read from the live page', async () => {
    const entries = toukanEntries({ html: await readFile(FIXTURE, 'utf8') });
    expect(entries.map((e) => [e.key, e.pref])).toEqual([
      ['松原ダム', '44'],
      ['下筌ダム', '44'],
    ]);
    expect(observed(readingOf(entries[0])).waterLevelM).toBe(261.74);
    expect(observed(readingOf(entries[1])).waterLevelM).toBe(322.91);
  });

  test('a failed fetch leaves both unreadable, still listed', () => {
    const entries = toukanEntries({ error: 'HTTP 503' });
    expect(entries.map((e) => readingOf(e))).toEqual([
      { state: 'unreadable', why: 'HTTP 503' },
      { state: 'unreadable', why: 'HTTP 503' },
    ]);
  });
});
