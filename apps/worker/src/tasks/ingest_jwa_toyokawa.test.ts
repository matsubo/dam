// apps/worker/src/tasks/ingest_jwa_toyokawa.test.ts
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 中部支社 リアルタイム情報
// 豊川水系 (water.go.jp/mizu/chubu/realtime/index_2.html) taken 2026-09-28
// 07:16 JST, 観測時刻 2026年09月28日 07時10分. It lists 14 facilities: 宇連 and
// 大島 (貯水位, 有効貯水量, 流入量, 放流量（利水）), the 豊川用水 調整池 (貯水位 and
// 有効貯水量 only), and five 頭首工 (貯水位 only).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { matchToyokawa, toyokawaReadings } from './ingest_jwa_toyokawa.ts';
import { parseJwaChubuRealtime } from './jwa_chubu_realtime.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_toyokawa/index_2_2026-09-28.html',
);

async function facilities() {
  return parseJwaChubuRealtime(await readFile(FIXTURE, 'utf8')).facilities;
}

describe('toyokawaReadings', () => {
  test('stores every facility with a value: 10³m³ as m³, no 放流量（利水） as outflow', async () => {
    const rows = toyokawaReadings(await facilities());
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({
      name: '宇連ダム',
      waterLevelM: 219.19,
      storageVolumeM3: 18_158_000,
      inflowM3s: 2.17,
    });
    // A 調整池 prints level and volume only.
    expect(rows.find((r) => r.name === '万場調整池')).toEqual({
      name: '万場調整池',
      waterLevelM: 40.09,
      storageVolumeM3: 4_861_000,
      inflowM3s: null,
    });
    // 大野頭首工's 貯水位 is an EL: its 施設情報 page gives 常時満水位 78.00 m.
    expect(rows.find((r) => r.name === '大野頭首工')).toEqual({
      name: '大野頭首工',
      waterLevelM: 77.39,
      storageVolumeM3: null,
      inflowM3s: null,
    });
  });

  test('a facility with every cell cut is not stored; one with inflow left is', async () => {
    const html = (await readFile(FIXTURE, 'utf8'))
      .replace('>108.76<', '>cc<')
      .replace('>1956<', '>cc<')
      .replace('>219.19<', '>cc<')
      .replace('>18158<', '>cc<');
    const rows = toyokawaReadings(parseJwaChubuRealtime(html).facilities);
    expect(rows.find((r) => r.name === '大原調整池')).toBeUndefined();
    expect(rows.find((r) => r.name === '宇連ダム')).toEqual({
      name: '宇連ダム',
      waterLevelM: null,
      storageVolumeM3: null,
      inflowM3s: 2.17,
    });
  });
});

describe('matchToyokawa', () => {
  // Synthetic master rows, 愛知 unless noted: the 蒲郡 twin pair, a 岐阜 大島
  // that must not take 大島ダム, and the 愛知 大島.
  const SLUGS = [
    'jwa-toyokawa-t-gamagori-moto',
    'jwa-toyokawa-t-gamagori-sai',
    'jwa-toyokawa-t-oshima-gifu',
    'jwa-toyokawa-t-oshima-aichi',
  ];

  async function insertDam(
    slug: string,
    name: string,
    prefCode: string,
    completedYear: number | null,
  ): Promise<bigint> {
    const rows = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, completed_year, location, external_ids)
      VALUES (${slug}, ${name}, ${prefCode}, ${completedYear},
              ST_SetSRID(ST_MakePoint(137.3, 34.8), 4326)::geography, '{}'::jsonb)
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('insert dam failed');
    return id;
  }

  beforeEach(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });

  test('binds the live twin and the 愛知 namesake; lists unlinked 頭首工 with data', async () => {
    await insertDam(SLUGS[0] as string, '蒲郡調整池（元）', '23', 1970);
    const sai = await insertDam(SLUGS[1] as string, '蒲郡調整池（再）', '23', 1996);
    await insertDam(SLUGS[2] as string, '大島', '21', 2018);
    const aichi = await insertDam(SLUGS[3] as string, '大島', '23', 2001);

    const { damByName, universe } = await matchToyokawa(await facilities(), () => {});

    expect(damByName.get('蒲郡調整池')).toBe(sai);
    expect(damByName.get('大島ダム')).toBe(aichi);
    expect(universe).toHaveLength(14);
    expect(universe.find((u) => u.externalId === '寒狭川頭首工')).toEqual({
      externalId: '寒狭川頭首工',
      name: '寒狭川頭首工',
      prefCode: '23',
      resolvedDamId: null,
      hasData: true,
    });
    const [stamp] = await sql<{ k: string | null }[]>`
      SELECT external_ids->>'jwa-toyokawa' AS k FROM dams WHERE id = ${sai}
    `;
    expect(stamp?.k).toBe('蒲郡調整池');
  });
});
