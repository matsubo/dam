import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import {
  bindStation,
  type CatalogueDam,
  type DamCollection,
  matchOne,
  parseDamCollection,
  writeMatchReview,
} from './match_kasenbosai.ts';

const OBS_FCD = 'TEST-MATCH-REVIEW-001';
let damA: bigint;
let damB: bigint;

async function insertDam(slug: string): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (slug, name, pref_code, location, external_ids)
    VALUES (${slug}, ${slug}, '13',
            ST_SetSRID(ST_MakePoint(139.5, 35.7), 4326)::geography, '{}'::jsonb)
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('insert dam failed');
  return id;
}

/**
 * Open ocean south-east of Honshu — deliberately far from every real master row
 * so the proximity query returns only what a test inserts.
 */
const EMPTY_LON = 145.0;
const EMPTY_LAT = 30.0;
/** ~62 m north of (EMPTY_LON, EMPTY_LAT): 1° of latitude is ~111 km. */
const NEARBY_LAT = EMPTY_LAT + 0.00056;

async function insertDamAt(
  slug: string,
  name: string,
  prefCode: string,
  lon: number,
  lat: number,
): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (slug, name, pref_code, location, external_ids)
    VALUES (${slug}, ${name}, ${prefCode},
            ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, '{}'::jsonb)
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('insert dam failed');
  return id;
}

beforeAll(async () => {
  await sql`DELETE FROM match_review WHERE source_external_id = ${OBS_FCD}`;
  await sql`DELETE FROM dams WHERE slug IN ('mr-test-a', 'mr-test-b')`;
  damA = await insertDam('mr-test-a');
  damB = await insertDam('mr-test-b');
});

afterAll(async () => {
  await sql`DELETE FROM match_review WHERE source_external_id = ${OBS_FCD}`;
  await sql`DELETE FROM dams WHERE id IN (${damA}, ${damB})`;
});

describe('writeMatchReview', () => {
  test('persists a multi-candidate bigint[] without a cast error', async () => {
    // Regression: a bigint[] param used to fail with
    // "cannot cast type bigint to bigint[]" because the client's custom
    // bigint parser mis-serialized the array.
    await writeMatchReview(
      {
        obsFcd: OBS_FCD,
        obsNm: 'テストダム',
        ofcCd: 1234,
        lat: 35.7,
        lon: 139.5,
        kbPrefCd: 1301,
      },
      {
        obsFcd: OBS_FCD,
        obsNm: 'テストダム',
        damId: damA,
        damName: 'mr-test-a',
        distanceM: 120,
        score: 0.65,
        reason: 'trigram',
        candidates: [
          { id: damA, name: 'mr-test-a', distanceM: 120 },
          { id: damB, name: 'mr-test-b', distanceM: 300 },
        ],
      },
    );

    const rows = await sql<{ candidate_dam_ids: bigint[]; best_dam_id: bigint }[]>`
      SELECT candidate_dam_ids, best_dam_id FROM match_review
      WHERE source_id = 'kasenbosai' AND source_external_id = ${OBS_FCD}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.candidate_dam_ids.map(String).sort()).toEqual([damA, damB].map(String).sort());
    expect(String(rows[0]?.best_dam_id)).toBe(String(damA));
  });

  test('handles a single-candidate array', async () => {
    await writeMatchReview(
      { obsFcd: OBS_FCD, obsNm: 'テスト', ofcCd: 1, lat: 35.7, lon: 139.5, kbPrefCd: 1301 },
      {
        obsFcd: OBS_FCD,
        obsNm: 'テスト',
        damId: null,
        damName: null,
        distanceM: null,
        score: 0.4,
        reason: 'distance',
        candidates: [{ id: damB, name: 'mr-test-b', distanceM: 450 }],
      },
    );
    const rows = await sql<{ candidate_dam_ids: bigint[] }[]>`
      SELECT candidate_dam_ids FROM match_review
      WHERE source_external_id = ${OBS_FCD}
    `;
    // ON CONFLICT updated the same row (resolved_dam_id still NULL).
    expect(rows[0]?.candidate_dam_ids.map(String)).toEqual([String(damB)]);
  });
});

describe('matchOne — candidate query', () => {
  const SLUGS = ['xpref-test-master', 'xpref-test-decoy'];

  beforeEach(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });

  test('binds an exact name whose master sits in another prefecture', async () => {
    // The 奥只見 case: MLIT files the station under 福島 (kbPrefCd 701 → JIS 07)
    // while the master row is 新潟 (15). A prefecture predicate in the candidate
    // query used to drop the row before it was ever scored, leaving Japan's
    // largest reservoir with no observations at all.
    const id = await insertDamAt(SLUGS[0] as string, '境界試験', '15', EMPTY_LON, NEARBY_LAT);
    const m = await matchOne({
      obsFcd: 'TEST-XPREF-001',
      obsNm: '境界試験ダム',
      ofcCd: 0,
      lat: EMPTY_LAT,
      lon: EMPTY_LON,
      kbPrefCd: 701,
    });
    expect(String(m.damId)).toBe(String(id));
    expect(m.reason).toBe('exact-name-cross-pref');
    expect(m.distanceM ?? 0).toBeLessThan(100);
  });

  test('a same-prefecture exact name still outranks the cross-prefecture one', async () => {
    await insertDamAt(SLUGS[1] as string, '境界試験', '15', EMPTY_LON, NEARBY_LAT);
    const samePref = await insertDamAt(
      SLUGS[0] as string,
      '境界試験',
      '07',
      EMPTY_LON,
      EMPTY_LAT + 0.002, // ~222 m — further away, but the right prefecture
    );
    const m = await matchOne({
      obsFcd: 'TEST-XPREF-002',
      obsNm: '境界試験ダム',
      ofcCd: 0,
      lat: EMPTY_LAT,
      lon: EMPTY_LON,
      kbPrefCd: 701,
    });
    expect(String(m.damId)).toBe(String(samePref));
    expect(m.reason).toBe('exact-name');
  });
});

describe('（元）/（再） twins share one station', () => {
  // 長野's dam file from the 2026-09-27 16:20 JST snapshot, trimmed to 美和ダム
  // and two neighbours. The twin rows below copy the local master: same point
  // 248 m from the station, both completed 2023.
  const FIXTURE = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'tests/fixtures/kasenbosai/obs_dam_2001_2026-09-27.json',
  );
  const MIWA_FCD = '2183100700002';
  const SLUGS = ['kb79-test-miwa-moto', 'kb79-test-miwa-sai'];

  async function insertTwin(slug: string, name: string, stamp: string | null): Promise<bigint> {
    const ids = stamp == null ? {} : { kasenbosai: stamp };
    const rows = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, completed_year, location, external_ids)
      VALUES (${slug}, ${name}, '20', 2023,
              ST_SetSRID(ST_MakePoint(138.07926446300007, 35.81380310600008), 4326)::geography,
              ${sql.json(ids)})
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('insert dam failed');
    return id;
  }

  async function stampOf(id: bigint): Promise<string | null> {
    const rows = await sql<{ k: string | null }[]>`
      SELECT external_ids->>'kasenbosai' AS k FROM dams WHERE id = ${id}
    `;
    return rows[0]?.k ?? null;
  }

  async function miwaStation(): Promise<CatalogueDam> {
    const fc = JSON.parse(await readFile(FIXTURE, 'utf8')) as DamCollection;
    const station = parseDamCollection(fc, 2001).find((d) => d.obsFcd === MIWA_FCD);
    if (!station) throw new Error('美和ダム missing from fixture');
    return station;
  }

  beforeEach(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });

  test('a run clears the stamp both twins picked up and keeps the completed （再）', async () => {
    // The state #79 found on 美和, 横山, 南畑, 天ヶ瀬, 松原: earlier runs each
    // picked whichever twin the distance-ordered query returned first, and
    // stamps were only ever added. （元） is inserted first so it leads the tie.
    const moto = await insertTwin(SLUGS[0] as string, '美和（元）', MIWA_FCD);
    const sai = await insertTwin(SLUGS[1] as string, '美和（再）', MIWA_FCD);

    const m = await matchOne(await miwaStation());
    expect(String(m.damId)).toBe(String(sai));
    expect(m.reason).toBe('exact-name');
    if (m.damId == null) throw new Error('unmatched');

    expect(await bindStation(m.damId, MIWA_FCD)).toBe(false); // already on （再）
    expect(await stampOf(sai)).toBe(MIWA_FCD);
    expect(await stampOf(moto)).toBeNull();
  });

  test('a stamp left on the （元） moves to the （再）', async () => {
    const moto = await insertTwin(SLUGS[0] as string, '美和（元）', MIWA_FCD);
    const sai = await insertTwin(SLUGS[1] as string, '美和（再）', null);

    const m = await matchOne(await miwaStation());
    if (m.damId == null) throw new Error('unmatched');
    expect(await bindStation(m.damId, MIWA_FCD)).toBe(true);
    expect(await stampOf(sai)).toBe(MIWA_FCD);
    expect(await stampOf(moto)).toBeNull();
  });
});
