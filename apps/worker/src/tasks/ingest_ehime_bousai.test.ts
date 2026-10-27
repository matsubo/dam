// apps/worker/src/tasks/ingest_ehime_bousai.test.ts
//
// Page → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Observed, Reading } from '../ingest/types.ts';
import { fixtureUpstream } from '../ingest/upstream.ts';
import { ehimeEntries, ehimeReading, pageUrl, parseEhimeTimestamp } from './ingest_ehime_bousai.ts';

const NOW = new Date('2026-06-22T10:30:00.000Z');

function observed(r: Reading): Observed | undefined {
  if (r.state !== 'values') throw new Error(r.state);
  return r.observations[0];
}

// Sample HTML matching the actual kawabou-mng format (2 tables):
// Table 0: meta (観測所名, 水系名, ...)
// Table 1: 24-row hourly data
function makeHtml(rows: string[], damName = '鹿森ダム'): string {
  const meta = `
    <table>
      <tr><td>観測所名</td><td>${damName}</td><td>${damName}</td></tr>
      <tr><td>水系名</td><td>四国その他</td></tr>
      <tr><td>河川名</td><td>足谷川</td></tr>
      <tr><td>観測種別</td><td>ダム情報</td></tr>
      <tr><td>観測項目</td><td>時刻貯水位(m)</td><td>時刻全流入量(m3/s)</td><td>時刻全放流量(m3/s)</td><td>時刻貯水量(1000m3)</td><td>時刻貯水率(利水容量)(%)</td></tr>
    </table>`;
  const data = `<table>${rows.join('\n')}</table>`;
  return `<html><body>${meta}${data}</body></html>`;
}

function makeRow(
  ts: string,
  wl: string,
  inflow: string,
  outflow: string,
  vol: string,
  rate: string,
): string {
  return `<tr><td>${ts}</td><td>${wl}</td><td>${inflow}</td><td>${outflow}</td><td>${vol}</td><td>${rate}</td></tr>`;
}

describe('parseEhimeTimestamp', () => {
  const ctx = { year: 2026, month: 6, day: 22 };

  test('parses full date "MM/DD HH:MM" and updates context', () => {
    const { date, ctx: newCtx } = parseEhimeTimestamp('06/22 19:00', ctx);
    // 19:00 JST = 10:00 UTC
    expect(date?.toISOString()).toBe('2026-06-22T10:00:00.000Z');
    expect(newCtx.month).toBe(6);
    expect(newCtx.day).toBe(22);
  });

  test('parses time-only "HH:MM" using ctx date', () => {
    const { date } = parseEhimeTimestamp('19:00', ctx);
    expect(date?.toISOString()).toBe('2026-06-22T10:00:00.000Z');
  });

  test('handles "24:00" as midnight of the next calendar day', () => {
    const { date, ctx: newCtx } = parseEhimeTimestamp('24:00', { year: 2026, month: 6, day: 21 });
    // 24:00 JST June 21 = 00:00 JST June 22 = June 21 15:00 UTC
    expect(date?.toISOString()).toBe('2026-06-21T15:00:00.000Z');
    expect(newCtx.day).toBe(22);
  });

  test('returns null for unrecognised format', () => {
    const { date } = parseEhimeTimestamp('bad', ctx);
    expect(date).toBeNull();
  });
});

describe('ehimeReading', () => {
  test('extracts latest (last) row as the observation', () => {
    const html = makeHtml([
      makeRow('06/21 20:00', '216.69', '2.67', '2.80', '309', '35.3'),
      makeRow('21:00', '216.68', '2.66', '2.80', '308', '35.2'),
      makeRow('06/22 19:00', '216.39', '2.61', '2.78', '295', '33.7'),
    ]);
    const r = ehimeReading(html, NOW);
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]?.observedAt.toISOString()).toBe('2026-06-22T10:00:00.000Z');
    expect(r.observations[0]?.waterLevelM).toBeCloseTo(216.39);
  });

  test('scales storageVolumeM3: 千m³ × 1000', () => {
    const html = makeHtml([makeRow('06/22 19:00', '216.39', '2.61', '2.78', '295', '33.7')]);
    expect(observed(ehimeReading(html, NOW))?.storageVolumeM3).toBe(295_000);
  });

  test('scales storageRate: % ÷ 100 → fraction', () => {
    const html = makeHtml([makeRow('06/22 19:00', '216.39', '2.61', '2.78', '295', '33.7')]);
    expect(observed(ehimeReading(html, NOW))?.storageRate).toBeCloseTo(0.337);
  });

  test('returns null storageRate when column is "-"', () => {
    const html = makeHtml([makeRow('06/22 19:00', '289.35', '4.55', '6.63', '25584', '-')]);
    const o = observed(ehimeReading(html, NOW));
    expect(o?.storageRate).toBeNull();
    expect(o?.storageVolumeM3).toBe(25_584_000);
  });

  test('handles date crossing midnight via "24:00" row', () => {
    const html = makeHtml([
      makeRow('06/21 23:00', '216.66', '2.65', '2.80', '308', '35.2'),
      makeRow('24:00', '216.65', '2.66', '2.80', '307', '35.1'),
      makeRow('06/22 01:00', '216.64', '2.64', '2.80', '307', '35.1'),
    ]);
    // Latest is 06/22 01:00 → 01:00 JST = previous day 16:00 UTC
    expect(observed(ehimeReading(html, NOW))?.observedAt.toISOString()).toBe(
      '2026-06-21T16:00:00.000Z',
    );
  });

  test('time-only rows before the first full date take yesterday (JST) from now', () => {
    const html = makeHtml([makeRow('20:00', '216.69', '2.67', '2.80', '309', '35.3')]);
    // now = 06/22 19:30 JST → the window starts on 06/21.
    expect(observed(ehimeReading(html, NOW))?.observedAt.toISOString()).toBe(
      '2026-06-21T11:00:00.000Z',
    );
  });

  test('parses inflow and outflow', () => {
    const html = makeHtml([makeRow('06/22 19:00', '50.45', '0.57', '0.46', '1346', '94.1')]);
    const o = observed(ehimeReading(html, NOW));
    expect(o?.inflowM3s).toBeCloseTo(0.57);
    expect(o?.outflowM3s).toBeCloseTo(0.46);
  });

  test('handles 100% storage rate', () => {
    const html = makeHtml([makeRow('06/22 19:00', '155.85', '2.16', '2.16', '6853', '100.0')]);
    expect(observed(ehimeReading(html, NOW))?.storageRate).toBeCloseTo(1.0);
  });

  test('a latest row of "-" in every column is provider-marked empty', () => {
    const html = makeHtml([
      makeRow('06/22 18:00', '216.39', '2.61', '2.78', '295', '33.7'),
      makeRow('19:00', '-', '-', '---', '-', '-'),
    ]);
    expect(ehimeReading(html, NOW).state).toBe('empty');
  });

  test('an empty data table, or a latest row with blank cells, is unreadable', () => {
    expect(ehimeReading(makeHtml([]), NOW).state).toBe('unreadable');
    const blank = makeHtml([makeRow('06/22 19:00', '', '-', '-', '-', '-')]);
    expect(ehimeReading(blank, NOW).state).toBe('unreadable');
  });
});

describe('ehimeEntries', () => {
  test('the 12-dam catalogue, keyed by myMenuId; a failed page throws for the run', async () => {
    const page = makeHtml([makeRow('06/22 19:00', '216.39', '2.61', '2.78', '295', '33.7')]);
    const entries = ehimeEntries(
      fixtureUpstream((url) => (url === pageUrl('U1001_MMENU001') ? page : { status: 500 })),
    );
    expect(entries).toHaveLength(12);
    expect(entries.map((e) => [e.key, e.name, e.pref]).slice(8, 9)).toEqual([
      ['U1001_MMENU009', '鹿野川ダム', '38'],
    ]);
    const read = (i: number) => {
      const r = entries[i]?.reading;
      if (typeof r !== 'function') throw new Error('expected a page reading');
      return r(null);
    };
    expect((await read(0)).state).toBe('values');
    await expect(read(1)).rejects.toThrow('HTTP 500');
  });
});
