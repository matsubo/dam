// apps/worker/src/tasks/ingest_fukushima_nourin.test.ts
//
// Fixture → universe entries for 福島県「県内の主要農業関係ダムの貯水状況」, no
// database: binding and writing belong to the ingest run. Fixture is a
// verbatim UTF-8 capture of the 令和8年9月1日 table.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Reading } from '../ingest/types.ts';
import { fukushimaNourinEntries, parseNourinReportDate } from './ingest_fukushima_nourin.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/fukushima_nourin/noutikannri010_2026-09-01.html',
);

const html = await readFile(FIXTURE, 'utf-8');
const entries = fukushimaNourinEntries(html);

function readingOf(list: Entry[], name: string): Reading {
  const r = list.find((e) => e.name === name)?.reading;
  if (!r || typeof r === 'function') throw new Error(`no reading for ${name}`);
  return r;
}

function rate(name: string): number | null | undefined {
  const r = readingOf(entries, name);
  return r.state === 'values' ? r.observations[0]?.storageRate : undefined;
}

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
    const page = '<div>掲載日：令和8年9月2日更新</div><h3>令和8年9月1日現在</h3>';
    expect(parseNourinReportDate(page)?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });
});

describe('fukushimaNourinEntries', () => {
  test('dates every reading by the survey heading', () => {
    const r = readingOf(entries, '岳ダム');
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations[0]?.observedAt.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('reads 貯水率 as a 0..1 fraction', () => {
    expect(rate('岳ダム')).toBeCloseTo(0.979, 6);
    expect(rate('深田調整池')).toBeCloseTo(0.75, 6);
    expect(rate('金沢調整池')).toBeCloseTo(0.724, 6);
    expect(rate('新池')).toBeCloseTo(0.784, 6);
  });

  test('lists every published dam row, unusable rate included, and no summary row', () => {
    // The universe is what 福島県 publishes, not what we could store: 鉄山 /
    // 坂下 / 鴻の巣 are on the page, so /coverage must not read them as
    // "nobody publishes this dam".
    const names = entries.map((e) => e.name);
    expect(names).toHaveLength(29);
    expect(names).toContain('鉄山ダム');
    expect(names).toContain('坂下ダム');
    expect(names).toContain('鴻の巣ダム');
    expect(names).not.toContain('県平均');
    for (const e of entries) {
      expect(e.name).toMatch(/(ダム|調整池|溜池|池|沼)$/);
      expect(e.pref).toBe('07');
    }
  });

  test('marks the rows the page itself says carry no value', () => {
    // 調査対象外 (鉄山 / 坂下) and the drained 0.0% (鴻の巣 — 工事中で落水) are
    // the page telling us there is nothing to publish — /coverage must not
    // call them our bug, and the 0.0% is never stored as a phantom zero.
    expect(readingOf(entries, '鉄山ダム').state).toBe('empty');
    expect(readingOf(entries, '坂下ダム').state).toBe('empty');
    expect(readingOf(entries, '鴻の巣ダム').state).toBe('empty');
    const values = entries.filter((e) => readingOf(entries, e.name).state === 'values');
    expect(values).toHaveLength(26);
    for (const e of values) {
      const r = rate(e.name) ?? 0;
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  test('leaves a rate cell it cannot read unreadable, not "no value"', () => {
    // An unrecognised cell may be a layout change on our side; reporting it as
    // an empty upstream row would hide that bug under 提供元に値なし.
    const broken = fukushimaNourinEntries(html.replace(/97\.9%/, '97,9 %'));
    expect(readingOf(broken, '岳ダム').state).toBe('unreadable');
  });

  test('binds the names the master spells differently', () => {
    // Feed 山ノ入ダム is master 山の入; 大深沢調整池 (雄国山麓土地改良区) is
    // master 大深沢 (東北農政局, 喜多方市), exact so it takes no longer name.
    const bind = (name: string) => entries.find((e) => e.name === name)?.bind;
    expect(bind('山ノ入ダム')).toEqual({ name: '山の入' });
    expect(bind('大深沢調整池')).toEqual({ name: '大深沢', exact: true });
    expect(bind('岳ダム')).toBeUndefined();
  });
});
