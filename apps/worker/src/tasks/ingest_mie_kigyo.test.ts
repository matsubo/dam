// apps/worker/src/tasks/ingest_mie_kigyo.test.ts
//
// Fixture is a verbatim UTF-8 capture of 三重県企業庁「県営水道用水供給事業及び
// 工業用水道事業の水源状況」 (pref.mie.lg.jp/D1KIGYO/12674013222.htm) taken
// 2026-09-28, headed 「令和8年9月24日（木）現在」: 7 ダム rows.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  type MieMaster,
  observationValues,
  parseMieKigyoSuigen,
} from './ingest_mie_kigyo.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/mie_kigyo/suigen_2026-09-28.htm',
);

const html = await readFile(FIXTURE, 'utf8');
const { observedAt, rows } = parseMieKigyoSuigen(html);

function row(name: string) {
  const r = rows.find((x) => x.name === name);
  if (!r) throw new Error(`${name} missing from fixture`);
  return r;
}

describe('parseMieKigyoSuigen', () => {
  test('dates the table from 「令和8年9月24日（木）現在」 at 00:00 JST', () => {
    expect(observedAt).toEqual(new Date('2026-09-23T15:00:00.000Z'));
  });

  test('reads every published dam in page order', () => {
    expect(rows.map((r) => r.name)).toEqual([
      '岩屋ダム',
      '伊坂ダム',
      '山村ダム',
      '中里ダム',
      '菰野調整池',
      '君ヶ野ダム',
      '蓮ダム',
    ]);
  });

  test('converts 千m³ to m³ and % to a fraction', () => {
    expect(row('伊坂ダム')).toEqual({
      name: '伊坂ダム',
      capacityM3: 3_716_000,
      storageVolumeM3: 3_254_000,
      storageRate: 0.875,
    });
    expect(row('岩屋ダム').storageRate).toBe(1);
  });

  test('reads a 有効貯水量 cell styled by class instead of align', () => {
    // 岩屋's first <td> is class="txt-r", the others align="right".
    expect(row('岩屋ダム').capacityM3).toBe(61_900_000);
  });

  test('keeps a dam whose readings are missing markers, with null values', () => {
    const blank = html.replace(
      /(<th>山村ダム<\/th>\s*<td[^>]*>1,964<\/td>\s*)<td[^>]*>1,757<\/td>\s*<td[^>]*>89\.4<\/td>/,
      '$1<td align="right">－</td><td align="right">&nbsp;</td>',
    );
    expect(parseMieKigyoSuigen(blank).rows.find((r) => r.name === '山村ダム')).toEqual({
      name: '山村ダム',
      capacityM3: 1_964_000,
      storageVolumeM3: null,
      storageRate: null,
    });
  });

  test('reads 令和元年 as 2019', () => {
    const gannen = html.replace('令和8年9月24日', '令和元年5月7日');
    expect(parseMieKigyoSuigen(gannen).observedAt).toEqual(new Date('2019-05-06T15:00:00.000Z'));
  });

  test('has no date when the 「現在」 line is gone', () => {
    expect(parseMieKigyoSuigen(html.replace(/現在/g, '')).observedAt).toBeNull();
  });
});

describe('observationValues', () => {
  test('keeps the rate when the printed 有効 is the master active capacity', () => {
    // 伊坂 3,716 千m³ printed vs master 3,715,000.
    expect(observationValues(row('伊坂ダム'), 3_715_000)).toEqual({
      storageVolumeM3: 3_254_000,
      storageRate: 0.875,
    });
    expect(observationValues(row('菰野調整池'), 1_600_000)?.storageRate).toBe(0.828);
  });

  test('drops the rate when it is printed on another denominator', () => {
    // 山村 1,964 千m³ printed vs master 2,183,000: 89.4 % would not be
    // 1,757 / 2,183 = 80.5 %.
    expect(observationValues(row('山村ダム'), 2_183_000)).toEqual({
      storageVolumeM3: 1_757_000,
      storageRate: null,
    });
  });

  test('drops the rate when the master has no active capacity', () => {
    expect(observationValues(row('伊坂ダム'), null)?.storageRate).toBeNull();
  });

  test('writes nothing when there is nothing to keep', () => {
    const empty = {
      name: '山村ダム',
      capacityM3: 1_964_000,
      storageVolumeM3: null,
      storageRate: 0.9,
    };
    expect(observationValues(empty, 2_183_000)).toBeNull();
  });
});

describe('chooseMaster', () => {
  // Real prod rows (三重 24, plus 岐阜 21 for 岩屋 and a same-named decoy).
  const masters: MieMaster[] = [
    { id: 9867n, name: '岩屋', prefCode: '21', completedYear: 1976 },
    { id: 10016n, name: '中里', prefCode: '24', completedYear: 1976 },
    { id: 10020n, name: '菰野調整池', prefCode: '24', completedYear: 1989 },
    { id: 10025n, name: '山村', prefCode: '24', completedYear: 1973 },
    { id: 10026n, name: '伊坂', prefCode: '24', completedYear: 1966 },
    { id: 10034n, name: '君ヶ野', prefCode: '24', completedYear: 1971 },
    { id: 10043n, name: '蓮', prefCode: '24', completedYear: 1991 },
    { id: 1n, name: '伊坂', prefCode: '21', completedYear: 2000 },
  ];

  test('binds each name to the master of the same stem in its prefecture', () => {
    expect(chooseMaster('伊坂ダム', masters)).toBe(10026n);
    expect(chooseMaster('山村ダム', masters)).toBe(10025n);
    expect(chooseMaster('菰野調整池', masters)).toBe(10020n);
    expect(chooseMaster('蓮ダム', masters)).toBe(10043n);
  });

  test('looks for 岩屋 in 岐阜, where the dam is', () => {
    expect(chooseMaster('岩屋ダム', masters)).toBe(9867n);
  });

  test('keeps an existing stamp over a name match', () => {
    const stamped = masters.map((m) => (m.id === 1n ? { ...m, stamp: '伊坂ダム' } : m));
    expect(chooseMaster('伊坂ダム', stamped)).toBe(1n);
  });

  test('binds nothing for an unknown name', () => {
    expect(chooseMaster('新設ダム', masters)).toBeNull();
  });
});
