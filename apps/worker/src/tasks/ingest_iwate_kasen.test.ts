// apps/worker/src/tasks/ingest_iwate_kasen.test.ts

import { describe, expect, test } from 'bun:test';
import {
  type ParsedRow,
  extractYear,
  parseIwatePage,
  parseIwateTimestamp,
} from './ingest_iwate_kasen.ts';

// Minimal page fixture — wraps one data row in the Gamen32Servlet HTML shape.
// commonParam sets the year; ListDate gives "MM/DD HH:MM" (no year).
function makeHtml(
  dispDate: string,
  rowDate: string,
  vals: [string, string, string, string, string, string, string, string],
): string {
  const datCells = vals
    .map(
      (v, i) =>
        `<td class="ListDamuData" style="background-color:#FFF">
           <div class="dat2"><span style="color:#000000">${v}</span></div>
           <div class="flg2">　</div>
         </td>`,
    )
    .join('\n');
  return `
    <script type="text/javascript">
      var commonParam = "dispDate:${dispDate}$duration:60$timeNumber:24$pageGroup:全域$page:1$itemPageGroup:1H$itemPage:1$stationNo:103007003$kioDispDate:null$kioPattern:1$dispEventNumber:1$station2No:0$autoType:false$riverName:null$mapClassSwich:0$freeStr:null$freeNo:1";
    </script>
    <table>
      <tr>
        <th>月/日 時:分</th>
        <th colspan="8">ダム諸量</th>
      </tr>
      <tr>
        <td class="ListDate" style="background-color:#DAEDF4">
          ${rowDate}
        </td>
        ${datCells}
        <td class="ListMizuData"><div class="dat2"><span style="color:#000000">1.23</span></div></td>
        <td class="ListRyuData"><div class="dat2"><span style="color:#000000">0.0</span></div></td>
        <td class="ListRyuData"><div class="dat2"><span style="color:#000000">0.0</span></div></td>
      </tr>
    </table>
  `;
}

describe('extractYear', () => {
  test('extracts year from dispDate in commonParam', () => {
    const html = makeHtml('2026-06-05-14-00', '06/05&nbsp;14:00', [
      '193.79',
      '3242',
      '10745',
      '0.69',
      '0.00',
      '0.00',
      '0.69',
      '0.00',
    ]);
    expect(extractYear(html)).toBe(2026);
  });

  test('falls back to current UTC year for missing commonParam', () => {
    const year = extractYear('<html></html>');
    expect(year).toBe(new Date().getUTCFullYear());
  });
});

describe('parseIwateTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseIwateTimestamp('06/05 14:00', 2026);
    expect(d).not.toBeNull();
    // 14:00 JST = 05:00 UTC
    expect(d?.toISOString()).toBe('2026-06-05T05:00:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseIwateTimestamp('06/05 08:00', 2026);
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('handles single-digit month', () => {
    const d = parseIwateTimestamp('3/01 09:00', 2026);
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseIwateTimestamp('bad', 2026)).toBeNull();
    expect(parseIwateTimestamp('', 2026)).toBeNull();
  });
});

describe('parseIwatePage', () => {
  test('extracts all fields from a typical dam row', () => {
    const html = makeHtml('2026-06-05-14-00', '06/05&nbsp;14:00', [
      '193.79',
      '3242',
      '10745',
      '0.69',
      '0.00',
      '0.00',
      '0.69',
      '0.00',
    ]);
    const r = parseIwatePage(html, '綱取ダム');
    expect(r.iwateName).toBe('綱取ダム');
    expect(r.observedAt?.toISOString()).toBe('2026-06-05T05:00:00.000Z');
    expect(r.waterLevelM).toBeCloseTo(193.79);
    // 3242 千m³ × 1000 = 3,242,000 m³
    expect(r.storageVolumeM3).toBe(3_242_000);
    expect(r.inflowM3s).toBeCloseTo(0.69);
    expect(r.outflowM3s).toBeCloseTo(0.69);
  });

  test('storageVolumeM3 scales 千m³ × 1000', () => {
    const html = makeHtml('2026-06-05-14-00', '06/05&nbsp;14:00', [
      '345.88',
      '10857',
      '3043',
      '1.29',
      '0.00',
      '3.04',
      '3.75',
      '2.46',
    ]);
    const r = parseIwatePage(html, '入畑ダム');
    expect(r.storageVolumeM3).toBe(10_857_000);
  });

  test('outflowM3s uses column [6] (全放流量), not [4] ゲート放流量', () => {
    const html = makeHtml('2026-06-05-14-00', '06/05&nbsp;14:00', [
      '300.00',
      '5000',
      '2000',
      '2.00',
      '1.00',
      '0.50',
      '1.50',
      '0.00',
    ]);
    const r = parseIwatePage(html, '早池峰ダム');
    // gate=1.00, use=0.50, total=1.50
    expect(r.outflowM3s).toBeCloseTo(1.5);
    expect(r.inflowM3s).toBeCloseTo(2.0);
  });

  test('handles &nbsp; in date cell', () => {
    const html = makeHtml('2026-06-05-14-00', '06/05&nbsp;14:00', [
      '200.00',
      '1000',
      '500',
      '0.50',
      '0.00',
      '0.00',
      '0.50',
      '0.00',
    ]);
    const r = parseIwatePage(html, '簗川ダム');
    expect(r.observedAt?.toISOString()).toBe('2026-06-05T05:00:00.000Z');
  });

  test('returns null numeric fields for "c" (under adjustment)', () => {
    const html = makeHtml('2026-06-05-14-00', '06/05&nbsp;14:00', [
      'c',
      'c',
      'c',
      'c',
      'c',
      'c',
      'c',
      'c',
    ]);
    const r = parseIwatePage(html, '遠野ダム');
    expect(r.waterLevelM).toBeNull();
    expect(r.storageVolumeM3).toBeNull();
    expect(r.inflowM3s).toBeNull();
    expect(r.outflowM3s).toBeNull();
  });

  test('midnight crossover preserves previous day', () => {
    const html = makeHtml('2026-06-05-08-00', '06/05&nbsp;08:00', [
      '193.79',
      '3242',
      '10745',
      '0.69',
      '0.00',
      '0.00',
      '0.69',
      '0.00',
    ]);
    const r = parseIwatePage(html, '綱取ダム');
    // 08:00 JST = 23:00 UTC on 2026-06-04
    expect(r.observedAt?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null observedAt when no ListDate cell', () => {
    const r = parseIwatePage('<html></html>', '綱取ダム');
    expect(r.observedAt).toBeNull();
    expect(r.waterLevelM).toBeNull();
  });
});
