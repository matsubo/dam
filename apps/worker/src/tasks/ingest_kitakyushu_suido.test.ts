// apps/worker/src/tasks/ingest_kitakyushu_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 北九州市上下水道局「北九州市の水源状況」
// (city.kitakyushu.lg.jp/suidou/s00900011.html) taken 2026-09-27, showing the
// 2026年9月25日 午前9時 table (the page is refreshed on weekdays only).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BindableMaster } from '@dam/core/dam_binding';
import { chooseMaster, parseKitakyushuSuigen } from './ingest_kitakyushu_suido.ts';

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

describe('chooseMaster', () => {
  // Real prod rows (福岡 40 / 大分 44) that the published names could reach.
  const masters: BindableMaster[] = [
    { id: 10993n, name: '松ヶ江', completedYear: 1960 },
    { id: 11008n, name: 'ます渕', completedYear: 1973 },
    { id: 11012n, name: '遠賀川河口堰', completedYear: 1983 },
    { id: 11013n, name: '切畑', completedYear: 1975 },
    { id: 11026n, name: '畑', completedYear: 1955 },
    { id: 11028n, name: '頓田第1（再）', completedYear: 1968 },
    { id: 11029n, name: '頓田第2（再）', completedYear: 1968 },
    { id: 11045n, name: '南畑（元）', completedYear: 1965 },
    { id: 11046n, name: '南畑（再）', completedYear: 1985 },
    { id: 11279n, name: '耶馬溪', completedYear: 1984 },
  ];

  test('strips 貯水池 and matches the dam of the same stem', () => {
    expect(chooseMaster('松ヶ江貯水池', masters)).toBe(10993n);
    expect(chooseMaster('ます渕貯水池', masters)).toBe(11008n);
    expect(chooseMaster('遠賀川河口堰', masters)).toBe(11012n);
  });

  test('畑 binds to 畑, never to 切畑 or 南畑', () => {
    expect(chooseMaster('畑貯水池', masters)).toBe(11026n);
  });

  test('folds 耶馬渓 (feed) onto 耶馬溪 (master)', () => {
    expect(chooseMaster('耶馬渓貯水池', masters)).toBe(11279n);
  });

  test('refuses 頓田, whose one combined figure spans two master dams', () => {
    expect(chooseMaster('頓田貯水池', masters)).toBeNull();
  });

  test('a row already stamped with the station keeps it', () => {
    const stamped = masters.map((m) => (m.id === 11029n ? { ...m, stamp: '頓田貯水池' } : m));
    expect(chooseMaster('頓田貯水池', stamped)).toBe(11029n);
  });
});
