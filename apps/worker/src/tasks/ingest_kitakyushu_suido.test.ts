// apps/worker/src/tasks/ingest_kitakyushu_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 北九州市上下水道局「北九州市の水源状況」
// (city.kitakyushu.lg.jp/suidou/s00900011.html) taken 2026-09-27, showing the
// 2026年9月25日 午前9時 table (the page is refreshed on weekdays only).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kitakyushuEntries, parseKitakyushuSuigen } from './ingest_kitakyushu_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kitakyushu_suido/suigen_2026-09-27.html',
);

const html = await readFile(FIXTURE, 'utf8');

describe('parseKitakyushuSuigen', () => {
  test('lists every facility of the table and none of the 合計 / 平年値 rows', () => {
    const { rows } = parseKitakyushuSuigen(html);
    expect(rows.map((r) => r.name)).toEqual([
      '油木貯水池',
      'ます渕貯水池',
      '耶馬渓貯水池',
      '力丸貯水池',
      '頓田貯水池',
      '畑貯水池',
      '白木貯水池',
      '道原貯水池',
      '松ヶ江貯水池',
      '遠賀川河口堰',
    ]);
  });

  test('reads the caption 「2026年9月25日 午前9時現在」 as JST', () => {
    expect(parseKitakyushuSuigen(html).observedAt?.toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  test('stores level in m, 万m³ volume as m³ and the rate as a fraction', () => {
    const matsugae = parseKitakyushuSuigen(html).rows.find((r) => r.name === '松ヶ江貯水池');
    expect(matsugae?.waterLevelM).toBe(61.47);
    expect(matsugae?.storageVolumeM3).toBe(520_000);
    expect(matsugae?.storageRate).toBeCloseTo(0.349, 6);
  });

  test('takes the whole reservoir for 畑, not the 北九州分 share printed under it', () => {
    const hata = parseKitakyushuSuigen(html).rows.find((r) => r.name === '畑貯水池');
    expect(hata?.storageVolumeM3).toBe(3_760_000);
    expect(hata?.storageRate).toBeCloseTo(0.544, 6);
  });

  test('a caption with 午後 is shifted by 12 hours', () => {
    const pm = html.replace('午前9時現在', '午後4時現在');
    expect(parseKitakyushuSuigen(pm).observedAt?.toISOString()).toBe('2026-09-25T07:00:00.000Z');
  });
});

describe('kitakyushuEntries', () => {
  const { observedAt, rows } = parseKitakyushuSuigen(html);
  if (!observedAt) throw new Error('no date');
  const entries = kitakyushuEntries(observedAt, rows);

  test('binds on the name without 貯水池, 耶馬渓 in the master kanji 耶馬溪 in 大分', () => {
    const by = (key: string) => entries.find((e) => e.key === key);
    expect(by('松ヶ江貯水池')).toMatchObject({ pref: '40', bind: { name: '松ヶ江' } });
    // 畑 is the master 畑 by exact name, never 切畑 or 南畑.
    expect(by('畑貯水池')).toMatchObject({ pref: '40', bind: { name: '畑' } });
    expect(by('耶馬渓貯水池')).toMatchObject({ pref: '44', bind: { name: '耶馬溪' } });
    expect(by('遠賀川河口堰')?.bind).toBeUndefined();
  });

  test('never binds 頓田, whose one combined figure spans two master dams', () => {
    expect(entries.find((e) => e.key === '頓田貯水池')?.bind).toBe('never');
  });

  test('every facility reads level, volume and rate at the caption time', () => {
    expect(entries).toHaveLength(10);
    expect(entries.every((e) => 'state' in e.reading && e.reading.state === 'values')).toBe(true);
    const hata = entries.find((e) => e.key === '畑貯水池')?.reading;
    if (!hata || typeof hata === 'function' || hata.state !== 'values') throw new Error('畑');
    expect(hata.observations[0]).toMatchObject({ observedAt, storageVolumeM3: 3_760_000 });
  });

  test('a facility with every cell blank is unreadable', () => {
    const blank = rows.map((r) =>
      r.name === '白木貯水池'
        ? { ...r, waterLevelM: null, storageVolumeM3: null, storageRate: null }
        : r,
    );
    const shiraki = kitakyushuEntries(observedAt, blank).find((e) => e.key === '白木貯水池');
    expect(shiraki?.reading).toMatchObject({ state: 'unreadable' });
  });
});
