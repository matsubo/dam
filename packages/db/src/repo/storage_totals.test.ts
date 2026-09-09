import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';
import {
  nationalStorageTotals,
  storageRate,
  storageTotalsByPref,
  storageTotalsByWatershed,
} from './storage_totals.ts';
import { upsertWatershed } from './watersheds.ts';

// The cohort under test is "dams with a fresh storage_volume observation".
// A dam without fresh data must contribute NOTHING — neither storage nor
// capacity. Summing capacity over every dam is what made /stats report a
// 全国貯水率 less than half of the home page's (2026-09-10).

const EXT_IDS = [
  'TOTALS-FRESH',
  'TOTALS-NO-OBS',
  'TOTALS-STALE',
  'TOTALS-LEVEL-ONLY',
  'TOTALS-LEVEL-NEWER',
];
const WS_CODE = 'TEST-TOTALS';
const PREF = '13';

// Far offshore so it never overlaps a real watershed polygon.
const SQUARE_OFFSHORE = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [157.0, 40.0],
        [158.0, 40.0],
        [158.0, 41.0],
        [157.0, 41.0],
        [157.0, 40.0],
      ],
    ],
  ],
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let watershedId: bigint;
let damFresh: bigint;
let damStale: bigint;
let damLevelOnly: bigint;
let damLevelNewer: bigint;

/** Totals measured before the fixtures land, so assertions are deltas. */
let base: { count: number; storage: number; capacity: number };
let basePref: { count: number; storage: number; capacity: number };

function num(v: string | null): number {
  return v === null ? 0 : Number(v);
}

async function cleanup(): Promise<void> {
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])
  `;
  for (const s of stale) {
    await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  }
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;
  await sql`DELETE FROM watersheds WHERE code = ${WS_CODE}`;
}

async function addDam(extId: string, capacity: number, slug: string): Promise<bigint> {
  const id = await upsertDamByExternalId('ndi', {
    slug,
    name: `Storage Totals ${extId}`,
    prefCode: PREF,
    watershedId,
    heightM: 30,
    lat: 40.5,
    lng: 157.5,
    externalIds: { ndi: extId },
  });
  await sql`UPDATE dams SET active_capacity_m3 = ${capacity} WHERE id = ${id}`;
  return id;
}

beforeAll(async () => {
  await cleanup();

  watershedId = await upsertWatershed({
    code: WS_CODE,
    slug: 'test-totals-watershed',
    name: 'テスト集計水系',
    kind: 'other',
    boundaryGeoJSON: SQUARE_OFFSHORE,
  });

  const beforeNational = await nationalStorageTotals();
  base = {
    count: beforeNational.observedDamCount,
    storage: num(beforeNational.storageM3),
    capacity: num(beforeNational.activeCapacityM3),
  };
  const beforePref = (await storageTotalsByPref()).get(PREF);
  basePref = {
    count: beforePref?.observedDamCount ?? 0,
    storage: num(beforePref?.storageM3 ?? null),
    capacity: num(beforePref?.activeCapacityM3 ?? null),
  };

  damFresh = await addDam('TOTALS-FRESH', 1000, 'totals-fresh');
  await addDam('TOTALS-NO-OBS', 5000, 'totals-no-obs'); // capacity, never observed
  damStale = await addDam('TOTALS-STALE', 7000, 'totals-stale');
  damLevelOnly = await addDam('TOTALS-LEVEL-ONLY', 9000, 'totals-level-only');
  damLevelNewer = await addDam('TOTALS-LEVEL-NEWER', 2000, 'totals-level-newer');

  const now = Date.now();
  await upsertObservations([
    // Counted: fresh volume.
    {
      damId: damFresh,
      observedAt: new Date(now - HOUR),
      sourceId: 'test',
      storageVolumeM3: 400,
    },
    // Not counted: the only volume is 30 days old.
    {
      damId: damStale,
      observedAt: new Date(now - 30 * DAY),
      sourceId: 'test',
      storageVolumeM3: 3000,
    },
    // Not counted: fresh, but carries no volume.
    {
      damId: damLevelOnly,
      observedAt: new Date(now - HOUR),
      sourceId: 'test',
      waterLevelM: 120.5,
    },
    // Counted at 800: the newer level-only row must not mask the volume row.
    {
      damId: damLevelNewer,
      observedAt: new Date(now - 3 * HOUR),
      sourceId: 'test',
      storageVolumeM3: 800,
    },
    {
      damId: damLevelNewer,
      observedAt: new Date(now - HOUR),
      sourceId: 'test',
      waterLevelM: 98.25,
    },
  ]);
});

afterAll(cleanup);

describe('nationalStorageTotals', () => {
  test('counts only dams with a fresh storage_volume observation', async () => {
    const t = await nationalStorageTotals();
    expect(t.observedDamCount - base.count).toBe(2);
  });

  test('sums capacity over the observed cohort only', async () => {
    const t = await nationalStorageTotals();
    // 1000 (fresh) + 2000 (level-newer). The no-obs / stale / level-only dams
    // carry 21,000 m³ of capacity between them and must not appear.
    expect(num(t.activeCapacityM3) - base.capacity).toBe(3000);
  });

  test('sums the latest fresh volume per dam', async () => {
    const t = await nationalStorageTotals();
    expect(num(t.storageM3) - base.storage).toBe(1200);
  });

  test('the resulting rate is storage over cohort capacity', async () => {
    const t = await nationalStorageTotals();
    const storage = num(t.storageM3) - base.storage;
    const capacity = num(t.activeCapacityM3) - base.capacity;
    expect(storage / capacity).toBeCloseTo(0.4, 5);
  });
});

describe('storageTotalsByPref', () => {
  test('applies the same cohort restriction per prefecture', async () => {
    const row = (await storageTotalsByPref()).get(PREF);
    expect(row).toBeDefined();
    expect((row?.observedDamCount ?? 0) - basePref.count).toBe(2);
    expect(num(row?.activeCapacityM3 ?? null) - basePref.capacity).toBe(3000);
    expect(num(row?.storageM3 ?? null) - basePref.storage).toBe(1200);
  });
});

describe('storageTotalsByWatershed', () => {
  test('keys totals by watershed slug, cohort-restricted', async () => {
    const row = (await storageTotalsByWatershed()).get('test-totals-watershed');
    expect(row).toBeDefined();
    expect(row?.observedDamCount).toBe(2);
    expect(num(row?.activeCapacityM3 ?? null)).toBe(3000);
    expect(num(row?.storageM3 ?? null)).toBe(1200);
  });

  test('omits watersheds whose dams have no fresh data', async () => {
    // Drop the two counted dams' observations → the watershed disappears.
    for (const id of [damFresh, damLevelNewer]) {
      await sql`DELETE FROM observations WHERE dam_id = ${id}`;
    }
    const row = (await storageTotalsByWatershed()).get('test-totals-watershed');
    expect(row).toBeUndefined();
  });
});

describe('storageRate', () => {
  test('divides storage by cohort capacity', () => {
    expect(
      storageRate({ observedDamCount: 2, storageM3: '1200', activeCapacityM3: '3000' }),
    ).toBeCloseTo(0.4, 5);
  });

  test('is null for an empty cohort', () => {
    expect(
      storageRate({ observedDamCount: 0, storageM3: null, activeCapacityM3: null }),
    ).toBeNull();
    expect(storageRate(undefined)).toBeNull();
  });

  test('is null when capacity is zero rather than dividing by it', () => {
    expect(storageRate({ observedDamCount: 1, storageM3: '10', activeCapacityM3: '0' })).toBeNull();
  });
});
