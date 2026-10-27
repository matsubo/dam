// apps/worker/src/tasks/ingest_jwa_chiba.test.ts
//
// Sample page → universe entries, no database: binding and writing belong to
// the ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { jwaChibaEntries, parseDam, parseJwaChibaTimestamp } from './ingest_jwa_chiba.ts';

describe('parseJwaChibaTimestamp', () => {
  test('parses Reiwa date → midnight JST → UTC', () => {
    const html = '<h3>令和8年6月5日（0時現在）の取水情報</h3>';
    // 令和8 = 2026; midnight JST (0h) = previous day 15:00 UTC
    const d = parseJwaChibaTimestamp(html);
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('parses year 1 (令和1 = 2019)', () => {
    const html = '令和1年1月1日（0時現在）';
    const d = parseJwaChibaTimestamp(html);
    expect(d?.getUTCFullYear()).toBe(2018);
    // 2019-01-01 00:00 JST = 2018-12-31 15:00 UTC
    expect(d?.toISOString()).toBe('2018-12-31T15:00:00.000Z');
  });

  test('returns null when no timestamp', () => {
    expect(parseJwaChibaTimestamp('<html></html>')).toBeNull();
    expect(parseJwaChibaTimestamp('')).toBeNull();
  });

  test('returns null for non-Reiwa formats', () => {
    expect(parseJwaChibaTimestamp('2026年6月5日（0時現在）')).toBeNull();
  });
});

const SAMPLE_HTML = `
<h3>
令和8年6月5日（0時現在）の取水情報
</h3>
<table>
  <TR>
    <th>長柄ダム</th>
  </TR>
  <TR>
    <td>
      <!-- ↓↓↓↓↓長柄ダムの水位を入力↓↓↓↓↓ -->
      水位　 E.L. 74.18m <BR>
      <!-- ↑↑↑↑↑長柄ダムの水位を入力↑↑↑↑↑ --><BR>
      <!-- ↓↓↓↓↓長柄ダムの貯水率を入力↓↓↓↓↓ -->
      貯水率　　92.5 %
      <!-- ↑↑↑↑↑長柄ダムの貯水率を入力↑↑↑↑↑ -->
    </td>
  </TR>
  <TR>
    <th>東金ダム</th>
  </TR>
  <TR>
    <td>
      <!-- ↓↓↓↓↓東金ダムの水位を入力↓↓↓↓↓ -->
      水位　 E.L. 42.86m <BR>
      <!-- ↑↑↑↑↑東金ダムの水位を入力↑↑↑↑↑ --><BR>
      <!-- ↓↓↓↓↓東金ダムの貯水率を入力↓↓↓↓↓ -->
      貯水率　　89.8 %
      <!-- ↑↑↑↑↑東金ダムの取水率を入力↑↑↑↑↑ -->
    </td>
  </TR>
</table>
`;

describe('parseDam', () => {
  const now = new Date('2026-06-04T15:00:00.000Z');

  test('parses 長柄ダム water level and storage rate', () => {
    const row = parseDam(SAMPLE_HTML, '長柄ダム', now);
    expect(row).not.toBeNull();
    expect(row?.htmlName).toBe('長柄ダム');
    expect(row?.waterLevelM).toBeCloseTo(74.18);
    expect(row?.storageRate).toBeCloseTo(0.925);
    expect(row?.observedAt).toBe(now);
  });

  test('parses 東金ダム water level and storage rate', () => {
    const row = parseDam(SAMPLE_HTML, '東金ダム', now);
    expect(row).not.toBeNull();
    expect(row?.waterLevelM).toBeCloseTo(42.86);
    expect(row?.storageRate).toBeCloseTo(0.898);
  });

  test('returns null for unknown dam', () => {
    const row = parseDam(SAMPLE_HTML, '存在しないダム', now);
    expect(row).toBeNull();
  });

  test('handles missing water level comment gracefully', () => {
    const htmlNoLevel = `
      令和8年6月5日（0時現在）
      <!-- ↓↓↓↓↓長柄ダムの貯水率を入力↓↓↓↓↓ -->
      貯水率　　92.5 %
      <!-- ↑↑↑↑↑長柄ダムの貯水率を入力↑↑↑↑↑ -->
    `;
    const row = parseDam(htmlNoLevel, '長柄ダム', now);
    expect(row?.waterLevelM).toBeNull();
    expect(row?.storageRate).toBeCloseTo(0.925);
  });

  test('handles missing storage rate comment gracefully', () => {
    const htmlNoRate = `
      令和8年6月5日（0時現在）
      <!-- ↓↓↓↓↓長柄ダムの水位を入力↓↓↓↓↓ -->
      水位　 E.L. 74.18m <BR>
      <!-- ↑↑↑↑↑長柄ダムの水位を入力↑↑↑↑↑ -->
    `;
    const row = parseDam(htmlNoRate, '長柄ダム', now);
    expect(row?.waterLevelM).toBeCloseTo(74.18);
    expect(row?.storageRate).toBeNull();
  });
});

describe('jwaChibaEntries', () => {
  test('lists both dams with their level and rate at 0時 JST', () => {
    const list = jwaChibaEntries({ html: SAMPLE_HTML });
    expect(list.map((e) => [e.key, e.name, e.pref, e.bind])).toEqual([
      ['長柄ダム', '長柄ダム', '12', undefined],
      ['東金ダム', '東金ダム', '12', undefined],
    ]);
    const [nagara, togane] = list.map((e) => {
      const r = e.reading;
      if (typeof r === 'function' || r.state !== 'values') throw new Error(`${e.key}: no values`);
      return r.observations[0];
    });
    // 令和8年6月5日 0時 JST = 2026-06-04T15:00:00Z
    expect(nagara?.observedAt.toISOString()).toBe('2026-06-04T15:00:00.000Z');
    expect(nagara?.waterLevelM).toBeCloseTo(74.18);
    expect(nagara?.storageRate).toBeCloseTo(0.925);
    expect(togane?.waterLevelM).toBeCloseTo(42.86);
    // the end comment says 取水率, not 貯水率: still parsed
    expect(togane?.storageRate).toBeCloseTo(0.898);
  });

  test('a dam with neither 水位 nor 貯水率 is still listed, unreadable', () => {
    const html = SAMPLE_HTML.replace('E.L. 42.86m', 'E.L. m').replace('89.8 %', ' %');
    const togane = jwaChibaEntries({ html }).find((e) => e.key === '東金ダム');
    expect(togane?.reading).toEqual({
      state: 'unreadable',
      why: 'no 水位 or 貯水率 parsed for 東金ダム',
    });
  });

  test('a page without the 0時現在 date leaves both dams unreadable', () => {
    const list = jwaChibaEntries({ html: '<table></table>' });
    expect(list).toHaveLength(2);
    for (const e of list) expect(e.reading).toMatchObject({ state: 'unreadable' });
  });

  test('a failed fetch still lists both dams, unreadable', () => {
    expect(jwaChibaEntries({ failed: 'HTTP 500' }).map((e) => e.reading)).toEqual([
      { state: 'unreadable', why: 'HTTP 500' },
      { state: 'unreadable', why: 'HTTP 500' },
    ]);
  });
});
