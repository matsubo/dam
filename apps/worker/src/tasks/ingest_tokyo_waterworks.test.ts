// apps/worker/src/tasks/ingest_tokyo_waterworks.test.ts
//
// DB-backed: run via the serializing helper against a scratch database.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { findMaster, NAME_MAP } from './ingest_tokyo_waterworks.ts';

// The 多摩川 rows '村山' LIKE-matches in 東京 (pref 13), as in the master:
// 村山下 was rebuilt (（元） 1927 → （再） 2008); 村山上 is a separate dam.
const FIXTURES = [
  { slug: 'test-tokyo-murayamashimo-moto', name: '村山下（元）', completedYear: 1927 },
  { slug: 'test-tokyo-murayamakami', name: '村山上', completedYear: 1924 },
  { slug: 'test-tokyo-murayamashimo-sai', name: '村山下（再）', completedYear: 2008 },
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
  test('binds 村山・山口貯水池 to the completed 村山下（再）, not the lower-id （元）', async () => {
    const entry = NAME_MAP.find((m) => m.tokyoName === '村山・山口貯水池');
    if (!entry) throw new Error('村山・山口貯水池 missing from NAME_MAP');
    const r = await findMaster(entry);
    expect(r?.id).toBe(ids.get('村山下（再）'));
  });
});
