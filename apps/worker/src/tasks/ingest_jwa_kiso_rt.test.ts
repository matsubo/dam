// apps/worker/src/tasks/ingest_jwa_kiso_rt.test.ts
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 中部支社 リアルタイム情報
// 木曽川水系 (water.go.jp/mizu/chubu/realtime/index.html) taken 2026-09-28
// 12:54 JST, 観測時刻 2026年09月28日 12時40分. Page order: 牧尾, 味噌川,
// 阿木川, 岩屋, 徳山, 打上調整池 (貯水位 only), 中里貯水池 (貯水位 and
// 有効貯水量 only), 宮川/菰野/加佐登調整池, then 長良川河口堰 (堰上流水位 1.34,
// 堰下流水位 -0.63, 流入量 193.44, 流出量 214.77) and 木曽川大堰 (堰上流水位 3.60,
// 流入量 542.99, 放流量 535.39).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { kisoReadings, matchKiso } from './ingest_jwa_kiso_rt.ts';
import { parseJwaChubuRealtime } from './jwa_chubu_realtime.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_kiso_rt/index_2026-09-28.html',
);

async function facilities() {
  return parseJwaChubuRealtime(await readFile(FIXTURE, 'utf8')).facilities;
}

describe('kisoReadings', () => {
  test('stores all 12 facilities, each from its own table', async () => {
    const rows = kisoReadings(await facilities());
    expect(rows.map((r) => r.name)).toEqual([
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
    expect(rows[0]).toEqual({
      name: '牧尾ダム',
      waterLevelM: 877.75,
      storageVolumeM3: 60_877_000,
      inflowM3s: 375.6,
      outflowM3s: 392.78,
    });
    // 中里's table has no flows; the 193.44 and 535.39 further down the page
    // belong to 長良川河口堰 and 木曽川大堰.
    expect(rows.find((r) => r.name === '中里貯水池')).toEqual({
      name: '中里貯水池',
      waterLevelM: 172.52,
      storageVolumeM3: 1_801_000,
      inflowM3s: null,
      outflowM3s: null,
    });
    expect(rows.find((r) => r.name === '宮川調整池')).toEqual({
      name: '宮川調整池',
      waterLevelM: 121.09,
      storageVolumeM3: 357_000,
      inflowM3s: null,
      outflowM3s: null,
    });
  });

  test('a weir stores its 堰上流水位 as the level and 流出量 / 放流量 as the outflow', async () => {
    const rows = kisoReadings(await facilities());
    expect(rows.find((r) => r.name === '長良川河口堰')).toEqual({
      name: '長良川河口堰',
      waterLevelM: 1.34,
      storageVolumeM3: null,
      inflowM3s: 193.44,
      outflowM3s: 214.77,
    });
    expect(rows.find((r) => r.name === '木曽川大堰')).toEqual({
      name: '木曽川大堰',
      waterLevelM: 3.6,
      storageVolumeM3: null,
      inflowM3s: 542.99,
      outflowM3s: 535.39,
    });
  });

  test('a facility with every cell cut is not stored', async () => {
    const html = (await readFile(FIXTURE, 'utf8')).replace('>213.12<', '>cc<');
    const rows = kisoReadings(parseJwaChubuRealtime(html).facilities);
    expect(rows.find((r) => r.name === '打上調整池')).toBeUndefined();
    expect(rows).toHaveLength(11);
  });
});

describe('matchKiso binds 中里貯水池 to 三重用水 in 三重県', () => {
  // 中里貯水池 is 三重用水's reservoir (いなべ市, NDI 940; the jwa-chubu report
  // prints its 利水容量 16,000 千m³ = the master's 有効). Migration 0031 had
  // invented a 長野 '中里' for it, which carried the stamp on prod. Synthetic
  // rows: the 三重 master and a stamped 長野 namesake.
  const SLUGS = ['jwa-kiso-rt-t-nakazato-mie', 'jwa-kiso-rt-t-nakazato-nagano'];
  const KEY = '中里貯水池';

  async function insertDam(slug: string, prefCode: string, stamped: boolean): Promise<bigint> {
    const ids = stamped ? { 'jwa-kiso-rt': KEY } : {};
    const rows = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, location, external_ids)
      VALUES (${slug}, '中里', ${prefCode},
              ST_SetSRID(ST_MakePoint(136.48, 35.22), 4326)::geography, ${sql.json(ids)})
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('insert dam failed');
    return id;
  }

  async function stampOf(id: bigint): Promise<string | null> {
    const rows = await sql<{ k: string | null }[]>`
      SELECT external_ids->>'jwa-kiso-rt' AS k FROM dams WHERE id = ${id}
    `;
    return rows[0]?.k ?? null;
  }

  beforeEach(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });

  test('the 三重 row wins over a 長野 namesake that holds the stamp', async () => {
    const mie = await insertDam(SLUGS[0] as string, '24', false);
    const nagano = await insertDam(SLUGS[1] as string, '20', true);

    const { damByName, universe } = await matchKiso(await facilities(), () => {});

    expect(damByName.get(KEY)).toBe(mie);
    expect(await stampOf(mie)).toBe(KEY);
    expect(await stampOf(nagano)).toBeNull();
    expect(universe.find((u) => u.externalId === KEY)?.prefCode).toBe('24');
    expect(universe).toHaveLength(12);
  });
});
