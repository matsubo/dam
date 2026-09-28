// apps/worker/src/tasks/jwa_chubu_realtime.test.ts
//
// Both fixtures are verbatim UTF-8 captures of 水資源機構 中部支社 リアルタイム情報
// overview maps, taken 2026-09-28:
//   jwa_kiso_rt/index_2026-09-28.html     木曽川水系 (index.html), 観測時刻 12時40分:
//     12 facilities — 5 dams, 打上/中里/宮川/菰野/加佐登 (調整池), 長良川河口堰,
//     木曽川大堰.
//   jwa_toyokawa/index_2_2026-09-28.html  豊川水系 (index_2.html), 観測時刻 07時10分:
//     14 facilities — 宇連/大島, 7 調整池 (有効貯水量 only, no flows), 5 頭首工
//     (貯水位 only, unit "m").

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJwaChubuRealtime, parseJwaChubuTimestamp } from './jwa_chubu_realtime.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures');
const kiso = (): Promise<string> =>
  readFile(join(FIXTURES, 'jwa_kiso_rt/index_2026-09-28.html'), 'utf8');
const toyokawa = (): Promise<string> =>
  readFile(join(FIXTURES, 'jwa_toyokawa/index_2_2026-09-28.html'), 'utf8');

describe('parseJwaChubuTimestamp', () => {
  test('JST 観測時刻 → UTC, wrapping to the previous UTC day before 09:00', () => {
    expect(parseJwaChubuTimestamp('観測時刻：2026年06月05日 10時10分')?.toISOString()).toBe(
      '2026-06-05T01:10:00.000Z',
    );
    expect(parseJwaChubuTimestamp('観測時刻：2026年06月05日 08時00分')?.toISOString()).toBe(
      '2026-06-04T23:00:00.000Z',
    );
    expect(parseJwaChubuTimestamp('no timestamp here')).toBeNull();
  });
});

describe('parseJwaChubuRealtime', () => {
  test('lists every facility on the 豊川 map, each with only its own table', async () => {
    const { observedAt, facilities } = parseJwaChubuRealtime(await toyokawa());
    expect(observedAt?.toISOString()).toBe('2026-09-27T22:10:00.000Z');
    expect(facilities).toEqual([
      {
        name: '宇連ダム',
        values: { 貯水位: 219.19, 有効貯水量: 18158, 流入量: 2.17, '放流量（利水）': 0 },
      },
      {
        name: '大島ダム',
        values: { 貯水位: 232.65, 有効貯水量: 7579, 流入量: 1.3, '放流量（利水）': 0 },
      },
      { name: '大原調整池', values: { 貯水位: 108.76, 有効貯水量: 1956 } },
      { name: '三ツ口池', values: { 貯水位: 62.27, 有効貯水量: 153 } },
      { name: '万場調整池', values: { 貯水位: 40.09, 有効貯水量: 4861 } },
      { name: '芦ヶ池調整池', values: { 貯水位: 17.03, 有効貯水量: 1925 } },
      { name: '初立池', values: { 貯水位: 19.28, 有効貯水量: 1485 } },
      { name: '駒場池', values: { 貯水位: 60.11, 有効貯水量: 721 } },
      { name: '蒲郡調整池', values: { 貯水位: 111.02, 有効貯水量: 467 } },
      { name: '大入頭首工', values: { 貯水位: 0.71 } },
      { name: '振草頭首工', values: { 貯水位: 3.4 } },
      { name: '大野頭首工', values: { 貯水位: 77.39 } },
      { name: '牟呂松原頭首工', values: { 貯水位: 18.07 } },
      { name: '寒狭川頭首工', values: { 貯水位: 82.96 } },
    ]);
  });

  test('reads the weirs on the 木曽川 map under their own labels', async () => {
    const { observedAt, facilities } = parseJwaChubuRealtime(await kiso());
    expect(observedAt?.toISOString()).toBe('2026-09-28T03:40:00.000Z');
    expect(facilities.map((f) => f.name)).toEqual([
      '牧尾ダム',
      '味噌川ダム',
      '阿木川ダム',
      '岩屋ダム',
      '徳山ダム',
      '打上調整池',
      '中里貯水池',
      '宮川調整池',
      '菰野調整池',
      '加佐登調整池',
      '長良川河口堰',
      '木曽川大堰',
    ]);
    // Not 60,877,103: the 10<sup>3</sup> of the unit is not a digit of the value.
    expect(facilities[0]?.values.有効貯水量).toBe(60877);
    expect(facilities.find((f) => f.name === '中里貯水池')?.values).toEqual({
      貯水位: 172.52,
      有効貯水量: 1801,
    });
    expect(facilities.find((f) => f.name === '長良川河口堰')?.values).toEqual({
      堰上流水位: 1.34,
      堰下流水位: -0.63,
      流入量: 193.44,
      流出量: 214.77,
    });
  });

  test('a "cc" (communication cut) or empty cell is null, not the next row', async () => {
    const html = (await kiso()).replace('>375.60<', '>cc<').replace('>392.78<', '><');
    const makio = parseJwaChubuRealtime(html).facilities[0];
    expect(makio?.values.流入量).toBeNull();
    expect(makio?.values.放流量).toBeNull();
    expect(makio?.values.貯水位).toBe(877.75);
  });
});
