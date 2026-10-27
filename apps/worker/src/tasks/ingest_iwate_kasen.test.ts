// apps/worker/src/tasks/ingest_iwate_kasen.test.ts
//
// Page → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { bindEntry, type Master } from '../ingest/bind.ts';
import type { Observed, Reading } from '../ingest/types.ts';
import { fixtureUpstream } from '../ingest/upstream.ts';
import {
  extractYear,
  iwateEntries,
  iwateReading,
  pageUrl,
  parseIwateTimestamp,
} from './ingest_iwate_kasen.ts';

function observed(r: Reading): Observed | undefined {
  if (r.state !== 'values') throw new Error(r.state);
  return r.observations[0];
}

// Minimal page fixture — wraps one data row in the Gamen32Servlet HTML shape.
// commonParam sets the year; ListDate gives "MM/DD HH:MM" (no year).
function makeHtml(
  dispDate: string,
  rowDate: string,
  vals: [string, string, string, string, string, string, string, string],
): string {
  const datCells = vals
    .map(
      (v, _i) =>
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

describe('iwateReading', () => {
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
    const r = observed(iwateReading(html));
    expect(r?.observedAt.toISOString()).toBe('2026-06-05T05:00:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(193.79);
    // 3242 千m³ × 1000 = 3,242,000 m³
    expect(r?.storageVolumeM3).toBe(3_242_000);
    expect(r?.inflowM3s).toBeCloseTo(0.69);
    expect(r?.outflowM3s).toBeCloseTo(0.69);
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
    const r = observed(iwateReading(html));
    expect(r?.storageVolumeM3).toBe(10_857_000);
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
    const r = observed(iwateReading(html));
    // gate=1.00, use=0.50, total=1.50
    expect(r?.outflowM3s).toBeCloseTo(1.5);
    expect(r?.inflowM3s).toBeCloseTo(2.0);
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
    const r = observed(iwateReading(html));
    expect(r?.observedAt.toISOString()).toBe('2026-06-05T05:00:00.000Z');
  });

  test('"c" (調整中) in every column is provider-marked empty', () => {
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
    expect(iwateReading(html).state).toBe('empty');
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
    const r = observed(iwateReading(html));
    // 08:00 JST = 23:00 UTC on 2026-06-04
    expect(r?.observedAt.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('a page without a ListDate cell is unreadable', () => {
    expect(iwateReading('<html></html>').state).toBe('unreadable');
  });
});

describe('iwateEntries', () => {
  test('the 10-station catalogue keyed by stationNo; a failed page throws for the run', async () => {
    const page = makeHtml('2026-06-05-14-00', '06/05&nbsp;14:00', [
      '193.79',
      '3242',
      '10745',
      '0.69',
      '0.00',
      '0.00',
      '0.69',
      '0.00',
    ]);
    const entries = iwateEntries(
      fixtureUpstream((url) => (url === pageUrl(0) ? page : { status: 500 })),
    );
    expect(entries).toHaveLength(10);
    expect([entries[0]?.key, entries[0]?.name, entries[0]?.pref]).toEqual([
      '103007003',
      '綱取ダム',
      '03',
    ]);
    const read = (i: number) => {
      const r = entries[i]?.reading;
      if (typeof r !== 'function') throw new Error('expected a page reading');
      return r(null);
    };
    expect((await read(0)).state).toBe('values');
    await expect(read(1)).rejects.toThrow(`HTTP 500 for ${pageUrl(1)}`);
  });

  // The two 岩手県 masters as the prod dams table names them (ndi 240 / 257):
  // the server's dropdown says 「遠野第二ダム」, ダム便覧 says 「遠野第2」.
  const masters: Master[] = [
    {
      id: 9262n,
      name: '遠野第2',
      prefCode: '03',
      completedYear: null,
      stamp: null,
      ndi: null,
      totalCapacityM3: null,
      activeCapacityM3: null,
    },
    {
      id: 9263n,
      name: '遠野',
      prefCode: '03',
      completedYear: null,
      stamp: null,
      ndi: null,
      totalCapacityM3: null,
      activeCapacityM3: null,
    },
  ];
  const entry = (name: string) => {
    const e = iwateEntries(fixtureUpstream({})).find((x) => x.name === name);
    if (!e) throw new Error(`no entry ${name}`);
    return e;
  };

  test('遠野第二ダム binds to 遠野第2, not the 遠野 master', () => {
    expect(bindEntry(entry('遠野第二ダム'), masters, false).dam?.id).toBe(9262n);
  });

  test('遠野ダム still binds to 遠野', () => {
    expect(bindEntry(entry('遠野ダム'), masters, false).dam?.id).toBe(9263n);
  });
});
