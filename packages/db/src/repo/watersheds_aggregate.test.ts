import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';
import { aggregateWatershed, ratesForWatersheds, upsertWatershed } from './watersheds.ts';

// Far offshore square so it never collides with real watershed polygons.
const SQUARE_OFFSHORE = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [155.0, 40.0],
        [156.0, 40.0],
        [156.0, 41.0],
        [155.0, 41.0],
        [155.0, 40.0],
      ],
    ],
  ],
};

const EXT_IDS = ['AGG-TEST-A', 'AGG-TEST-B', 'AGG-TEST-C'];

let watershedId: bigint;
let damA: bigint; // fresh observation
let damB: bigint; // no observation at all
let damC: bigint; // stale observation (30 days old)

async function cleanup(): Promise<void> {
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])
  `;
  for (const s of stale) {
    await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  }
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;
  await sql`DELETE FROM watersheds WHERE code = 'TEST-AGG'`;
}

beforeAll(async () => {
  await cleanup();
  watershedId = await upsertWatershed({
    code: 'TEST-AGG',
    slug: 'test-agg',
    name: 'Aggregate Test',
    kind: 'first',
    boundaryGeoJSON: SQUARE_OFFSHORE,
    areaKm2: 100,
  });

  const mkDam = (suffix: 'A' | 'B' | 'C', lat: number) =>
    upsertDamByExternalId('ndi', {
      slug: `agg-test-${suffix.toLowerCase()}`,
      name: `Agg Test ${suffix}`,
      prefCode: '13',
      watershedId,
      lat,
      lng: 155.5,
      externalIds: { ndi: `AGG-TEST-${suffix}` },
    });
  damA = await mkDam('A', 40.1);
  damB = await mkDam('B', 40.2);
  damC = await mkDam('C', 40.3);

  // All three dams are rate-able (active capacity present).
  await sql`
    UPDATE dams SET active_capacity_m3 = 1000
    WHERE id IN (${damA}, ${damB}, ${damC})
  `;

  const now = Date.now();
  await upsertObservations([
    {
      damId: damA,
      observedAt: new Date(now - 3600 * 1000),
      sourceId: 'test',
      storageVolumeM3: 800,
      qualityFlag: 0,
    },
    {
      damId: damC,
      observedAt: new Date(now - 30 * 24 * 3600 * 1000),
      sourceId: 'test',
      storageVolumeM3: 1000,
      qualityFlag: 0,
    },
  ]);
});

afterAll(cleanup);

describe('ratesForWatersheds cohort alignment', () => {
  test('denominator only counts dams with a fresh observation', async () => {
    // Dam A: 800 / 1000 fresh. Dam B has no data, dam C is 30 days stale —
    // neither may inflate the denominator. Buggy behavior returned
    // 1800/3000 = 0.6 (stale included) or 800/3000 ≈ 0.27.
    const m = await ratesForWatersheds([watershedId]);
    const rate = m.get(watershedId.toString());
    expect(rate ?? Number.NaN).toBeCloseTo(0.8, 5);
  });
});

describe('aggregateWatershed cohort alignment', () => {
  test('exposes observed cohort and matching capacity denominator', async () => {
    const agg = await aggregateWatershed(watershedId);
    expect(agg.damCount).toBe(3);
    expect(agg.rateableDamCount).toBe(3);
    // Only dam A observed within the freshness window.
    expect(agg.observedDamCount).toBe(1);
    expect(Number(agg.observedActiveCapacityM3)).toBe(1000);
    expect(Number(agg.latestStorageVolumeM3)).toBe(800);
  });

  test('no fresh observations → null volume, zero observed cohort', async () => {
    // A watershed whose only data is stale must not report a rate at all.
    await sql`DELETE FROM observations WHERE dam_id = ${damA}`;
    try {
      const agg = await aggregateWatershed(watershedId);
      expect(agg.observedDamCount).toBe(0);
      expect(agg.latestStorageVolumeM3).toBeNull();
      const m = await ratesForWatersheds([watershedId]);
      expect(m.get(watershedId.toString()) ?? null).toBeNull();
    } finally {
      await upsertObservations([
        {
          damId: damA,
          observedAt: new Date(Date.now() - 3600 * 1000),
          sourceId: 'test',
          storageVolumeM3: 800,
          qualityFlag: 0,
        },
      ]);
    }
  });
});
