import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { matchMaster } from './backfill_mudam.ts';

// 花山 (宮城) as prod has it on 2026-09-27: NDI 269 花山（元） (1957) and NDI
// 270 花山（再） (2004) share one coordinate, and mudam damsysId 181 is stamped
// on both. mudam lists 181 as "花山" at 38.780045, 140.868942.
const MOTO = 'mudam-test-hanayama-moto';
const SAI = 'mudam-test-hanayama-sai';
const BARE = 'mudam-test-hanayama-bare';
// Rows named after prod's (2026-09-27): 桂沢 NDI 157/156, 遠野 NDI 240, 遠野第2
// NDI 257, at prod's coordinates. The listings are mudam's district maps'.
const KATSURA_MOTO = 'mudam-test-katsurazawa-moto';
const KATSURA_SAI = 'mudam-test-shinkatsurazawa-sai';
const TONO = 'mudam-test-tono';
const TONO2 = 'mudam-test-tono-2';
const SLUGS = [MOTO, SAI, BARE, KATSURA_MOTO, KATSURA_SAI, TONO, TONO2];
const KATSURAZAWA = { damsysId: 3, lat: 43.239949, lng: 142.002829, name: '桂沢' };
const TONO_LISTING = { damsysId: 172, lat: 39.306203, lng: 141.535417, name: '遠野' };
const TONO2_LISTING = { damsysId: 180, lat: 39.294586, lng: 141.539796, name: '遠野第二' };
const HANAYAMA = { damsysId: 181, lat: 38.780045, lng: 140.868942, name: '花山' };
const LNG = 140.86897216054876;
const LAT = 38.78003418050384;
const ids = new Map<string, bigint>();

async function cleanup(): Promise<void> {
  await sql`DELETE FROM dams WHERE slug IN ${sql(SLUGS)}`;
}

type Row = [slug: string, ndi: string, name: string, year: number, lat: number, lng?: number];

const TWINS: Row[] = [
  [MOTO, '269', '花山（元）', 1957, LAT],
  [SAI, '270', '花山（再）', 2004, LAT],
];

async function seed(rows: Row[], stamp: string | null = null): Promise<void> {
  await cleanup();
  for (const [slug, ndi, name, year, lat, lng = LNG] of rows) {
    const ext = stamp ? { ndi, mudam: stamp } : { ndi };
    const [r] = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, location, external_ids, completed_year)
      VALUES (${slug}, ${name}, '04',
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
              ${sql.json(ext)}, ${year})
      RETURNING id
    `;
    ids.set(slug, r?.id ?? 0n);
  }
}

/** Stamp one seeded row the way prod has it. */
async function stampRow(slug: string, key: string): Promise<void> {
  await sql`
    UPDATE dams SET external_ids = external_ids || ${sql.json({ mudam: key })}
    WHERE slug = ${slug}
  `;
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

describe('matchMaster listings the name rule gets wrong (#79)', () => {
  test('桂沢 binds 新桂沢（再）, the same body raised, over its stamped （元）', async () => {
    await seed([
      [KATSURA_MOTO, '157', '桂沢（元）', 1957, 43.23994853, 142.00282915],
      [KATSURA_SAI, '156', '新桂沢（再）', 2023, 43.23994853, 142.00282915],
    ]);
    await stampRow(KATSURA_MOTO, '3');
    const m = await matchMaster(KATSURAZAWA);
    expect(m?.damId).toBe(ids.get(KATSURA_SAI));
    expect(m?.damName).toBe('新桂沢（再）');
  });

  describe('遠野 and 遠野第二 each keep their own dam', () => {
    const TONO_ROWS: Row[] = [
      [TONO, '240', '遠野', 1957, 39.30618786252776, 141.5354474499182],
      [TONO2, '257', '遠野第2', 2010, 39.31945070769012, 141.52945589702117],
    ];

    test('遠野第二 binds 遠野第2 although 遠野 carries its stamp', async () => {
      await seed(TONO_ROWS);
      await stampRow(TONO, '180');
      const m = await matchMaster(TONO2_LISTING);
      expect(m?.damId).toBe(ids.get(TONO2));
      expect(m?.damName).toBe('遠野第2');
    });

    test('a run over both listings leaves one stamp on each dam', async () => {
      await seed(TONO_ROWS);
      for (const listing of [TONO_LISTING, TONO2_LISTING]) {
        const m = await matchMaster(listing);
        if (m) await bindExternalId(m.damId, 'mudam', String(listing.damsysId));
      }
      const rows = await sql<{ slug: string; mudam: string | null }[]>`
        SELECT slug, external_ids->>'mudam' AS mudam FROM dams
        WHERE slug IN ${sql([TONO, TONO2])} ORDER BY slug
      `;
      expect([...rows]).toEqual([
        { slug: TONO, mudam: '172' },
        { slug: TONO2, mudam: '180' },
      ]);
    });
  });
});
