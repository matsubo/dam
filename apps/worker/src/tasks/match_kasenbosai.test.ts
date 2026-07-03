import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { writeMatchReview } from './match_kasenbosai.ts';

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
