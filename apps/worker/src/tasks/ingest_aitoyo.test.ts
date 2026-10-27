// Fixture → universe entries for あいとよネット ダム貯水率
// (aitoyo.or.jp/fountainhead/dam/), no database: binding and writing belong
// to the ingest run (apps/worker/src/ingest/run.test.ts).
//
// Runs against the real page saved in tests/fixtures/aitoyo, fetched 2026-09-28
// 12:57 JST: 「2026年9月27日現在」 with the note 「貯水率は、当日の24時（木曽川・
// 豊川）または9時（矢作川）の値」. Prod cross-check: aitoyo's 牧尾 58,534 千m³
// of 「9月24日現在」 equals gifu-kasen's and jwa-chubu's 牧尾 at 9/24 24:00 JST,
// and 矢作 36,300 matches gifu-kasen's 9/24 09:00 JST 36,305.

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { aitoyoEntries } from './ingest_aitoyo.ts';

const FIXTURE = new URL('../../../../tests/fixtures/aitoyo/dam_0927.html', import.meta.url)
  .pathname;

const html = await Bun.file(FIXTURE).text();
const entries = aitoyoEntries(html);
const byName = new Map(entries.map((e) => [e.key, e]));

/** The single observation of an entry in state `values`, else null. */
function observed(e: Entry | undefined): Observed | null {
  const r = e?.reading;
  return r && typeof r !== 'function' && r.state === 'values' ? (r.observations[0] ?? null) : null;
}
const stateOf = (e: Entry | undefined) =>
  e && typeof e.reading !== 'function' ? e.reading.state : undefined;

describe('aitoyoEntries — the real page', () => {
  test('lists all 7 dams and the 豊川用水全体 aggregate, which binds to no dam', () => {
    expect(entries.map((e) => [e.key, e.pref, e.bind])).toEqual([
      ['牧尾ダム', '20', undefined],
      ['阿木川ダム', '21', undefined],
      ['味噌川ダム', '20', undefined],
      ['岩屋ダム', '21', undefined],
      ['宇連ダム', '23', undefined],
      ['豊川用水全体', '23', 'never'],
      // 矢作 straddles 愛知 and 長野; both are searched.
      ['矢作ダム', ['23', '20'], undefined],
      ['羽布ダム', '23', undefined],
    ]);
    expect(entries.every((e) => stateOf(e) === 'values')).toBe(true);
  });

  test('stamps 木曽川・豊川 at 当日 24:00 JST, not the start of the 現在 day', () => {
    for (const name of ['牧尾ダム', '阿木川ダム', '味噌川ダム', '岩屋ダム', '宇連ダム']) {
      expect(observed(byName.get(name))?.observedAt.toISOString()).toBe('2026-09-27T15:00:00.000Z');
    }
  });

  test('stamps 矢作川 at 当日 09:00 JST', () => {
    for (const name of ['矢作ダム', '羽布ダム']) {
      expect(observed(byName.get(name))?.observedAt.toISOString()).toBe('2026-09-27T00:00:00.000Z');
    }
  });

  test('reads storage in 千m³ and the rate in %', () => {
    const makio = observed(byName.get('牧尾ダム'));
    expect(makio?.storageVolumeM3).toBe(60_233_000);
    expect(makio?.storageRate).toBeCloseTo(0.886, 6);
  });

  test('a page without its 現在 date records the seven dams unreadable', () => {
    const undated = aitoyoEntries(html.replace('2026年9月27日現在', '現在'));
    expect(undated.map((e) => e.key)).toEqual([
      '牧尾ダム',
      '阿木川ダム',
      '味噌川ダム',
      '岩屋ダム',
      '宇連ダム',
      '矢作ダム',
      '羽布ダム',
    ]);
    expect(undated.every((e) => stateOf(e) === 'unreadable')).toBe(true);
  });

  test('a dam the table no longer lists is recorded unreadable', () => {
    const e = aitoyoEntries(html.replace('>羽布ダム<', '>羽布<')).find((x) => x.key === '羽布ダム');
    expect(e?.reading).toEqual({ state: 'unreadable', why: 'not on the page' });
  });
});
