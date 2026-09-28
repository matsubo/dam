// Parser tests for あいとよネット ダム貯水率 (aitoyo.or.jp/fountainhead/dam/).
//
// Runs against the real page saved in tests/fixtures/aitoyo, fetched 2026-09-28
// 12:57 JST: 「2026年9月27日現在」 with the note 「貯水率は、当日の24時（木曽川・
// 豊川）または9時（矢作川）の値」. Prod cross-check: aitoyo's 牧尾 58,534 千m³
// of 「9月24日現在」 equals gifu-kasen's and jwa-chubu's 牧尾 at 9/24 24:00 JST,
// and 矢作 36,300 matches gifu-kasen's 9/24 09:00 JST 36,305.

import { describe, expect, test } from 'bun:test';
import { parseAitoyoHtml } from './ingest_aitoyo.ts';

const FIXTURE = new URL('../../../../tests/fixtures/aitoyo/dam_0927.html', import.meta.url)
  .pathname;

const html = await Bun.file(FIXTURE).text();
const rows = parseAitoyoHtml(html);
const byName = new Map(rows.map((r) => [r.aitoyoName, r]));

describe('parseAitoyoHtml — the real page', () => {
  test('reads all 7 dams and skips the 豊川用水全体 aggregate', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        '味噌川ダム',
        '宇連ダム',
        '岩屋ダム',
        '牧尾ダム',
        '矢作ダム',
        '羽布ダム',
        '阿木川ダム',
      ].sort(),
    );
  });

  test('stamps 木曽川・豊川 at 当日 24:00 JST, not the start of the 現在 day', () => {
    for (const name of ['牧尾ダム', '阿木川ダム', '味噌川ダム', '岩屋ダム', '宇連ダム']) {
      expect(byName.get(name)?.observedAt.toISOString()).toBe('2026-09-27T15:00:00.000Z');
    }
  });

  test('stamps 矢作川 at 当日 09:00 JST', () => {
    for (const name of ['矢作ダム', '羽布ダム']) {
      expect(byName.get(name)?.observedAt.toISOString()).toBe('2026-09-27T00:00:00.000Z');
    }
  });

  test('reads storage in 千m³ and the rate in %', () => {
    expect(byName.get('牧尾ダム')).toMatchObject({
      storageCapacityThouM3: 68_000,
      storageVolumeThouM3: 60_233,
      storageRatePct: 88.6,
    });
  });

  test('a page without its 現在 date yields no rows', () => {
    expect(parseAitoyoHtml(html.replace('2026年9月27日現在', '現在'))).toEqual([]);
  });
});
