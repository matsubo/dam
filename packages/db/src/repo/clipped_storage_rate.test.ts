import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { latestObservation, latestRateByDam, upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';
import { upsertWatershed } from './watersheds.ts';

// Issue #38 §2-3: `effectiveActiveCapacityM3` came back LARGER than the dam's
// annual `activeCapacityM3` for 18 dams. Two very different causes hide behind
// that one symptom, and only the first is a defect.
//
//  1. The 0036 trigger filled a missing storage_rate with
//     LEAST(1.5, volume/active_capacity). Back-solving an *unclipped* trigger
//     value is an identity — volume/(volume/cap) = cap — so only the clip
//     misbehaves: on a trusted source it back-solves to volume/1.5
//     (屈足 844,000 → 1,922,000). Migration 0047 makes the trigger return NULL
//     there instead.
//  2. Offset-formula dams, where the manager publishes
//     (volume − floor)/capacity (早明浦, 岩尾内), and dams whose ダム便覧
//     capacity is understated. Their denominator legitimately exceeds
//     activeCapacityM3, and it is the denominator the manager's own published
//     貯水率 was computed against — clamping it would silently replace that
//     rate with a different number.

const SQUARE_OFFSHORE = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [152.0, 40.0],
        [153.0, 40.0],
        [153.0, 41.0],
        [152.0, 41.0],
        [152.0, 40.0],
      ],
    ],
  ],
};

const EXT_IDS = ['CLIP-TEST-A', 'CLIP-TEST-B'];
// One of the sources migration 0040 marks trusted_rate_basis.
const TRUSTED_SOURCE = 'niigata-bousai';

// 屈足ダム's shape: stored volume is 3.4x the master capacity.
const CLIPPED_CAPACITY = 844_000;
const CLIPPED_VOLUME = 2_883_000;

// 早明浦ダム's shape: the manager subtracts a floor before dividing, so the
// implied denominator (406,461,538) sits above the annual 289,000,000.
const OFFSET_CAPACITY = 289_000_000;
const OFFSET_VOLUME = 200_000_000;
const OFFSET_RATE = 0.4921;

let watershedId: bigint;
let damClipped: bigint;
let damOffset: bigint;

async function cleanup(): Promise<void> {
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])
  `;
  for (const s of stale) {
    await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  }
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;
  await sql`DELETE FROM watersheds WHERE code = 'TEST-CLIP'`;
}

beforeAll(async () => {
  await cleanup();
  watershedId = await upsertWatershed({
    code: 'TEST-CLIP',
    slug: 'test-clip',
    name: 'Clip Test',
    kind: 'first',
    boundaryGeoJSON: SQUARE_OFFSHORE,
    areaKm2: 100,
  });

  const mkDam = (suffix: 'A' | 'B', lat: number) =>
    upsertDamByExternalId('ndi', {
      slug: `clip-test-${suffix.toLowerCase()}`,
      name: `Clip Test ${suffix}`,
      prefCode: '13',
      watershedId,
      lat,
      lng: 152.5,
      externalIds: { ndi: `CLIP-TEST-${suffix}` },
    });
  damClipped = await mkDam('A', 40.1);
  damOffset = await mkDam('B', 40.2);

  await sql`UPDATE dams SET active_capacity_m3 = ${CLIPPED_CAPACITY} WHERE id = ${damClipped}`;
  await sql`UPDATE dams SET active_capacity_m3 = ${OFFSET_CAPACITY} WHERE id = ${damOffset}`;

  const now = Date.now();
  await upsertObservations([
    {
      damId: damClipped,
      observedAt: new Date(now - 3600 * 1000),
      sourceId: TRUSTED_SOURCE,
      storageVolumeM3: CLIPPED_VOLUME,
      // Upstream published no usable rate — exactly the case the 0036 trigger
      // steps into.
      storageRate: null,
      qualityFlag: 0,
    },
    {
      damId: damOffset,
      observedAt: new Date(now - 3600 * 1000),
      sourceId: TRUSTED_SOURCE,
      storageVolumeM3: OFFSET_VOLUME,
      storageRate: OFFSET_RATE,
      qualityFlag: 0,
    },
  ]);
});

afterAll(cleanup);

describe('the storage_rate trigger no longer fabricates a clipped rate', () => {
  test('leaves storage_rate NULL when the volume exceeds 1.5x the capacity', async () => {
    const obs = await latestObservation(damClipped);
    expect(obs?.storageRate).toBeNull();
  });

  test('the denominator falls back to the annual capacity instead of volume/1.5', async () => {
    const obs = await latestObservation(damClipped);
    // The old clip back-solved 2,883,000 / 1.5 = 1,922,000.
    expect(Number(obs?.effectiveActiveCapacityM3)).toBe(CLIPPED_CAPACITY);
  });

  test('still derives a rate for an ordinary volume', async () => {
    const rows = await sql<{ rate: string | null }[]>`
      SELECT (
        SELECT storage_rate::TEXT FROM observations
        WHERE dam_id = ${damClipped} ORDER BY observed_at DESC LIMIT 1
      ) AS rate
      FROM (SELECT 1) _
    `;
    // Sanity: the NULL above is about the clip, not about the trigger being off.
    await upsertObservations([
      {
        damId: damClipped,
        observedAt: new Date(Date.now() - 1800 * 1000),
        sourceId: TRUSTED_SOURCE,
        storageVolumeM3: CLIPPED_CAPACITY / 2,
        storageRate: null,
        qualityFlag: 0,
      },
    ]);
    const obs = await latestObservation(damClipped);
    expect(rows).toHaveLength(1);
    expect(Number(obs?.storageRate)).toBeCloseTo(0.5, 4);
  });
});

describe('an offset-formula denominator above the annual capacity is kept', () => {
  test('effectiveActiveCapacityM3 stays as the manager implied it', async () => {
    const obs = await latestObservation(damOffset);
    expect(Number(obs?.effectiveActiveCapacityM3)).toBeCloseTo(OFFSET_VOLUME / OFFSET_RATE, 0);
  });

  test("the displayed rate is still the manager's own", async () => {
    const m = await latestRateByDam([damOffset]);
    // Clamping the denominator to 289,000,000 would show 69.2 % here.
    expect(m.get(damOffset.toString()) ?? Number.NaN).toBeCloseTo(OFFSET_RATE, 4);
  });
});
