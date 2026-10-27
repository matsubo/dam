// apps/worker/src/tasks/ingest_jwa_toneara.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// The fixture is a verbatim capture (UTF-8 with BOM, CRLF) of
// water.go.jp/honsya/honsya/suigen/sokuhou/toneara/index.html taken
// 2026-10-26, 「令和8年10月26日0時現在」: two tables (利根川 9 + 9ダム合計,
// 荒川 4 + 4ダム合計), header rows in <th>.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry } from '../ingest/types.ts';
import { parseToneAraHtml, parseToneAraTimestamp, toneAraEntries } from './ingest_jwa_toneara.ts';

const html = await readFile(
  join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/jwa_toneara/index_2026-10-26.html'),
  'utf8',
);

const stateOf = (e: Entry | undefined) =>
  e && typeof e.reading !== 'function' ? e.reading.state : undefined;

const makeTableHtml = (rows: string[][]): string => {
  const rowHtml = rows
    .map(
      ([name, cap, prev, curr, rate]: string[]) =>
        `<tr><td>${name}</td><td>${cap}</td><td>${prev}</td><td>${curr}</td><td>${rate}</td></tr>`,
    )
    .join('\n');
  return `<html><body><p>令和8年6月2日0時現在</p><table><tr><th>ダム名</th><th>利水容量</th><th>前日</th><th>現在</th><th>現在貯水率</th></tr>${rowHtml}</table></body></html>`;
};

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
  test('lists the 13 facilities of both tables, no header or 合計 rows', () => {
    const { reportDate, rows } = parseToneAraHtml(html);
    expect(reportDate?.toISOString()).toBe('2026-10-25T15:00:00.000Z');
    expect(rows.map((r) => r.tonaraName)).toEqual([
      '矢木沢ダム',
      '奈良俣ダム',
      '藤原ダム',
      '相俣ダム',
      '薗原ダム',
      '八ッ場ダム',
      '下久保ダム',
      '草木ダム',
      '渡良瀬貯水池',
      '二瀬ダム',
      '滝沢ダム',
      '浦山ダム',
      '荒川貯水池',
    ]);
  });

  test('skips rows with fewer than 5 cells', () => {
    const short = `<html><body><p>令和8年6月2日0時現在</p><table>
      <tr><td>矢木沢ダム</td><td>11,550</td><td>4,397</td></tr>
    </table></body></html>`;
    expect(parseToneAraHtml(short).rows).toHaveLength(0);
  });

  test('deduplicates: second occurrence of same dam is ignored', () => {
    const { rows } = parseToneAraHtml(
      makeTableHtml([
        ['矢木沢ダム', '11,550', '4,797', '4,397', '38'],
        ['矢木沢ダム', '11,550', '4,797', '4,000', '35'],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.storageVolumeManM3).toBe(4397);
  });

  test('handles comma-formatted numbers', () => {
    const { rows } = parseToneAraHtml(
      makeTableHtml([['下久保ダム', '12,000', '3,273', '3,241', '27']]),
    );
    expect(rows[0]?.storageVolumeManM3).toBe(3241);
    expect(rows[0]?.storageRatePct).toBe(27);
  });
});

describe('toneAraEntries', () => {
  test('every facility has values: 万m³ → m³, % → fraction, at 0時 JST', () => {
    const entries = toneAraEntries(html);
    expect(entries).toHaveLength(13);
    expect(entries.every((e) => e.key === e.name && stateOf(e) === 'values')).toBe(true);
    const r = entries.find((e) => e.key === '矢木沢ダム')?.reading;
    if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    expect(r.observations).toEqual([
      {
        observedAt: new Date('2026-10-25T15:00:00.000Z'),
        storageVolumeM3: 107_680_000,
        storageRate: 0.93,
      },
    ]);
  });

  test('a multi-prefecture facility is a lookup scope, a single one its prefecture', () => {
    const entries = toneAraEntries(html);
    expect(entries.find((e) => e.key === '草木ダム')?.pref).toEqual(['09', '10']);
    expect(entries.find((e) => e.key === '二瀬ダム')?.pref).toBe('11');
  });

  test('a row printing ― for 現在貯水量 and 貯水率 is provider-marked empty', () => {
    const [entry] = toneAraEntries(makeTableHtml([['相俣ダム', '2,000', '914', '―', '―']]));
    expect(stateOf(entry)).toBe('empty');
  });

  test('a page without its 令和 date is unreadable, every facility still listed', () => {
    const undated = html.replaceAll(/令和\d+年\d+月\d+日/g, '');
    const entries = toneAraEntries(undated);
    expect(entries).toHaveLength(13);
    expect(entries.every((e) => stateOf(e) === 'unreadable')).toBe(true);
  });

  test('the two 貯水池 bind under their master names (渡良瀬遊水地（一期）, 荒川調節池)', () => {
    const entries = toneAraEntries(html);
    expect(entries.find((e) => e.key === '渡良瀬貯水池')?.bind).toEqual({ name: '渡良瀬' });
    expect(entries.find((e) => e.key === '荒川貯水池')?.bind).toEqual({ name: '荒川' });
    expect(entries.filter((e) => e.bind !== undefined)).toHaveLength(2);
  });
});
