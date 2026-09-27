// apps/worker/src/tasks/ingest_miyagi_kasen.test.ts

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  parseMiyagiDispDate,
  parseMiyagiTable,
  parseMiyagiTimestamp,
} from './ingest_miyagi_kasen.ts';

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

  test('keeps a station whose row is short but reads none of its cells', () => {
    const html = makeHtml('2026年06月05日 15時00分', [
      { stationNo: '104007011', name: '大倉ダム', vals: ['268.11', '21135', '3865'] },
      { stationNo: '104007012', name: '樽水ダム', vals: SAMPLE_VALS_OKURA },
    ]);
    const rows = parseMiyagiTable(html);
    expect(rows.map((r) => r.stationNo)).toEqual(['104007011', '104007012']);
    expect(rows[0]?.waterLevelM).toBeNull();
    expect(rows[0]?.storageVolumeM3).toBeNull();
    expect(rows[1]?.waterLevelM).toBeCloseTo(268.11);
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

// Verbatim Shift_JIS capture of Gamen42Servlet (ダム現況表, 全県) taken
// 2026-09-27 21:40 JST, trimmed to the commonParam script and the table.
describe('parseMiyagiTable on the live ダム現況表', () => {
  const fixture = async (): Promise<string> =>
    new TextDecoder('shift_jis').decode(
      await readFile(
        join(
          import.meta.dir,
          '..',
          '..',
          '..',
          '..',
          'tests/fixtures/miyagi_kasen/Gamen42Servlet_2026-09-27.shiftjis.html',
        ),
      ),
    );

  test('lists all 21 stations, the three 国 dams included', async () => {
    const rows = parseMiyagiTable(await fixture());
    expect(rows).toHaveLength(21);
    expect(rows.slice(-3).map((r) => [r.stationNo, r.miyagiName])).toEqual([
      ['104007201', '鳴子ダム'],
      ['104007202', '釜房ダム'],
      ['104007203', '七ヶ宿ダム'],
    ]);
    for (const r of rows) expect(r.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  test('reads the 国 rows, whose value <div>s are never closed', async () => {
    const naruko = parseMiyagiTable(await fixture()).find((r) => r.stationNo === '104007201');
    expect(naruko?.waterLevelM).toBe(240.25);
    expect(naruko?.storageVolumeM3).toBe(9_988_000);
    expect(naruko?.inflowM3s).toBe(10.18);
    expect(naruko?.outflowM3s).toBe(10.01);
    expect(naruko?.storageRate).toBeCloseTo(0.624, 6);
  });

  test('reads 二ツ石 and leaves 長沼 (level only) without volume or flow', async () => {
    const rows = parseMiyagiTable(await fixture());
    const futatsuishi = rows.find((r) => r.stationNo === '104007024');
    expect(futatsuishi?.waterLevelM).toBe(237.68);
    expect(futatsuishi?.storageVolumeM3).toBe(9_003_000);
    expect(futatsuishi?.storageRate).toBeCloseTo(0.928, 6);
    const naganuma = rows.find((r) => r.stationNo === '104007006');
    expect(naganuma?.waterLevelM).toBe(8.91);
    expect(naganuma?.storageVolumeM3).toBeNull();
    expect(naganuma?.inflowM3s).toBeNull();
    expect(naganuma?.storageRate).toBeNull();
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
