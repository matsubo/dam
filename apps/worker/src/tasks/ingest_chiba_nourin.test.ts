// Parser tests for 千葉県「県内農業用ダム貯水状況」(#29 shortlist, +10 dams).
//
// Runs against the real page saved in tests/fixtures/chiba_nourin, so the table
// markup is exercised rather than a hand-written string.

import { describe, expect, test } from 'bun:test';
import { chooseMaster, parseChibaNourinDate, parseChibaNourinHtml } from './ingest_chiba_nourin.ts';

const FIXTURE = new URL('../../../../tests/fixtures/chiba_nourin/r8_0914.html', import.meta.url)
  .pathname;

const html = await Bun.file(FIXTURE).text();
const parsed = parseChibaNourinHtml(html);

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

describe('parseChibaNourinHtml — the real page', () => {
  test('extracts the survey timestamp from the heading', () => {
    expect(parsed.reportDate?.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  test('parses all 11 dams', () => {
    expect(parsed.rows).toHaveLength(11);
    expect(parsed.published).toHaveLength(11);
  });

  test('reads 金山ダム in m³ without a unit conversion', () => {
    // This page prints m³, unlike 大分 and 九州 which print 千m³. A stray
    // conversion here would be wrong by a factor of a thousand.
    const row = parsed.rows.find((r) => r.chibaName === '金山ダム');
    expect(row?.effectiveCapacityM3).toBe(1_727_000);
    expect(row?.storageVolumeM3).toBe(1_550_000);
    expect(row?.storageRate).toBeCloseTo(0.898, 3);
  });

  test('excludes the 計 total row', () => {
    // 計 carries the same three numeric columns as a dam, so a numeric-shape
    // check would let it through and invent a 22,816,000 m³ reservoir.
    expect(parsed.published).not.toContain('計');
    expect(parsed.rows.find((r) => r.chibaName === '計')).toBeUndefined();
    for (const r of parsed.rows) expect(r.effectiveCapacityM3).toBeLessThan(22_816_000);
  });

  test('every stored row is internally consistent', () => {
    // The printed 貯水率 is 現有効貯水量 / ダム有効貯水量 — what justifies
    // trusted_rate_basis, checked per row rather than asserted wholesale.
    for (const r of parsed.rows) {
      const implied = r.storageVolumeM3 / r.effectiveCapacityM3;
      expect(Math.abs(implied - r.storageRate)).toBeLessThan(0.015);
    }
  });

  test('names the 10 dams this adds, plus the one already covered', () => {
    const names = parsed.rows.map((r) => r.chibaName).join(' ');
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
});

describe('chooseMaster', () => {
  const masters = [
    { id: 1n, name: '金山' },
    { id: 2n, name: '安房中央' },
    { id: 3n, name: '小中池' },
  ];

  test('matches the feed name minus its ダム suffix', () => {
    expect(chooseMaster('金山ダム', masters)).toBe(1n);
    expect(chooseMaster('安房中央ダム', masters)).toBe(2n);
  });

  test('matches a master that carries a 池 suffix the feed omits', () => {
    // The feed prints 小中ダム; the master holds 小中池.
    expect(chooseMaster('小中ダム', masters)).toBe(3n);
  });

  test('returns null for a dam the master does not hold', () => {
    expect(chooseMaster('存在しないダム', masters)).toBeNull();
  });
});
