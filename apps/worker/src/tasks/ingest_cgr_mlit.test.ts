// apps/worker/src/tasks/ingest_cgr_mlit.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// The payload follows the dashboard's documented shape (header comment of the
// task); the live endpoint was in maintenance when this suite was written.

import { describe, expect, test } from 'bun:test';
import type { Entry, Reading } from '../ingest/types.ts';
import { type ApiResponse, cgrEntries, parseCgrTimestamp } from './ingest_cgr_mlit.ts';

function readingOf(e: Entry | undefined): Reading {
  if (!e || typeof e.reading === 'function') throw new Error('expected a static reading');
  return e.reading;
}

const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
const all = (v: string) => Object.fromEntries(ids.map((id) => [id, v]));

function payload(): ApiResponse {
  return {
    time: '2026年05月18日 14時30分',
    status: Object.fromEntries(ids.map((id) => [id, { name: `dam${id}`, param: 0 }])),
    table: {
      data: {
        ryunyu: { ...all('1.00'), '5': '12.34' },
        houryu: { ...all('2.00'), '5': '5.67' },
        chosuii: { ...all('100.0'), '5': '233.45' },
        risui: { ...all('50.0'), '5': '97.1', '2': 'ー' },
        chisui: { ...all('40.0'), '5': '39.2', '2': '61.5' },
        uryou: { ...all('0'), '5': '3' },
        ruika: all('0'),
      },
    },
  };
}

describe('parseCgrTimestamp', () => {
  test('parses "YYYY年MM月DD日 HH時MM分" JST → UTC', () => {
    expect(parseCgrTimestamp('2026年05月18日 14時30分')?.toISOString()).toBe(
      '2026-05-18T05:30:00.000Z',
    );
  });

  test('returns null on malformed input', () => {
    expect(parseCgrTimestamp('ー')).toBeNull();
  });
});

describe('cgrEntries', () => {
  test('lists the 11 configured dams under their API id and prefecture', () => {
    const entries = cgrEntries(payload());
    expect(entries.map((e) => e.key)).toEqual(ids);
    expect(entries.find((e) => e.key === '7')).toMatchObject({ name: '苫田ダム', pref: '33' });
    expect(entries.find((e) => e.key === '11')).toMatchObject({ name: '殿ダム', pref: '31' });
  });

  test('reads 利水 貯水率 over 有効 (八田原: risui 97 % vs chisui 39 %, #17)', () => {
    const r = readingOf(cgrEntries(payload()).find((e) => e.key === '5'));
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations[0]).toEqual({
      observedAt: new Date('2026-05-18T05:30:00.000Z'),
      storageRate: 0.971,
      inflowM3s: 12.34,
      outflowM3s: 5.67,
      waterLevelM: 233.45,
      rainfallMm: 3,
    });
  });

  test('falls back to 有効 貯水率 when 利水 is ー', () => {
    const r = readingOf(cgrEntries(payload()).find((e) => e.key === '2'));
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations[0]?.storageRate).toBeCloseTo(0.615, 6);
  });

  test('ー in every stored column is provider-marked empty', () => {
    const p = payload();
    const data = p.table?.data;
    if (!data) throw new Error('no data');
    for (const col of [data.ryunyu, data.houryu, data.chosuii, data.risui, data.chisui]) {
      col['3'] = 'ー';
    }
    expect(readingOf(cgrEntries(p).find((e) => e.key === '3')).state).toBe('empty');
  });

  test('a dam the dashboard adds is listed under the five prefectures', () => {
    const p = payload();
    p.status = { ...p.status, '12': { name: '新ダム', param: 0 } };
    const added = cgrEntries(p).find((e) => e.key === '12');
    expect(added?.name).toBe('新ダム');
    expect(added?.pref).toEqual(['31', '34', '35', '33', '32']);
  });

  test('a failed fetch or unparseable payload leaves all 11 unreadable, still listed', () => {
    const failures: Parameters<typeof cgrEntries>[0][] = [
      { error: 'HTTP 503' },
      { ...payload(), time: '' },
      { time: '2026年05月18日 14時30分' },
    ];
    for (const p of failures) {
      const entries = cgrEntries(p);
      expect(entries).toHaveLength(11);
      expect(entries.every((e) => readingOf(e).state === 'unreadable')).toBe(true);
    }
  });
});
