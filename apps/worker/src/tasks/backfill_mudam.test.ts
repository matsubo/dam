import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { matchMaster } from './backfill_mudam.ts';

// 花山 (宮城) as prod has it on 2026-09-27: NDI 269 花山（元） (1957) and NDI
// 270 花山（再） (2004) share one coordinate, and mudam damsysId 181 is stamped
// on both. mudam lists 181 as "花山" at 38.780045, 140.868942.
const SLUGS = ['mudam-test-hanayama-moto', 'mudam-test-hanayama-sai'];
const HANAYAMA = { damsysId: 181, lat: 38.780045, lng: 140.868942, name: '花山' };
const ids = new Map<string, bigint>();

async function cleanup(): Promise<void> {
  await sql`DELETE FROM dams WHERE slug IN ${sql(SLUGS)}`;
}

async function seed(stamp: string | null): Promise<void> {
  await cleanup();
  for (const [slug, ndi, name, year] of [
    ['mudam-test-hanayama-moto', '269', '花山（元）', 1957],
    ['mudam-test-hanayama-sai', '270', '花山（再）', 2004],
  ] as const) {
    const ext = stamp ? { ndi, mudam: stamp } : { ndi };
    const [r] = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, location, external_ids, completed_year)
      VALUES (${slug}, ${name}, '04',
              ST_SetSRID(ST_MakePoint(140.86897216054876, 38.78003418050384), 4326)::geography,
              ${sql.json(ext)}, ${year})
      RETURNING id
    `;
    ids.set(slug, r?.id ?? 0n);
  }
}

beforeEach(cleanup);
afterAll(cleanup);

describe('matchMaster (#79)', () => {
  test('花山 stamped on both twins binds the completed （再）', async () => {
    await seed('181');
    const m = await matchMaster(HANAYAMA);
    expect(m?.damId).toBe(ids.get('mudam-test-hanayama-sai'));
    expect(m?.damName).toBe('花山（再）');
  });

  test('unstamped 花山 twins at one distance go to the completed （再）', async () => {
    await seed(null);
    const m = await matchMaster(HANAYAMA);
    expect(m?.damId).toBe(ids.get('mudam-test-hanayama-sai'));
  });
});
