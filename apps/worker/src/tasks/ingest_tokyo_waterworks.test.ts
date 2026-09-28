// apps/worker/src/tasks/ingest_tokyo_waterworks.test.ts
//
// Parser tests run against a verbatim capture of the live page taken on
// Monday 2026-09-28, when it still carried Friday's 「令和8年9月25日(金曜日)」
// readings: 利根川水系 / 荒川水系 「0時現在」, 多摩川水系 「7時現在」.
//
// DB-backed: run via the serializing helper against a scratch database.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import {
  ensureExternalIds,
  findMaster,
  parseTokyoWaterworksHtml,
} from './ingest_tokyo_waterworks.ts';

const FIXTURE_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/tokyo-waterworks/suigen_2026-09-28.html',
);

describe('parseTokyoWaterworksHtml', () => {
  test('stamps each row with the page date and its table’s 「N時現在」, not the fetch date', async () => {
    const rows = parseTokyoWaterworksHtml(await readFile(FIXTURE_PATH, 'utf8'));
    const byName = new Map(rows.map((r) => [r.tokyoName, r]));
    // 利根川 0時 on 9/25 JST = 2026-09-24 15:00 UTC.
    expect(byName.get('矢木沢ダム')).toEqual({
      tokyoName: '矢木沢ダム',
      observedAt: new Date('2026-09-24T15:00:00Z'),
      storageVolumeWanM3: 9827.2,
      storageRatePct: 85.1,
      prevDeltaWanM3: -89.0,
    });
    expect(byName.get('浦山ダム')?.observedAt).toEqual(new Date('2026-09-24T15:00:00Z'));
    // 多摩川 7時 on 9/25 JST = 2026-09-24 22:00 UTC.
    expect(byName.get('小河内貯水池')).toEqual({
      tokyoName: '小河内貯水池',
      observedAt: new Date('2026-09-24T22:00:00Z'),
      storageVolumeWanM3: 16259.4,
      storageRatePct: 87.7,
      prevDeltaWanM3: 23.8,
    });
  });

  test('reads every single-dam row and not the 村山・山口 three-reservoir total', async () => {
    const rows = parseTokyoWaterworksHtml(await readFile(FIXTURE_PATH, 'utf8'));
    const names = rows.map((r) => r.tokyoName);
    expect(names).toHaveLength(14);
    expect(names).not.toContain('村山・山口貯水池');
  });

  test('returns no rows when the page date is missing', async () => {
    const html = (await readFile(FIXTURE_PATH, 'utf8')).replace(/令和8年9月25日/g, '');
    expect(parseTokyoWaterworksHtml(html)).toEqual([]);
  });
});

// A 村山下 row the 村山・山口 total would land on under a '%村山%' LIKE, and a
// 渡良瀬 row for the multi-prefecture entry. Synthetic names keep a loaded
// master's real rows out of the way.
const MURAYAMA = { slug: 'test-tokyo-murayamashimo', name: '村山下テスト', pref: '13' };
const WATARASE = { slug: 'test-tokyo-watarase', name: 'テスト渡良瀬遊水地', pref: '10' };

describe('ensureExternalIds', () => {
  const ids = new Map<string, bigint>();
  let universeBefore: string[] = [];
  let runBefore = false;

  beforeAll(async () => {
    const rows = await sql<{ k: string }[]>`
      SELECT source_external_id AS k FROM source_universe WHERE source_id = 'tokyo-waterworks'
    `;
    universeBefore = rows.map((r) => r.k);
    const runs = await sql`SELECT 1 FROM source_universe_runs WHERE source_id = 'tokyo-waterworks'`;
    runBefore = runs.length > 0;
    for (const f of [MURAYAMA, WATARASE]) {
      const inserted = await sql<{ id: bigint }[]>`
        INSERT INTO dams (slug, name, pref_code, completed_year, location, external_ids)
        VALUES (${f.slug}, ${f.name}, ${f.pref}, 2008,
                ST_SetSRID(ST_MakePoint(139.43, 35.76), 4326)::geography, '{}'::jsonb)
        RETURNING id
      `;
      const id = inserted[0]?.id;
      if (!id) throw new Error(`insert ${f.name} failed`);
      ids.set(f.slug, id);
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug IN ${sql([MURAYAMA.slug, WATARASE.slug])}`;
    await sql`
      DELETE FROM source_universe
      WHERE source_id = 'tokyo-waterworks' AND NOT (source_external_id = ANY(${universeBefore}))
    `;
    if (!runBefore)
      await sql`DELETE FROM source_universe_runs WHERE source_id = 'tokyo-waterworks'`;
  });

  test('records the 村山・山口 total as published but binds and stamps no dam', async () => {
    const matches = await ensureExternalIds(() => {});
    expect(matches.map((m) => m.tokyoName)).not.toContain('村山・山口貯水池');
    const stamp = await sql<{ k: string | null }[]>`
      SELECT external_ids->>'tokyo-waterworks' AS k FROM dams WHERE id = ${ids.get(MURAYAMA.slug) ?? 0n}
    `;
    expect(stamp[0]?.k).toBeNull();
    const universe = await sql<{ resolved: bigint | null }[]>`
      SELECT resolved_dam_id AS resolved FROM source_universe
      WHERE source_id = 'tokyo-waterworks' AND source_external_id = '村山・山口貯水池'
    `;
    expect([...universe]).toEqual([{ resolved: null }]);
  });

  test('records no prefecture for an entry that spans several', async () => {
    await ensureExternalIds(() => {});
    const universe = await sql<{ pref: string | null; resolved: bigint | null }[]>`
      SELECT pref_code AS pref, resolved_dam_id AS resolved FROM source_universe
      WHERE source_id = 'tokyo-waterworks' AND source_external_id = '渡良瀬貯水池'
    `;
    expect([...universe]).toEqual([{ pref: null, resolved: ids.get(WATARASE.slug) ?? null }]);
  });
});

// Shaped like 村山下（元） 1927 / 村山上 1924 / 村山下（再） 2008 in 東京, the
// twins a '%<stem>%' LIKE can reach. A synthetic stem keeps the real,
// already-stamped rows of a loaded master out of the candidates.
const ENTRY = { tokyoName: 'テスト貯水池', masterName: 'テスト村山', prefCodes: ['13'] };
const FIXTURES = [
  { slug: 'test-tokyo-murayamashimo-moto', name: 'テスト村山下（元）', completedYear: 1927 },
  { slug: 'test-tokyo-murayamakami', name: 'テスト村山上', completedYear: 1924 },
  { slug: 'test-tokyo-murayamashimo-sai', name: 'テスト村山下（再）', completedYear: 2008 },
];

describe('findMaster (#79)', () => {
  const ids = new Map<string, bigint>();

  beforeAll(async () => {
    // Inserted in this order so the （元） holds the lowest id — the row a
    // lowest-id tie-break would pick.
    for (const f of FIXTURES) {
      const rows = await sql<{ id: bigint }[]>`
        INSERT INTO dams (slug, name, pref_code, completed_year, location, external_ids)
        VALUES (${f.slug}, ${f.name}, '13', ${f.completedYear},
                ST_SetSRID(ST_MakePoint(139.43, 35.76), 4326)::geography, '{}'::jsonb)
        RETURNING id
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error(`insert ${f.name} failed`);
      ids.set(f.name, id);
    }
  });

  afterAll(async () => {
    const fixtureIds = [...ids.values()];
    if (fixtureIds.length > 0) await sql`DELETE FROM dams WHERE id IN ${sql(fixtureIds)}`;
  });

  test('binds a twin-tied listing to the completed （再）, not the lower-id （元）', async () => {
    const r = await findMaster(ENTRY);
    expect(r?.id).toBe(ids.get('テスト村山下（再）'));
  });
});
