// apps/worker/src/tasks/ingest_miyagi_kasen.test.ts

import { describe, expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  earlierTableUrl,
  fetchEarlierRows,
  parseMiyagiDispDate,
  parseMiyagiTable,
  parseMiyagiTimestamp,
  readingsToStore,
} from './ingest_miyagi_kasen.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/miyagi_kasen');
const BASE = 'https://www.dobokusougou.pref.miyagi.jp/miyagi/servlet/Gamen42Servlet';

/** Verbatim Shift_JIS Gamen42Servlet captures, 2026-09-27 (see the describe blocks). */
async function fixtureHtml(name: string): Promise<string> {
  return new TextDecoder('shift_jis').decode(await readFile(join(FIXTURES, name)));
}

// Build a minimal Gamen42Servlet HTML fragment
function makeHtml(
  tsJst: string,
  dams: {
    stationNo: string;
    name: string;
    vals: string[];
  }[],
): string {
  const damRows = dams
    .map(({ stationNo, name, vals }) => {
      const datDivs = vals
        .map((v) => `<div class="dat2" style="color:#000000">${v}</div>`)
        .join('\n');
      return `
      <tr>
        <td class="ListDamuStnName">
          <span id=0
            onClick="chengeGamen2('Gamen41Servlet','stationNo','${stationNo}')">${name}</span>
        </td>
        <td class="ListDate">県</td>
        <td class="ListDate">\n${datDivs}\n</td>
      </tr>`;
    })
    .join('\n');

  return `<html>
  <body>
    <span>観測時刻：${tsJst}</span>
    <table id="Listblock_table">
      <tr>
        <td>ダム名</td>
        <td>貯水位(ELm)</td>
        <td>貯水量(103m3)</td>
        <td>空容量(103m3)</td>
        <td>全流入量(m3/s)</td>
        <td>全放流量(m3/s)</td>
        <td>調整流量(m3/s)</td>
        <td>流域平均雨量(mm)</td>
        <td>流域平均累加雨量(mm)</td>
        <td>貯水率(利水容量)(%)</td>
        <td>貯水率(有効容量)(%)</td>
      </tr>
      ${damRows}
    </table>
  </body>
</html>`;
}

const SAMPLE_VALS_OKURA = [
  '268.11',
  '21135',
  '3865',
  '6.94',
  '4.85',
  '-2.09',
  '0.0',
  '0.0',
  '84.5',
  '84.5',
];

describe('parseMiyagiTimestamp', () => {
  test('parses "YYYY年MM月DD日 HH時MM分" JST → UTC (subtract 9h)', () => {
    const d = parseMiyagiTimestamp('観測時刻：2026年06月05日 15時00分');
    expect(d).not.toBeNull();
    // 15:00 JST = 06:00 UTC
    expect(d?.toISOString()).toBe('2026-06-05T06:00:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseMiyagiTimestamp('観測時刻：2026年06月05日 08時00分');
    expect(d).not.toBeNull();
    // 08:00 JST = 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseMiyagiTimestamp('bad')).toBeNull();
    expect(parseMiyagiTimestamp('')).toBeNull();
    expect(parseMiyagiTimestamp('2026-06-05 15:00')).toBeNull();
  });
});

describe('parseMiyagiDispDate', () => {
  test('parses YYYY-MM-DD-HH-MM JST → UTC', () => {
    // 2026-06-06-08-00 JST = 2026-06-05T23:00:00.000Z
    const d = parseMiyagiDispDate('2026-06-06-08-00');
    expect(d?.toISOString()).toBe('2026-06-05T23:00:00.000Z');
  });

  test('returns null for non-matching input', () => {
    expect(parseMiyagiDispDate('bad')).toBeNull();
    expect(parseMiyagiDispDate('2026年06月06日 08時00分')).toBeNull();
  });
});

describe('parseMiyagiTable', () => {
  test('parses a single dam row with all 10 values', () => {
    const html = makeHtml('2026年06月05日 15時00分', [
      { stationNo: '104007011', name: '大倉ダム', vals: SAMPLE_VALS_OKURA },
    ]);
    const rows = parseMiyagiTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.miyagiName).toBe('大倉ダム');
    expect(rows[0]?.stationNo).toBe('104007011');
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-05T06:00:00.000Z');
    expect(rows[0]?.waterLevelM).toBeCloseTo(268.11);
    expect(rows[0]?.storageVolumeM3).toBeCloseTo(21135 * 1000);
    expect(rows[0]?.inflowM3s).toBeCloseTo(6.94);
    expect(rows[0]?.outflowM3s).toBeCloseTo(4.85);
    expect(rows[0]?.storageRate).toBeCloseTo(0.845);
  });

  test('storageVolumeM3 is 10^3 m^3 units converted (× 1000)', () => {
    const html = makeHtml('2026年06月05日 15時00分', [
      {
        stationNo: '104007012',
        name: '樽水ダム',
        vals: ['51.20', '1131', '3069', '0.73', '0.15', '-0.58', '0.0', '0.0', '51.4', '26.9'],
      },
    ]);
    const rows = parseMiyagiTable(html);
    expect(rows[0]?.storageVolumeM3).toBeCloseTo(1131 * 1000);
  });

  test('handles multiple dams in one response', () => {
    const html = makeHtml('2026年06月05日 15時00分', [
      { stationNo: '104007011', name: '大倉ダム', vals: SAMPLE_VALS_OKURA },
      {
        stationNo: '104007012',
        name: '樽水ダム',
        vals: ['51.20', '1131', '3069', '0.73', '0.15', '-0.58', '0.0', '0.0', '51.4', '26.9'],
      },
      {
        stationNo: '104007013',
        name: '七北田ダム',
        vals: ['239.49', '4487', '4013', '0.96', '0.96', '0.00', '0.0', '0.0', '77.4', '52.8'],
      },
    ]);
    const rows = parseMiyagiTable(html);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.miyagiName)).toEqual(['大倉ダム', '樽水ダム', '七北田ダム']);
  });

  test('dash values parsed as null', () => {
    const vals = ['268.11', '21135', '3865', '-', '-', '-2.09', '0.0', '0.0', '-', '84.5'];
    const html = makeHtml('2026年06月05日 15時00分', [
      { stationNo: '104007011', name: '大倉ダム', vals },
    ]);
    const rows = parseMiyagiTable(html);
    expect(rows[0]?.inflowM3s).toBeNull();
    expect(rows[0]?.outflowM3s).toBeNull();
    expect(rows[0]?.storageRate).toBeNull();
  });

  test('returns empty array when timestamp missing', () => {
    const html = '<html><body><table></table></body></html>';
    expect(parseMiyagiTable(html)).toHaveLength(0);
  });

  test('midnight crossover in observedAt', () => {
    const html = makeHtml('2026年06月05日 06時00分', [
      { stationNo: '104007011', name: '大倉ダム', vals: SAMPLE_VALS_OKURA },
    ]);
    const rows = parseMiyagiTable(html);
    // 06:00 JST = 2026-06-04T21:00:00Z
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-04T21:00:00.000Z');
  });

  test('skips rows with fewer than 5 dat2 values', () => {
    const html = makeHtml('2026年06月05日 15時00分', [
      { stationNo: '104007011', name: '大倉ダム', vals: ['268.11', '21135', '3865'] },
      { stationNo: '104007012', name: '樽水ダム', vals: SAMPLE_VALS_OKURA },
    ]);
    const rows = parseMiyagiTable(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.miyagiName).toBe('樽水ダム');
  });

  test('negative adjustment flow does not corrupt outflow', () => {
    const vals = ['268.11', '21135', '3865', '6.94', '4.85', '-2.09', '0.0', '0.0', '84.5', '84.5'];
    const html = makeHtml('2026年06月05日 15時00分', [
      { stationNo: '104007011', name: '大倉ダム', vals },
    ]);
    const rows = parseMiyagiTable(html);
    // outflow is vals[4]=4.85, NOT the negative vals[5]=-2.09
    expect(rows[0]?.outflowM3s).toBeCloseTo(4.85);
  });

  test('falls back to commonParam.dispDate when 観測時刻 label is empty (current site format)', () => {
    // The site now injects the date via JS into an empty div; the static HTML
    // contains only `commonParam = "dispDate:YYYY-MM-DD-HH-MM$..."`.
    const datDivs = SAMPLE_VALS_OKURA.map(
      (v) => `<div class="dat2" style="color:#000000">${v}</div>`,
    ).join('\n');
    const html = `<html>
  <script>var commonParam = "dispDate:2026-06-06-08-00$stationNo:104007011";</script>
  <div id="timeobservation">観測時刻：</div>
  <span class="nam" id=0 onClick="chengeGamen2('Gamen41Servlet','stationNo','104007011')">大倉ダム
  </span>
  ${datDivs}
</html>`;
    const rows = parseMiyagiTable(html);
    expect(rows).toHaveLength(1);
    // 2026-06-06T08:00 JST = 2026-06-05T23:00:00.000Z
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-05T23:00:00.000Z');
    expect(rows[0]?.waterLevelM).toBeCloseTo(268.11);
  });
});

describe('chooseMaster (#79)', () => {
  // 宮城 has a 花山（元）/花山（再） pair; the live table publishes 花山ダム as
  // stationNo 104007001 (Gamen42Servlet, 2026-09-27). Ids are chosen so the
  // （元） has the lower one, which the old lowest-id tie-break would pick.
  const m = (id: number, name: string, completedYear: number | null, stamp: string | null) => ({
    id: BigInt(id),
    name,
    completedYear,
    stamp,
  });

  test('binds 花山ダム to the completed （再）, not the lower-id （元）', () => {
    const masters = [m(10, '花山（元）', 1957, null), m(20, '花山（再）', 2020, null)];
    expect(chooseMaster('花山ダム', masters, '104007001')).toBe(20n);
  });

  test('keeps the row already stamped with the station', () => {
    const masters = [m(10, '花山（元）', 1957, '104007001'), m(20, '花山（再）', 2020, null)];
    expect(chooseMaster('花山ダム', masters, '104007001')).toBe(10n);
  });
});

describe('earlierTableUrl', () => {
  // dam_table_2026-09-27T2100: the latest table at 21:37 JST, dispDate 21:00.
  test('asks for the same table one hour back, keeping the other params', async () => {
    const url = earlierTableUrl(
      BASE,
      await fixtureHtml('dam_table_2026-09-27T2100.shiftjis.html'),
      1,
    );
    expect(url).toStartWith(`${BASE}?param=common=dispDate:2026-09-27-20-00$duration:60$`);
    // 全県 is encodeURI'd the way the site's own chengeForm() does it.
    expect(url).toContain('pageGroup:%E5%85%A8%E7%9C%8C$');
    expect(decodeURI(url ?? '')).toContain('$stationNo:104007011$');
  });

  test('crosses midnight in JST, not UTC', async () => {
    const url = earlierTableUrl(
      BASE,
      await fixtureHtml('dam_table_2026-09-27T2100.shiftjis.html'),
      22,
    );
    expect(url).toContain('dispDate:2026-09-26-23-00$');
  });

  test('null without a commonParam to rewrite', () => {
    expect(earlierTableUrl(BASE, '<html></html>', 1)).toBeNull();
  });
});

describe('readingsToStore', () => {
  // Two real captures of the same 現況表: T2200 fetched 22:06 JST, the minute
  // the :06 cron runs — the table has already flipped to 22:00 but only
  // 川内沢/栗駒/長沼/払川 have reported; T2100 fetched 21:37 JST, complete.
  // Prod stored those same four dams and nothing else, ever.
  const LATE = 'dam_table_2026-09-27T2200.shiftjis.html';
  const COMPLETE = 'dam_table_2026-09-27T2100.shiftjis.html';

  test('the latest table alone at :06 carries only four stations', async () => {
    const stored = readingsToStore(parseMiyagiTable(await fixtureHtml(LATE)), []);
    expect(stored.map((r) => r.miyagiName).sort()).toEqual(
      ['川内沢ダム', '栗駒ダム', '長沼ダム', '払川ダム'].sort(),
    );
  });

  test('the previous hour brings in 岩堂沢 and 二ツ石 at their own 21:00 JST', async () => {
    const stored = readingsToStore(
      parseMiyagiTable(await fixtureHtml(LATE)),
      parseMiyagiTable(await fixtureHtml(COMPLETE)),
    );
    const gandosawa = stored.find((r) => r.stationNo === '104007025');
    expect(gandosawa?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(gandosawa?.waterLevelM).toBe(406.95);
    expect(gandosawa?.storageVolumeM3).toBe(12_663_000);
    const futatsuishi = stored.find((r) => r.stationNo === '104007024');
    expect(futatsuishi?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(futatsuishi?.waterLevelM).toBe(237.68);
    // Every 県管理 station (10400700xx) reports at 21:00, not just the early four.
    const at2100 = stored.filter((r) => r.observedAt.toISOString() === '2026-09-27T12:00:00.000Z');
    expect(
      new Set(at2100.filter((r) => r.stationNo < '104007100').map((r) => r.stationNo)).size,
    ).toBe(18);
  });

  test('never repeats a (station, time) when the earlier table is not older', async () => {
    const late = parseMiyagiTable(await fixtureHtml(LATE));
    const stored = readingsToStore(late, late);
    const keys = stored.map((r) => `${r.stationNo}@${r.observedAt.toISOString()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('fetchEarlierRows', () => {
  test('a network failure yields no earlier rows instead of failing the run', async () => {
    const latest = await fixtureHtml('dam_table_2026-09-27T2200.shiftjis.html');
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    try {
      const logs: string[] = [];
      const rows = await fetchEarlierRows(latest, (s) => logs.push(s));
      expect(rows).toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(logs.join('\n')).toContain('previous-hour fetch failed');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
