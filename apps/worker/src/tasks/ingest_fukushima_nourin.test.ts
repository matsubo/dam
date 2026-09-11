// apps/worker/src/tasks/ingest_fukushima_nourin.test.ts
//
// Pure-function tests for the 福島県「県内の主要農業関係ダムの貯水状況」
// parser. Fixture is a verbatim UTF-8 capture of the 令和8年9月1日 table.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  normalizeName,
  parseFukushimaNourinHtml,
  parseNourinReportDate,
} from './ingest_fukushima_nourin.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/fukushima_nourin/noutikannri010_2026-09-01.html',
);

const fixtureHtml = (): Promise<string> => readFile(FIXTURE, 'utf-8');

describe('parseNourinReportDate', () => {
  test('parses 「令和8年9月1日現在」 → JST midnight', () => {
    const d = parseNourinReportDate('<h3>令和8年9月1日現在</h3>');
    // JST 2026-09-01 00:00 = 2026-08-31 15:00 UTC.
    expect(d?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('returns null when no 和暦 date is present', () => {
    expect(parseNourinReportDate('<h3>貯水状況</h3>')).toBeNull();
  });

  test('takes the 「…現在」 survey date, not an earlier 掲載日 on the page', () => {
    const html = '<div>掲載日：令和8年9月2日更新</div><h3>令和8年9月1日現在</h3>';
    expect(parseNourinReportDate(html)?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });
});

describe('normalizeName', () => {
  test('folds ノ/の so 山ノ入ダム matches master 山の入', () => {
    expect(normalizeName('山ノ入ダム')).toBe(normalizeName('山の入'));
  });

  test('strips ダム suffix and （元）/（再） annotations', () => {
    expect(normalizeName('千五沢ダム')).toBe('千五沢');
    expect(normalizeName('千五沢（再）')).toBe('千五沢');
  });

  test('keeps 調整池 / 溜池 / 池 / 沼 suffixes (they are part of the name)', () => {
    expect(normalizeName('深田調整池')).toBe('深田調整池');
    expect(normalizeName('千軒平溜池')).toBe('千軒平溜池');
  });
});

describe('parseFukushimaNourinHtml', () => {
  test('reads the survey date from the heading', async () => {
    const { reportDate } = parseFukushimaNourinHtml(await fixtureHtml());
    expect(reportDate?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('extracts one row per dam with 貯水率 as a 0..1 fraction', async () => {
    const { rows } = parseFukushimaNourinHtml(await fixtureHtml());
    const byName = new Map(rows.map((r) => [r.fukushimaName, r.storageRate]));
    expect(byName.get('岳ダム')).toBeCloseTo(0.979, 6);
    expect(byName.get('深田調整池')).toBeCloseTo(0.75, 6);
    expect(byName.get('金沢調整池')).toBeCloseTo(0.724, 6);
    expect(byName.get('新池')).toBeCloseTo(0.784, 6);
  });

  test('skips 調査対象外 rows whose 貯水率 cell is prose, not a number', async () => {
    const { rows } = parseFukushimaNourinHtml(await fixtureHtml());
    const names = rows.map((r) => r.fukushimaName);
    expect(names).not.toContain('鉄山ダム');
    expect(names).not.toContain('坂下ダム');
  });

  test('skips the annotated 0.0% row (鴻の巣ダム — 工事中で落水)', async () => {
    const { rows } = parseFukushimaNourinHtml(await fixtureHtml());
    expect(rows.map((r) => r.fukushimaName)).not.toContain('鴻の巣ダム');
    for (const r of rows) expect(r.storageRate).toBeGreaterThan(0);
  });

  test('reports every published dam row, unusable rate included', async () => {
    // The universe is what 福島県 publishes, not what we could store: 鉄山 /
    // 坂下 / 鴻の巣 are on the page, so /coverage must not read them as
    // "nobody publishes this dam".
    const { published, rows } = parseFukushimaNourinHtml(await fixtureHtml());
    expect(published.length).toBe(29);
    expect(published).toContain('鉄山ダム');
    expect(published).toContain('坂下ダム');
    expect(published).toContain('鴻の巣ダム');
    expect(published).not.toContain('県平均');
    expect(rows.length).toBe(26);
  });

  test('skips the 県平均 summary row and the footnote row', async () => {
    const { rows } = parseFukushimaNourinHtml(await fixtureHtml());
    const names = rows.map((r) => r.fukushimaName);
    expect(names).not.toContain('県平均');
    expect(rows.length).toBe(26);
    for (const r of rows) {
      expect(r.fukushimaName).toMatch(/(ダム|調整池|溜池|池|沼)$/);
      expect(r.storageRate).toBeLessThanOrEqual(1);
    }
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 1n, name: '大深沢' },
    { id: 2n, name: '深田調整池' },
    { id: 3n, name: '金沢調整池' },
    { id: 4n, name: '金沢調整池副堤' },
    { id: 5n, name: '新宮川' },
    { id: 6n, name: '千五沢（再）' },
    { id: 7n, name: '千五沢（元）' },
  ];

  test('matches a feed name that carries a 調整池 suffix the master omits', () => {
    // 大深沢調整池 (雄国山麓土地改良区) is master 大深沢 — 東北農政局, 喜多方市.
    expect(chooseMaster('大深沢調整池', masters)).toBe(1n);
  });

  test('prefers the exact master name over the suffix-stripped fallback', () => {
    expect(chooseMaster('金沢調整池', masters)).toBe(3n);
    expect(chooseMaster('深田調整池', masters)).toBe(2n);
  });

  test('does not strip a single-character 池/沼 (新池 must not match 新宮川)', () => {
    expect(chooseMaster('新池', masters)).toBeNull();
    expect(chooseMaster('半田沼', masters)).toBeNull();
  });

  test('resolves a （元）/（再） pair deterministically to the lower id', () => {
    expect(chooseMaster('千五沢ダム', masters)).toBe(6n);
  });
});
