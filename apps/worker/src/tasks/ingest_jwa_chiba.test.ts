import { describe, expect, test } from 'bun:test';
import { parseDam, parseJwaChibaHtml, parseJwaChibaTimestamp } from './ingest_jwa_chiba.ts';

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
    expect(row?.storageRate).toBeCloseTo(92.5);
    expect(row?.observedAt).toBe(now);
  });

  test('parses 東金ダム water level and storage rate', () => {
    const row = parseDam(SAMPLE_HTML, '東金ダム', now);
    expect(row).not.toBeNull();
    expect(row?.waterLevelM).toBeCloseTo(42.86);
    expect(row?.storageRate).toBeCloseTo(89.8);
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
    expect(row?.storageRate).toBeCloseTo(92.5);
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

describe('parseJwaChibaHtml', () => {
  test('returns rows for both dams', () => {
    const rows = parseJwaChibaHtml(SAMPLE_HTML);
    expect(rows).toHaveLength(2);
    const nagara = rows.find((r) => r.htmlName === '長柄ダム');
    const togane = rows.find((r) => r.htmlName === '東金ダム');
    expect(nagara?.waterLevelM).toBeCloseTo(74.18);
    expect(nagara?.storageRate).toBeCloseTo(92.5);
    expect(togane?.waterLevelM).toBeCloseTo(42.86);
    expect(togane?.storageRate).toBeCloseTo(89.8);
  });

  test('returns correct UTC timestamp', () => {
    const rows = parseJwaChibaHtml(SAMPLE_HTML);
    // 令和8年6月5日 0時 JST = 2026-06-04T15:00:00Z
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns empty array when no timestamp', () => {
    const rows = parseJwaChibaHtml('<table></table>');
    expect(rows).toHaveLength(0);
  });

  test('the "取水率" typo in end-comment still works for 東金ダム storage rate', () => {
    const rows = parseJwaChibaHtml(SAMPLE_HTML);
    const togane = rows.find((r) => r.htmlName === '東金ダム');
    // Should parse correctly despite the end comment saying 取水率
    expect(togane?.storageRate).toBeCloseTo(89.8);
  });
});
