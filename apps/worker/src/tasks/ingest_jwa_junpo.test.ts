// apps/worker/src/tasks/ingest_jwa_junpo.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Parser tests against a verbatim capture of the live page from 2026-04-21.
// The values asserted below are eyeballed against the page, so changing
// them on a parser refactor should fail loudly.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import { junpoEntries, parseJwaJunpoHtml, parseReportDate } from './ingest_jwa_junpo.ts';

const FIXTURE_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa-junpo/index_2026-04-21.html',
);
const html = await readFile(FIXTURE_PATH, 'utf8');

/** The single observation of an entry in state `values`, else null. */
function observed(e: Entry | undefined): Observed | null {
  const r = e?.reading;
  return r && typeof r !== 'function' && r.state === 'values' ? (r.observations[0] ?? null) : null;
}
const stateOf = (e: Entry | undefined) =>
  e && typeof e.reading !== 'function' ? e.reading.state : undefined;

describe('parseReportDate', () => {
  test('parses 「令和N年M月D日」 to JST midnight (= 15:00 UTC of D-1)', () => {
    const d = parseReportDate('最新の情報　令和8年4月21日（火）');
    expect(d).not.toBeNull();
    // Reiwa 8 = 2026; April 21 JST midnight = April 20 15:00 UTC.
    expect(d?.toISOString()).toBe('2026-04-20T15:00:00.000Z');
  });

  test('returns null when no Reiwa-formatted date is present', () => {
    expect(parseReportDate('something else')).toBeNull();
  });
});

describe('parseJwaJunpoHtml', () => {
  test('extracts exactly one row per listed dam (no rainfall-table duplicates)', () => {
    const { reportDate, rows } = parseJwaJunpoHtml(html);
    expect(reportDate).not.toBeNull();
    expect(rows.length).toBe(26);
    // 旬報 page also has a 「ダムの降水量等」 table that lists the same dam
    // names with rainfall numbers — a previous version of the parser walked
    // it as well and produced 52 rows with garbage capacity / volume / rate.
    const names = rows.map((r) => r.jwaName);
    expect(new Set(names).size).toBe(rows.length);
  });

  test('gets numbers right for a sample of dams', () => {
    const { rows } = parseJwaJunpoHtml(html);
    const byName = new Map(rows.map((r) => [r.jwaName, r]));
    // 矢木沢: 利水容量 115,500 / 貯水量 105,598 / 貯水率 91.4%
    expect(byName.get('矢木沢ダム')).toMatchObject({
      storageCapacityThouM3: 115500,
      storageVolumeThouM3: 105598,
      storageRatePct: 91.4,
    });
    // 早明浦: 貯水率 100% (its 確保量 row)
    expect(byName.get('早明浦ダム')?.storageRatePct).toBeCloseTo(100, 1);
    // 下久保: low storage 29.3%
    expect(byName.get('下久保ダム')?.storageRatePct).toBeCloseTo(29.3, 1);
  });

  test('skips synthesis rows (上流9ダム, 銅山川3ダム): sums over dams the table lists', () => {
    const names = parseJwaJunpoHtml(html).rows.map((r) => r.jwaName);
    expect(names).not.toContain('上流9ダム');
    expect(names).not.toContain('銅山川3ダム');
  });

  test('returns empty rows when the fixture has no storage table', () => {
    const { rows, reportDate } = parseJwaJunpoHtml(
      '<html><body><h1>令和8年4月21日</h1><p>no table here</p></body></html>',
    );
    expect(rows).toEqual([]);
    // The date header still parses even when the table is absent.
    expect(reportDate?.toISOString()).toBe('2026-04-20T15:00:00.000Z');
  });
});

describe('junpoEntries', () => {
  test('every listed dam is an entry with values, keyed by its printed name', () => {
    const entries = junpoEntries(html);
    expect(entries.map((e) => e.key)).toEqual(parseJwaJunpoHtml(html).rows.map((r) => r.jwaName));
    expect(entries.every((e) => e.key === e.name)).toBe(true);
    expect(entries.every((e) => stateOf(e) === 'values')).toBe(true);
    expect(entries.some((e) => e.bind === 'never')).toBe(false);
  });

  test('stores 千m³ as m³ and the rate as a fraction, at the report date', () => {
    const yagisawa = observed(junpoEntries(html).find((e) => e.key === '矢木沢ダム'));
    expect(yagisawa).toEqual({
      observedAt: new Date('2026-04-20T15:00:00.000Z'),
      storageVolumeM3: 105_598_000,
      storageRate: 0.914,
    });
  });

  test('scopes each dam to its prefectures; 大島 to 愛知 only', () => {
    const entries = junpoEntries(html);
    expect(entries.find((e) => e.key === '大島ダム')?.pref).toBe('23');
    expect(entries.find((e) => e.key === '下久保ダム')?.pref).toEqual(['10', '11']);
  });

  test('小石川原ダム binds as the master 小石原川', () => {
    const koishi = junpoEntries(html).find((e) => e.key === '小石川原ダム');
    expect(koishi?.bind).toEqual({ name: '小石原川' });
  });

  test('a row printing ― for 貯水量 and 貯水率 is provider-marked empty', () => {
    const marked = html.replace('>105,598<', '>―<').replace('>91.4<', '>―<');
    expect(stateOf(junpoEntries(marked).find((e) => e.key === '矢木沢ダム'))).toBe('empty');
  });

  test('a page without its 令和 date is unreadable, every dam still listed', () => {
    const undated = html.replaceAll(/令和\d+年\d+月\d+日/g, '');
    const entries = junpoEntries(undated);
    expect(entries.length).toBe(26);
    expect(entries.every((e) => stateOf(e) === 'unreadable')).toBe(true);
  });
});
