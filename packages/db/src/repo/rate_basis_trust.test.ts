import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import {
  latestObservation,
  latestRateAndSourceByDam,
  latestRateByDam,
  upsertDamByExternalId,
} from './dams.ts';
import { upsertObservations } from './observations.ts';
import {
  aggregateWatershed,
  driestWatersheds,
  ratesForWatersheds,
  upsertWatershed,
} from './watersheds.ts';

// issue #17: dams.active_capacity_m3 is a single static, non-seasonal 利水容量
// value from Damnet. Flood-control dams (e.g. 八田原ダム) actually operate
// under a much smaller 洪水期 capacity, so storage_volume_m3/active_capacity_m3
// understates their real 貯水率. Some upstream sources (source_priorities
// .trusted_rate_basis = true) already report a correct, season-aware
// 利水容量-based rate on the observation itself — these tests mirror the real
// 八田原ダム numbers (2,230万m3 stored, static capacity 5,700万m3, real rate
// 97.3%) at a smaller scale to keep fixture values readable.

const SQUARE_OFFSHORE = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [150.0, 40.0],
        [151.0, 40.0],
        [151.0, 41.0],
        [150.0, 41.0],
        [150.0, 40.0],
      ],
    ],
  ],
};

const EXT_IDS = ['TRUST-TEST-A', 'TRUST-TEST-B'];
// 'niigata-bousai' is one of the sources migration 0040 marks trusted_rate_basis.
const TRUSTED_SOURCE = 'niigata-bousai';
const UNTRUSTED_SOURCE = 'test';

let watershedId: bigint;
let damTrusted: bigint; // static capacity is stale/wrong; source reports the correct rate
let damUntrusted: bigint; // static capacity is correct; source is not on the trust list

async function cleanup(): Promise<void> {
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])
  `;
  for (const s of stale) {
    await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  }
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;
  await sql`DELETE FROM watersheds WHERE code = 'TEST-TRUST'`;
}

beforeAll(async () => {
  await cleanup();
  watershedId = await upsertWatershed({
    code: 'TEST-TRUST',
    slug: 'test-trust',
    name: 'Trust Test',
    kind: 'first',
    boundaryGeoJSON: SQUARE_OFFSHORE,
    areaKm2: 100,
  });

  const mkDam = (suffix: 'A' | 'B', lat: number) =>
    upsertDamByExternalId('ndi', {
      slug: `trust-test-${suffix.toLowerCase()}`,
      name: `Trust Test ${suffix}`,
      prefCode: '13',
      watershedId,
      lat,
      lng: 150.5,
      externalIds: { ndi: `TRUST-TEST-${suffix}` },
    });
  damTrusted = await mkDam('A', 40.1);
  damUntrusted = await mkDam('B', 40.2);

  // Both dams carry the SAME static active_capacity_m3, deliberately stale/
  // wrong for damTrusted (mirrors 八田原ダム's non-seasonal Damnet figure) but
  // correct for damUntrusted (mirrors an ordinary dam with no seasonal quirk).
  await sql`
    UPDATE dams SET active_capacity_m3 = 5700
    WHERE id IN (${damTrusted}, ${damUntrusted})
  `;

  const now = Date.now();
  await upsertObservations([
    {
      damId: damTrusted,
      observedAt: new Date(now - 3600 * 1000),
      sourceId: TRUSTED_SOURCE,
      storageVolumeM3: 2230,
      storageRate: 0.973, // trusted source's own season-aware 利水容量ベース rate
      qualityFlag: 0,
    },
    {
      damId: damUntrusted,
      observedAt: new Date(now - 3600 * 1000),
      sourceId: UNTRUSTED_SOURCE,
      storageVolumeM3: 2230,
      storageRate: 0.973, // same stored rate, but this source is NOT trusted
      qualityFlag: 0,
    },
  ]);
});

afterAll(cleanup);

describe('trusted native storage_rate overrides static active_capacity_m3', () => {
  test('latestRateAndSourceByDam uses the trusted rate, not volume/active_capacity_m3', async () => {
    const m = await latestRateAndSourceByDam([damTrusted, damUntrusted]);
    // 2230/5700 ≈ 0.3912 would be the wrong, naive value — the trusted rate (0.973) must win.
    expect(m.get(damTrusted.toString())?.rate ?? Number.NaN).toBeCloseTo(0.973, 5);
    // Untrusted source: same stored storage_rate must be IGNORED; falls back to volume/active_capacity_m3.
    expect(m.get(damUntrusted.toString())?.rate ?? Number.NaN).toBeCloseTo(2230 / 5700, 5);
  });

  test('latestRateByDam mirrors the same trust logic', async () => {
    const m = await latestRateByDam([damTrusted, damUntrusted]);
    expect(m.get(damTrusted.toString()) ?? Number.NaN).toBeCloseTo(0.973, 5);
    expect(m.get(damUntrusted.toString()) ?? Number.NaN).toBeCloseTo(2230 / 5700, 5);
  });

  test('latestObservation exposes an effectiveActiveCapacityM3 back-solved from the trusted rate', async () => {
    const obs = await latestObservation(damTrusted);
    // capacity implied by the trusted rate: 2230/0.973 ≈ 2292.4 — NOT the static 5700.
    expect(Number(obs?.effectiveActiveCapacityM3) ?? Number.NaN).toBeCloseTo(2230 / 0.973, 1);

    const untrustedObs = await latestObservation(damUntrusted);
    expect(Number(untrustedObs?.effectiveActiveCapacityM3) ?? Number.NaN).toBe(5700);
  });

  test('aggregateWatershed sums the trust-adjusted capacity across the cohort', async () => {
    const agg = await aggregateWatershed(watershedId);
    const expectedCap = 2230 / 0.973 + 5700; // trusted dam's implied cap + untrusted dam's static cap
    expect(agg.observedDamCount).toBe(2);
    expect(Number(agg.latestStorageVolumeM3)).toBe(2230 + 2230);
    expect(Number(agg.observedActiveCapacityM3)).toBeCloseTo(expectedCap, 1);
  });

  test('ratesForWatersheds reflects the same corrected combined rate', async () => {
    const m = await ratesForWatersheds([watershedId]);
    const expectedCap = 2230 / 0.973 + 5700;
    const expectedRate = (2230 + 2230) / expectedCap;
    expect(m.get(watershedId.toString()) ?? Number.NaN).toBeCloseTo(expectedRate, 5);
  });

  test('driestWatersheds computes rate with the same trust-adjusted denominator', async () => {
    const rows = await driestWatersheds(500, 1);
    const row = rows.find((r) => r.slug === 'test-trust');
    const expectedCap = 2230 / 0.973 + 5700;
    const expectedRate = (2230 + 2230) / expectedCap;
    expect(row?.rate ?? Number.NaN).toBeCloseTo(expectedRate, 5);
    expect(row?.observedDamCount).toBe(2);
  });
});
