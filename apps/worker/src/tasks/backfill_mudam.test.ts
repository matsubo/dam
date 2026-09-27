import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { matchMaster } from './backfill_mudam.ts';

// 花山 (宮城) as prod has it on 2026-09-27: NDI 269 花山（元） (1957) and NDI
// 270 花山（再） (2004) share one coordinate, and mudam damsysId 181 is stamped
// on both. mudam lists 181 as "花山" at 38.780045, 140.868942.
const MOTO = 'mudam-test-hanayama-moto';
const SAI = 'mudam-test-hanayama-sai';
const BARE = 'mudam-test-hanayama-bare';
const SLUGS = [MOTO, SAI, BARE];
const HANAYAMA = { damsysId: 181, lat: 38.780045, lng: 140.868942, name: '花山' };
const LNG = 140.86897216054876;
const LAT = 38.78003418050384;
const ids = new Map<string, bigint>();

async function cleanup(): Promise<void> {
  await sql`DELETE FROM dams WHERE slug IN ${sql(SLUGS)}`;
}

type Row = [slug: string, ndi: string, name: string, year: number, lat: number];

const TWINS: Row[] = [
  [MOTO, '269', '花山（元）', 1957, LAT],
  [SAI, '270', '花山（再）', 2004, LAT],
];

async function seed(rows: Row[], stamp: string | null = null): Promise<void> {
  await cleanup();
  for (const [slug, ndi, name, year, lat] of rows) {
    const ext = stamp ? { ndi, mudam: stamp } : { ndi };
    const [r] = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, location, external_ids, completed_year)
      VALUES (${slug}, ${name}, '04',
              ST_SetSRID(ST_MakePoint(${LNG}, ${lat}), 4326)::geography,
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
    await seed(TWINS, '181');
    const m = await matchMaster(HANAYAMA);
    expect(m?.damId).toBe(ids.get(SAI));
    expect(m?.damName).toBe('花山（再）');
  });

  test('unstamped 花山 twins at one distance go to the completed （再）', async () => {
    await seed(TWINS);
    const m = await matchMaster(HANAYAMA);
    expect(m?.damId).toBe(ids.get(SAI));
  });

  test('a farther completed （再） still beats its nearer （元） and a non-twin between them', async () => {
    // Synthetic layout: the （再） ~300 m past the （元）, a bare-stem 花山
    // row ~150 m out. The pair ranks at the （元）'s distance, so it beats the
    // bare row and the tie goes to the completed （再）.
    await seed([
      [MOTO, '269', '花山（元）', 1957, LAT],
      [BARE, '9999999981', '花山', 1957, LAT + 0.00135],
      [SAI, '270', '花山（再）', 2004, LAT + 0.0027],
    ]);
    const m = await matchMaster(HANAYAMA);
    expect(m?.damId).toBe(ids.get(SAI));
    expect(m?.distanceM).toBeGreaterThan(250);
  });
});
