// apps/worker/src/tasks/ingest_tokyo_waterworks.test.ts
//
// DB-backed: run via the serializing helper against a scratch database.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { findMaster } from './ingest_tokyo_waterworks.ts';

// Shaped like the 村山・山口貯水池 entry, whose '村山' LIKE hits 村山下（元）
// 1927, 村山上 1924 and 村山下（再） 2008 in 東京. A synthetic stem keeps the
// real, already-stamped rows of a loaded master out of the candidates.
const ENTRY = { tokyoName: 'テスト貯水池', masterName: 'テスト村山', prefCodes: ['13'] };
const FIXTURES = [
  { slug: 'test-tokyo-murayamashimo-moto', name: 'テスト村山下（元）', completedYear: 1927 },
  { slug: 'test-tokyo-murayamakami', name: 'テスト村山上', completedYear: 1924 },
  { slug: 'test-tokyo-murayamashimo-sai', name: 'テスト村山下（再）', completedYear: 2008 },
];
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

describe('findMaster (#79)', () => {
  test('binds a twin-tied listing to the completed （再）, not the lower-id （元）', async () => {
    const r = await findMaster(ENTRY);
    expect(r?.id).toBe(ids.get('テスト村山下（再）'));
  });
});
