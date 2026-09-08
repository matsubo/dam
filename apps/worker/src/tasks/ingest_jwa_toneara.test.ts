// apps/worker/src/tasks/ingest_jwa_toneara.test.ts

import { describe, expect, test } from 'bun:test';
import { parseToneAraHtml, parseToneAraTimestamp } from './ingest_jwa_toneara.ts';

describe('parseToneAraTimestamp', () => {
  test('converts 令和8年6月2日 to 2026-06-01T15:00:00Z (JST midnight)', () => {
    const d = parseToneAraTimestamp('令和8年6月2日0時現在');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2026-06-01T15:00:00.000Z');
  });

  test('令和1年 = 2019', () => {
    const d = parseToneAraTimestamp('令和1年1月1日0時現在');
    expect(d?.toISOString()).toBe('2018-12-31T15:00:00.000Z');
  });

  test('returns null when no 令和 date present', () => {
    expect(parseToneAraTimestamp('some other text')).toBeNull();
  });
});

describe('parseToneAraHtml', () => {
  const makeTableHtml = (rows: string[][]): string => {
    const rowHtml = rows
      .map(
        ([name, cap, prev, curr, rate]: string[]) =>
          `<tr><td>${name}</td><td>${cap}</td><td>${prev}</td><td>${curr}</td><td>${rate}</td></tr>`,
      )
      .join('\n');
    return `<html><body><p>令和8年6月2日0時現在</p><table><tr><th>ダム名</th><th>利水容量</th><th>前日</th><th>現在</th><th>現在貯水率</th></tr>${rowHtml}</table></body></html>`;
  };

  test('extracts known dam rows from a well-formed table', () => {
    const html = makeTableHtml([
      ['矢木沢ダム', '11,550', '4,797', '4,397', '38'],
      ['奈良俣ダム', '8,500', '7,042', '6,885', '81'],
      ['二瀬ダム', '2,000', '705', '672', '34'],
    ]);
    const { reportDate, rows } = parseToneAraHtml(html);
    expect(reportDate?.toISOString()).toBe('2026-06-01T15:00:00.000Z');
    expect(rows).toHaveLength(3);
    const yagisawa = rows.find((r) => r.tonaraName === '矢木沢ダム');
    expect(yagisawa?.storageVolumeManM3).toBe(4397);
    expect(yagisawa?.storageRatePct).toBe(38);
  });

  test('skips header rows and 合計 rows', () => {
    const html = makeTableHtml([
      ['ダム名', '利水容量', '前日', '現在', '現在貯水率'],
      ['矢木沢ダム', '11,550', '4,797', '4,397', '38'],
      ['合計', '55,163', '30,737', '29,804', '54'],
    ]);
    const { rows } = parseToneAraHtml(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tonaraName).toBe('矢木沢ダム');
  });

  test('skips rows with fewer than 5 cells', () => {
    const html = `<html><body><p>令和8年6月2日0時現在</p><table>
      <tr><td>矢木沢ダム</td><td>11,550</td><td>4,397</td></tr>
    </table></body></html>`;
    const { rows } = parseToneAraHtml(html);
    expect(rows).toHaveLength(0);
  });

  test('deduplciates: second occurrence of same dam is ignored', () => {
    const html = makeTableHtml([
      ['矢木沢ダム', '11,550', '4,797', '4,397', '38'],
      ['矢木沢ダム', '11,550', '4,797', '4,000', '35'],
    ]);
    const { rows } = parseToneAraHtml(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.storageVolumeManM3).toBe(4397);
  });

  test('handles comma-formatted numbers', () => {
    const html = makeTableHtml([['下久保ダム', '12,000', '3,273', '3,241', '27']]);
    const { rows } = parseToneAraHtml(html);
    expect(rows[0]?.storageVolumeManM3).toBe(3241);
    expect(rows[0]?.storageRatePct).toBe(27);
  });

  test('returns empty rows when reportDate missing', () => {
    const html =
      '<table><tr><td>矢木沢ダム</td><td>11,550</td><td>4,797</td><td>4,397</td><td>38</td></tr></table>';
    const { reportDate, rows } = parseToneAraHtml(html);
    expect(reportDate).toBeNull();
    // rows are still parsed (caller decides to abort when reportDate is null)
    expect(rows).toHaveLength(1);
  });
});
