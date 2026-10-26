// apps/worker/src/tasks/ingest_nagasaki_city_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 長崎市上下水道局「長崎市ダム貯水量一覧表」
// (city.nagasaki.lg.jp/page/53407.html) taken 2026-09-28, showing the
// 令和8年8月24日現在 table (更新日 2026-08-25). The page's keywords meta still
// carries an older 「令和6年11月4日現在」 title.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nagasakiCityEntries, parseNagasakiDamList } from './ingest_nagasaki_city_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/nagasaki_city_suido/53407_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');
const page = parseNagasakiDamList(html);

describe('parseNagasakiDamList', () => {
  test('dates the table from the body 現在 line at 00:00 JST, not the stale keywords meta', () => {
    expect(page.observedAt?.toISOString()).toBe('2026-08-23T15:00:00.000Z');
  });

  test('lists every dam row, including the idle one, and no 計/小計/合計 rows', () => {
    expect(page.rows.map((r) => r.name)).toEqual([
      '浦上',
      '落矢',
      '本河内高部',
      '本河内低部',
      '西山',
      '雪浦',
      '神浦',
      '式見',
      '鳴見',
      '萱瀬',
      '小ケ倉',
      '鹿尾',
      '中尾',
    ]);
  });

  test('reads 水道有効量, 貯水量 and 貯水率 (as a fraction) for 浦上', () => {
    expect(page.rows[0]).toEqual({
      name: '浦上',
      capacityM3: 1_900_000,
      storageVolumeM3: 1_812_000,
      storageRate: 0.953,
      suspended: false,
    });
  });

  test('reads values wrapped in <p> the same as bare cells', () => {
    expect(page.rows.find((r) => r.name === '本河内高部')).toEqual({
      name: '本河内高部',
      capacityM3: 386_000,
      storageVolumeM3: 297_000,
      storageRate: 0.769,
      suspended: false,
    });
    expect(page.rows.find((r) => r.name === '本河内低部')?.storageRate).toBe(1);
  });

  test('marks the 休止中 dam suspended, with no readings', () => {
    expect(page.rows.find((r) => r.name === '落矢')).toEqual({
      name: '落矢',
      capacityM3: null,
      storageVolumeM3: null,
      storageRate: null,
      suspended: true,
    });
  });

  test('returns no date when the 現在 line is gone', () => {
    const undated = html.replace(/令和8年8月24日現在/g, '');
    expect(parseNagasakiDamList(undated).observedAt).toBeNull();
  });
});

describe('nagasakiCityEntries', () => {
  const observedAt = page.observedAt;
  if (!observedAt) throw new Error('no date');
  const entries = nagasakiCityEntries(observedAt, page.rows);
  const by = (key: string) => entries.find((e) => e.key === key);

  test('pins 浦上 to the in-service （元） and 小ケ倉 to the 長崎市 dam, not the 諌早市 namesake', () => {
    expect(by('浦上')?.bind).toEqual({ ndi: '2602' });
    expect(by('小ケ倉')?.bind).toEqual({ ndi: '2609' });
    expect(by('西山')?.bind).toEqual({ exact: true });
  });

  test('writes 浦上 only; the other twelve are recorded', () => {
    expect(entries).toHaveLength(13);
    expect(entries.filter((e) => !e.dontWrite).map((e) => e.key)).toEqual(['浦上']);
    expect(by('浦上')?.reading).toEqual({
      state: 'values',
      observations: [{ observedAt, storageVolumeM3: 1_812_000, storageRate: 0.953 }],
    });
  });

  test('落矢 休止中 is provider-marked empty', () => {
    expect(by('落矢')?.reading).toEqual({ state: 'empty', mark: '休止中' });
  });

  test('浦上 off the 水道有効量 its pin assumes is recorded, not written', () => {
    const moved = page.rows.map((r) => (r.name === '浦上' ? { ...r, capacityM3: 1_200_000 } : r));
    const [urakami] = nagasakiCityEntries(observedAt, moved);
    expect(urakami?.dontWrite).toContain('re-check NDI_PINS');
    expect(urakami?.reading).toMatchObject({ state: 'values' });
  });
});
