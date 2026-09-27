// apps/worker/src/tasks/ingest_toyama_bousai.test.ts

import { describe, expect, test } from 'bun:test';
import { chooseMaster, parseToyamaPage, parseToyamaTimestamp } from './ingest_toyama_bousai.ts';

// Raw HTML with &#N; numeric entities as served by the Salesforce page.
// 年=&#24180; 月=&#26376; 日=&#26085; 時=&#26178; 分=&#20998; （=&#65288; ）=&#65289;
const TS_H2 =
  '<h2>&#30476;&#20869;&#12480;&#12512;&#24773;&#22577;&#23455;&#27841;&#34920;' +
  '&#65288;2026&#24180;06&#26376;05&#26085; 17&#26178;00&#20998;&#65289;</h2>';

describe('parseToyamaTimestamp', () => {
  test('parses YYYY年MM月DD日 HH時MM分 (JST) → UTC', () => {
    const d = parseToyamaTimestamp(TS_H2);
    expect(d?.toISOString()).toBe('2026-06-05T08:00:00.000Z');
  });

  test('handles midnight crossover (JST 01:00 → previous UTC day)', () => {
    const h2 = '<h2>&#65288;2026&#24180;06&#26376;05&#26085; 01&#26178;00&#20998;&#65289;</h2>';
    const d = parseToyamaTimestamp(h2);
    expect(d?.toISOString()).toBe('2026-06-04T16:00:00.000Z');
  });

  test('returns null for page without h2 timestamp', () => {
    expect(parseToyamaTimestamp('<html><body>no data</body></html>')).toBeNull();
  });
});

// Minimal sample page — 3 rows covering: full data / all-null / "--" values.
// Dam names and 水系名 are &#N;-encoded; numeric values and data-title attrs are plain.
// 室牧ダム = &#23460;&#29287;&#12480;&#12512;
// 利賀川ダム = &#21033;&#36032;&#24029;&#12480;&#12512;
// 大谷ダム = &#22823;&#35895;&#12480;&#12512;
const SAMPLE_PAGE = `${TS_H2}<table>
<tbody>
<tr>
  <td data-title="ダム名"><a href="https://example.com" target="_blank">&#23460;&#29287;&#12480;&#12512;</a></td>
  <td data-title="水系名">&#31070;&#36890;&#24029;&#27700;&#31995;</td>
  <td data-title="全流入量 (m&sup3;/s)">2.16</td>
  <td data-title="全放流量 (m&sup3;/s)">18.33</td>
  <td data-title="貯水位 (m)">
    <span class="normal">
      250.50
    </span><span class="low"> &#8595;</span>
  </td>
  <td data-title="貯水割合20％水位 (m)">--</td>
  <td data-title="貯水割合100％水位 (m)">259.0</td>
</tr>
<tr>
  <td data-title="ダム名"><a href="https://example.com" target="_blank">&#21033;&#36032;&#24029;&#12480;&#12512;</a></td>
  <td data-title="水系名">&#24481;&#27874;&#24029;&#27700;&#31995;</td>
  <td data-title="全流入量 (m&sup3;/s)">--</td>
  <td data-title="全放流量 (m&sup3;/s)">--</td>
  <td data-title="貯水位 (m)">
    <span class="normal">
      893.06
    </span><span class="up"> &#8593;</span>
  </td>
  <td data-title="貯水割合20％水位 (m)">--</td>
  <td data-title="貯水割合100％水位 (m)">--</td>
</tr>
<tr>
  <td data-title="ダム名"><a href="https://example.com" target="_blank">&#22823;&#35895;&#12480;&#12512;</a></td>
  <td data-title="水系名">&#23567;&#30000;&#24029;&#27700;&#31995;</td>
  <td data-title="全流入量 (m&sup3;/s)">0.10</td>
  <td data-title="全放流量 (m&sup3;/s)">0.09</td>
  <td data-title="貯水位 (m)">
    <span class="normal">
      143.66
    </span><span class="low"> &#8595;</span>
  </td>
  <td data-title="貯水割合20％水位 (m)">--</td>
  <td data-title="貯水割合100％水位 (m)">148.0</td>
</tr>
</tbody>
</table>`;

describe('parseToyamaPage', () => {
  test('parses 3 dam rows', () => {
    const rows = parseToyamaPage(SAMPLE_PAGE);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.toyamaName)).toEqual(['室牧ダム', '利賀川ダム', '大谷ダム']);
  });

  test('all rows share the same observedAt (2026-06-05T08:00Z)', () => {
    const rows = parseToyamaPage(SAMPLE_PAGE);
    const ts = '2026-06-05T08:00:00.000Z';
    for (const r of rows) {
      expect(r.observedAt.toISOString()).toBe(ts);
    }
  });

  test('室牧ダム: all fields parsed correctly', () => {
    const r = parseToyamaPage(SAMPLE_PAGE).find((x) => x.toyamaName === '室牧ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(250.5);
    expect(r?.inflowM3s).toBeCloseTo(2.16);
    expect(r?.outflowM3s).toBeCloseTo(18.33);
  });

  test('利賀川ダム: "--" inflow/outflow → null; water level still present', () => {
    const r = parseToyamaPage(SAMPLE_PAGE).find((x) => x.toyamaName === '利賀川ダム');
    expect(r).toBeDefined();
    expect(r?.inflowM3s).toBeNull();
    expect(r?.outflowM3s).toBeNull();
    expect(r?.waterLevelM).toBeCloseTo(893.06);
  });

  test('大谷ダム: small values parsed correctly', () => {
    const r = parseToyamaPage(SAMPLE_PAGE).find((x) => x.toyamaName === '大谷ダム');
    expect(r?.inflowM3s).toBeCloseTo(0.1);
    expect(r?.outflowM3s).toBeCloseTo(0.09);
    expect(r?.waterLevelM).toBeCloseTo(143.66);
  });

  test('returns empty array for page with no tbody', () => {
    expect(parseToyamaPage('<html><body>no data</body></html>')).toHaveLength(0);
  });

  test('returns empty array when timestamp is missing', () => {
    const noTs = '<html><body><table><tbody><tr><td>foo</td></tr></tbody></table></body></html>';
    expect(parseToyamaPage(noTs)).toHaveLength(0);
  });
});

describe('chooseMaster (#79)', () => {
  const m = (
    id: number,
    name: string,
    completedYear: number | null = null,
    stamp: string | null = null,
  ) => ({ id: BigInt(id), name, completedYear, stamp });

  test('上市川第二ダム binds 上市川第2, not the 上市川 its stem starts with', () => {
    const masters = [m(9596, '上市川', 1964), m(9595, '上市川第2', 1985)];
    expect(chooseMaster('上市川第二ダム', masters)).toBe(9595n);
    expect(chooseMaster('上市川ダム', masters)).toBe(9596n);
  });

  test('a row already stamped with the station keeps it over a better name match', () => {
    const masters = [m(10, '室牧'), m(20, '室牧発電所', null, '室牧ダム')];
    expect(chooseMaster('室牧ダム', masters)).toBe(20n);
  });

  test('a stamp on two rows is ambiguous, so the name decides', () => {
    const masters = [m(10, '室牧', null, '室牧ダム'), m(20, '室牧発電所', null, '室牧ダム')];
    expect(chooseMaster('室牧ダム', masters)).toBe(10n);
  });

  test('binds the completed （再）, not the lower-id （元）', () => {
    const masters = [m(10, '境川（元）', 1960), m(20, '境川（再）', 1993)];
    expect(chooseMaster('境川ダム', masters)).toBe(20n);
  });

  test('binds the （元） while the （再） has no completion year', () => {
    const masters = [m(10, '境川（再）'), m(20, '境川（元）', 1960)];
    expect(chooseMaster('境川ダム', masters)).toBe(20n);
  });

  test('returns null when no master name contains the stem', () => {
    expect(chooseMaster('熊野川ダム', [m(1, '上市川')])).toBeNull();
  });
});
