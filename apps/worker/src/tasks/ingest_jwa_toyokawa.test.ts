// apps/worker/src/tasks/ingest_jwa_toyokawa.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 中部支社 リアルタイム情報
// 豊川水系 (water.go.jp/mizu/chubu/realtime/index_2.html) taken 2026-09-28
// 07:16 JST, 観測時刻 2026年09月28日 07時10分. It lists 14 facilities: 宇連 and
// 大島 (貯水位, 有効貯水量, 流入量, 放流量（利水）), the 豊川用水 調整池 (貯水位 and
// 有効貯水量 only), and five 頭首工 (貯水位 only).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindEntry, type Master } from '../ingest/bind.ts';
import type { Entry, Observed } from '../ingest/types.ts';
import { toyokawaEntries } from './ingest_jwa_toyokawa.ts';
import { parseJwaChubuRealtime } from './jwa_chubu_realtime.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_toyokawa/index_2_2026-09-28.html',
);

async function entries(edit: (html: string) => string = (h) => h): Promise<Entry[]> {
  const { observedAt, facilities } = parseJwaChubuRealtime(edit(await readFile(FIXTURE, 'utf8')));
  if (!observedAt) throw new Error('no 観測時刻');
  return toyokawaEntries(facilities, observedAt);
}

function observed(list: Entry[], key: string): Omit<Observed, 'observedAt'> {
  const r = list.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error(`${key}: no values`);
  const [o] = r.observations;
  if (!o) throw new Error(`${key}: no observation`);
  const { observedAt: _, ...quantities } = o;
  return quantities;
}

describe('toyokawaEntries', () => {
  test('every facility has values: 10³m³ as m³, no 放流量（利水） as outflow', async () => {
    const list = await entries();
    expect(list).toHaveLength(14);
    expect(list.every((e) => e.pref === '23')).toBe(true);
    expect(list.every((e) => 'state' in e.reading && e.reading.state === 'values')).toBe(true);
    expect(list[0]?.key).toBe('宇連ダム');
    expect(observed(list, '宇連ダム')).toEqual({
      waterLevelM: 219.19,
      storageVolumeM3: 18_158_000,
      inflowM3s: 2.17,
    });
    // A 調整池 prints level and volume only.
    expect(observed(list, '万場調整池')).toEqual({
      waterLevelM: 40.09,
      storageVolumeM3: 4_861_000,
      inflowM3s: null,
    });
    // 大野頭首工's 貯水位 is an EL: its 施設情報 page gives 常時満水位 78.00 m.
    expect(observed(list, '大野頭首工')).toEqual({
      waterLevelM: 77.39,
      storageVolumeM3: null,
      inflowM3s: null,
    });
  });

  test('a facility with every cell cut is unreadable; one with inflow left has values', async () => {
    const list = await entries((h) =>
      h
        .replace('>108.76<', '>cc<')
        .replace('>1956<', '>cc<')
        .replace('>219.19<', '>cc<')
        .replace('>18158<', '>cc<'),
    );
    expect(list.find((e) => e.key === '大原調整池')?.reading).toEqual({
      state: 'unreadable',
      why: 'no stored quantity printed ("cc" or blank)',
    });
    expect(observed(list, '宇連ダム')).toEqual({
      waterLevelM: null,
      storageVolumeM3: null,
      inflowM3s: 2.17,
    });
  });
});

describe('binding the 豊川 facilities', () => {
  // Synthetic master rows, 愛知 unless noted: the 蒲郡 twin pair, a 岐阜 大島
  // that must not take 大島ダム, and the 愛知 大島.
  const master = (id: number, name: string, prefCode: string, completedYear: number): Master => ({
    id: BigInt(id),
    name,
    prefCode,
    completedYear,
    stamp: null,
    ndi: null,
    totalCapacityM3: null,
    activeCapacityM3: null,
  });
  const masters = [
    master(1, '蒲郡調整池（元）', '23', 1970),
    master(2, '蒲郡調整池（再）', '23', 1996),
    master(3, '大島', '21', 2018),
    master(4, '大島', '23', 2001),
  ];

  test('binds the live twin and the 愛知 namesake; a 頭首工 with no master stays unbound', async () => {
    const list = await entries();
    const bound = (key: string) => {
      const e = list.find((x) => x.key === key);
      if (!e) throw new Error(`no ${key}`);
      return bindEntry(e, masters, false).dam?.id ?? null;
    };
    expect(bound('蒲郡調整池')).toBe(2n);
    expect(bound('大島ダム')).toBe(4n);
    expect(bound('寒狭川頭首工')).toBeNull();
  });
});
