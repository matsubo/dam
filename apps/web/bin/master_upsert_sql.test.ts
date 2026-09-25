import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { buildMasterUpsertSql, type SeedDam } from './master_upsert_sql.ts';

// The seed is applied on every web boot. It must converge on NEW rows only and
// never roll prod back to the snapshot it was generated from: until #54 its
// seed-wins UPDATE rewrote damnet stamps, specs and slugs on each deploy.

const NDI_A = '9999999995';
const NDI_B = '9999999996';
const NDI_NEW = '9999999994';
const FIXTURE_NDI = [NDI_A, NDI_B, NDI_NEW];
const POINT = '0101000020e6100000000000000000614000000000008045c0'; // hex EWKB, lng 136 lat -43

async function cleanup(): Promise<void> {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${FIXTURE_NDI}::TEXT[])`;
  await sql`DELETE FROM source_priorities WHERE source_id IN ('seed-test-new', 'seed-test-old')`;
}

const seedDam = (ndi: string, slug: string, damnet: string, heightM: string): SeedDam => ({
  slug,
  name: `seed-test-${ndi}`,
  name_kana: null,
  pref_code: '01',
  manager: 'stale snapshot',
  type: null,
  height_m: heightM,
  total_capacity_m3: null,
  effective_capacity_m3: null,
  flood_capacity_m3: null,
  active_capacity_m3: '999',
  completed_year: null,
  construction_start_year: null,
  purposes: null,
  crest_length_m: null,
  embankment_volume_m3: null,
  watershed_area_km2: null,
  reservoir_area_km2: null,
  left_bank_location: null,
  main_contractor: null,
  redevelopment_status: null,
  elevation_m: 42,
  image_url: 'https://example.invalid/seed.jpg',
  location: POINT,
  external_ids: { ndi, damnet, 'seed-only': `x-${ndi}` },
});

beforeAll(async () => {
  await cleanup();
  // Prod: stamps already corrected (as 0052 did), specs refreshed, slug renamed.
  for (const [ndi, slug, damnet] of [
    [NDI_A, 'seed-test-a-renamed', 'T801'],
    [NDI_B, 'seed-test-b', 'T802'],
  ] as const) {
    await sql`
      INSERT INTO dams (slug, name, pref_code, location, external_ids, height_m, active_capacity_m3)
      VALUES (${slug}, ${`seed-test-${ndi}`}, '01', ${POINT}::geography,
              jsonb_build_object('ndi', ${ndi}::text, 'damnet', ${damnet}::text), 100, 5000)
    `;
  }
  await sql`INSERT INTO source_priorities (source_id, description, priority, active)
            VALUES ('seed-test-old', 'prod description', 300, TRUE)`;

  // Seed: the pre-#54 snapshot, stamps swapped and specs stale.
  const text = buildMasterUpsertSql({
    sources: [
      { source_id: 'seed-test-old', description: 'stale description', priority: 1, active: false },
      { source_id: 'seed-test-new', description: 'new source', priority: 10, active: true },
      { source_id: 'synthetic', description: 'retired', priority: 200, active: true },
    ],
    watersheds: [],
    dams: [
      seedDam(NDI_A, 'seed-test-a', 'T802', '12.5'),
      seedDam(NDI_B, 'seed-test-b', 'T801', '12.5'),
      seedDam(NDI_NEW, 'seed-test-new', 'T803', '30'),
    ],
  });
  // The file carries its own BEGIN/COMMIT, as bootstrap.sh pipes it to psql.
  const conn = await sql.reserve();
  try {
    await conn.unsafe(text);
  } finally {
    conn.release();
  }
});

afterAll(cleanup);

describe('buildMasterUpsertSql', () => {
  test('applies cleanly over prod rows whose damnet stamps the snapshot has swapped', async () => {
    const rows = await sql<{ ndi: string; damnet: string; slug: string }[]>`
      SELECT external_ids->>'ndi' AS ndi, external_ids->>'damnet' AS damnet, slug
      FROM dams WHERE external_ids ->> 'ndi' IN (${NDI_A}, ${NDI_B}) ORDER BY 1
    `;
    expect([...rows]).toEqual([
      { ndi: NDI_A, damnet: 'T801', slug: 'seed-test-a-renamed' },
      { ndi: NDI_B, damnet: 'T802', slug: 'seed-test-b' },
    ]);
  });

  test('leaves prod specs alone but fills blanks and adds non-damnet ids', async () => {
    const [a] = await sql<
      { height: string; cap: string; manager: string | null; elev: number; seedOnly: string }[]
    >`
      SELECT height_m::TEXT AS height, active_capacity_m3::TEXT AS cap, manager,
             elevation_m AS elev, external_ids->>'seed-only' AS "seedOnly"
      FROM dams WHERE external_ids ->> 'ndi' = ${NDI_A}
    `;
    expect(a).toEqual({
      height: '100.00',
      cap: '5000.00',
      manager: null,
      elev: 42,
      seedOnly: `x-${NDI_A}`,
    });
  });

  test('inserts a brand-new dam without a damnet stamp', async () => {
    const [n] = await sql<{ damnet: string | null; height: string }[]>`
      SELECT external_ids->>'damnet' AS damnet, height_m::TEXT AS height
      FROM dams WHERE external_ids ->> 'ndi' = ${NDI_NEW}
    `;
    expect(n).toEqual({ damnet: null, height: '30.00' });
  });

  test('source_priorities: inserts new rows only and never re-adds synthetic', async () => {
    const rows = await sql<{ source_id: string; description: string; priority: number }[]>`
      SELECT source_id, description, priority FROM source_priorities
      WHERE source_id IN ('seed-test-old', 'seed-test-new') ORDER BY 1
    `;
    expect([...rows]).toEqual([
      { source_id: 'seed-test-new', description: 'new source', priority: 10 },
      { source_id: 'seed-test-old', description: 'prod description', priority: 300 },
    ]);
    const text = buildMasterUpsertSql({
      sources: [{ source_id: 'synthetic', description: 'x', priority: 1, active: true }],
      watersheds: [],
      dams: [],
    });
    expect(text).not.toContain("'synthetic'");
  });
});
