import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';
import { damSeasonalNorm, watershedSeasonalNorm } from './seasonal.ts';
import { upsertWatershed } from './watersheds.ts';

const SQUARE_OFFSHORE = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [150.0, 44.0],
        [151.0, 44.0],
        [151.0, 45.0],
        [150.0, 45.0],
        [150.0, 44.0],
      ],
    ],
  ],
};

const EXT_IDS = ['NORM-TEST-A', 'NORM-TEST-B'];

let watershedId: bigint;
let damA: bigint; // history (2 seasons) + fresh observation
let damB: bigint; // fresh observation only, no history

const DAY_MS = 24 * 3600 * 1000;

async function cleanup(): Promise<void> {
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])
  `;
  for (const s of stale) {
    await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  }
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;
  await sql`DELETE FROM watersheds WHERE code = 'TEST-NORM'`;
}

beforeAll(async () => {
  await cleanup();
  watershedId = await upsertWatershed({
    code: 'TEST-NORM',
    slug: 'test-norm',
    name: 'Seasonal Norm Test',
    kind: 'first',
    boundaryGeoJSON: SQUARE_OFFSHORE,
    areaKm2: 100,
  });
  const mkDam = (suffix: 'A' | 'B', lat: number) =>
    upsertDamByExternalId('ndi', {
      slug: `norm-test-${suffix.toLowerCase()}`,
      name: `Norm Test ${suffix}`,
      prefCode: '13',
      watershedId,
      lat,
      lng: 150.5,
      externalIds: { ndi: `NORM-TEST-${suffix}` },
    });
  damA = await mkDam('A', 44.1);
  damB = await mkDam('B', 44.2);

  const now = Date.now();
  const obs = [];
  // Dam A history: 3 daily points around this date last year (vol 1000) and
  // the year before (vol 1200) → seasonal norm = 1100.
  for (const offsetD of [364, 365, 366]) {
    obs.push({
      damId: damA,
      observedAt: new Date(now - offsetD * DAY_MS),
      sourceId: 'test',
      storageVolumeM3: 1000,
      qualityFlag: 0,
    });
  }
  for (const offsetD of [729, 730, 731]) {
    obs.push({
      damId: damA,
      observedAt: new Date(now - offsetD * DAY_MS),
      sourceId: 'test',
      storageVolumeM3: 1200,
      qualityFlag: 0,
    });
  }
  // Fresh observations (the "current" side).
  obs.push({
    damId: damA,
    observedAt: new Date(now - 3600 * 1000),
    sourceId: 'test',
    storageVolumeM3: 550,
    qualityFlag: 0,
  });
  obs.push({
    damId: damB,
    observedAt: new Date(now - 3600 * 1000),
    sourceId: 'test',
    storageVolumeM3: 999,
    qualityFlag: 0,
  });
  await upsertObservations(obs);
  // obs_daily is a continuous aggregate; the refresh policy only covers the
  // last 60 days, so materialize the historical buckets explicitly. Bound the
  // window to the seeded range — a NULL,NULL refresh over a well-populated
  // local DB can blow the 5 s hook timeout.
  await sql.unsafe(
    `CALL refresh_continuous_aggregate('obs_daily', NOW() - INTERVAL '800 days', NOW() - INTERVAL '61 days')`,
  );
});

afterAll(cleanup);

describe('damSeasonalNorm', () => {
  test('averages the same-season buckets of past years', async () => {
    const n = await damSeasonalNorm(damA);
    expect(n).not.toBeNull();
    expect(Number(n?.normVolumeM3)).toBeCloseTo(1100, 3);
    expect(Number(n?.currentVolumeM3)).toBe(550);
    expect(n?.years).toBe(2);
  });

  test('no history → null', async () => {
    expect(await damSeasonalNorm(damB)).toBeNull();
  });
});

describe('watershedSeasonalNorm', () => {
  test('sums only dams that have BOTH a fresh observation and history', async () => {
    const n = await watershedSeasonalNorm(watershedId);
    expect(n).not.toBeNull();
    // Dam B (no history) must not contribute to either side.
    expect(Number(n?.currentVolumeM3)).toBe(550);
    expect(Number(n?.normVolumeM3)).toBeCloseTo(1100, 3);
    expect(n?.damCount).toBe(1);
  });
});
