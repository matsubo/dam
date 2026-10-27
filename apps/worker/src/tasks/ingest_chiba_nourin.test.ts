// Fixture → universe entries for 千葉県「県内農業用ダム貯水状況」(#29 shortlist,
// +10 dams), no database: binding and writing belong to the ingest run.
//
// Runs against the real page saved in tests/fixtures/chiba_nourin, so the table
// markup is exercised rather than a hand-written string.

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { chibaNourinEntries, parseChibaNourinDate } from './ingest_chiba_nourin.ts';

const FIXTURE = new URL('../../../../tests/fixtures/chiba_nourin/r8_0914.html', import.meta.url)
  .pathname;

const html = await Bun.file(FIXTURE).text();
const entries = chibaNourinEntries(html);

function observed(e: Entry | undefined): Observed {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  const [o] = r.observations;
  if (!o) throw new Error('no observation');
  return o;
}

describe('parseChibaNourinDate', () => {
  test('reads 令和N年M月D日HH時現在 as JST', () => {
    // 令和8年9月14日09時現在 → 2026-09-14 09:00 JST → 00:00Z.
    expect(parseChibaNourinDate('（令和8年9月14日09時現在）')?.toISOString()).toBe(
      '2026-09-14T00:00:00.000Z',
    );
  });

  test('treats a missing hour as JST midnight', () => {
    expect(parseChibaNourinDate('令和8年9月14日現在')?.toISOString()).toBe(
      '2026-09-13T15:00:00.000Z',
    );
  });

  test('ignores 更新日 — only 現在 dates the survey', () => {
    // The page's 更新日 ran three days after the survey when this was written,
    // so taking any 令和 date would timestamp the readings wrongly.
    expect(parseChibaNourinDate('更新日：令和8(2026)年9月17日')).toBeNull();
  });
});

describe('chibaNourinEntries — the real page', () => {
  test('lists all 11 dams in 千葉, each with values at the survey timestamp', () => {
    expect(entries).toHaveLength(11);
    for (const e of entries) {
      expect(e.pref).toBe('12');
      expect(e.key).toBe(e.name);
      expect(observed(e).observedAt.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    }
  });

  test('reads 金山ダム in m³ without a unit conversion', () => {
    // This page prints m³, unlike 大分 and 九州 which print 千m³. A stray
    // conversion here would be wrong by a factor of a thousand.
    const o = observed(entries.find((e) => e.name === '金山ダム'));
    expect(o.storageVolumeM3).toBe(1_550_000);
    expect(o.storageRate).toBeCloseTo(0.898, 3);
  });

  test('excludes the 計 total row', () => {
    // 計 carries the same three numeric columns as a dam, so a numeric-shape
    // check would let it through and invent a 22,816,000 m³ reservoir.
    expect(entries.map((e) => e.name)).not.toContain('計');
    for (const e of entries) expect(observed(e).storageVolumeM3).toBeLessThan(22_816_000);
  });

  test('names the 10 dams this adds, plus the one already covered', () => {
    const names = entries.map((e) => e.name).join(' ');
    // 保台 is already live via 千葉県水政課; the other ten report
    // 「まだ観測値がありません」 today.
    for (const n of [
      '金山',
      '安房中央',
      '勝浦',
      '荒木根',
      '三島',
      '戸面原',
      '小中',
      '佐久間',
      '平沢',
      '山内',
      '保台',
    ]) {
      expect(names).toContain(n);
    }
  });

  test('a row whose rate is not 現有効貯水量 / ダム有効貯水量 is unreadable', () => {
    // The printed 貯水率 is 現有効貯水量 / ダム有効貯水量 — what justifies
    // trusted_rate_basis, checked per row rather than asserted wholesale.
    const bad = html.replace('89.8', '45.0');
    const r = chibaNourinEntries(bad).find((e) => e.name === '金山ダム')?.reading;
    expect(r && typeof r !== 'function' ? r.state : null).toBe('unreadable');
  });

  test('a page without its 現在 heading leaves every dam unreadable, still listed', () => {
    const undated = chibaNourinEntries(html.replace(/現在/g, ''));
    expect(undated).toHaveLength(11);
    for (const e of undated) {
      expect(typeof e.reading !== 'function' && e.reading.state).toBe('unreadable');
    }
  });
});
