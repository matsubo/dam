import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';
import { driestWatersheds, upsertWatershed } from './watersheds.ts';

// Two offshore test watersheds: LOW (rate ~0.2) and HIGH (rate ~0.9), each
// with 3 rate-able dams that carry a fresh observation, so both clear the
// minReal filter and driestWatersheds returns LOW before HIGH.

const SQUARE = (lng: number, lat: number) => ({
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [lng, lat],
        [lng + 1, lat],
        [lng + 1, lat + 1],
        [lng, lat + 1],
        [lng, lat],
      ],
    ],
  ],
});

const EXT = ['DW-L1', 'DW-L2', 'DW-L3', 'DW-H1', 'DW-H2', 'DW-H3'];
let lowId: bigint;
let highId: bigint;

async function cleanup(): Promise<void> {
  const rows = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT}::text[])
  `;
  for (const r of rows) await sql`DELETE FROM observations WHERE dam_id = ${r.id}`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT}::text[])`;
  await sql`DELETE FROM watersheds WHERE code IN ('DW-LOW', 'DW-HIGH')`;
}

beforeAll(async () => {
  await cleanup();
  lowId = await upsertWatershed({
    code: 'DW-LOW',
    slug: 'dw-low',
    name: 'Driest Low',
    kind: 'first',
    boundaryGeoJSON: SQUARE(150, 30),
  });
  highId = await upsertWatershed({
    code: 'DW-HIGH',
    slug: 'dw-high',
    name: 'Driest High',
    kind: 'first',
    boundaryGeoJSON: SQUARE(152, 30),
  });

  const now = Date.now();
  const seed = async (wid: bigint, exts: string[], volEach: number) => {
    for (let i = 0; i < exts.length; i++) {
      const id = await upsertDamByExternalId('ndi', {
        slug: `dw-${exts[i]?.toLowerCase()}`,
        name: `DW ${exts[i]}`,
        prefCode: '13',
        watershedId: wid,
        lat: 30.5,
        lng: wid === lowId ? 150.5 : 152.5,
        externalIds: { ndi: exts[i] as string },
      });
      await sql`UPDATE dams SET active_capacity_m3 = 1000 WHERE id = ${id}`;
      await upsertObservations([
        {
          damId: id,
          observedAt: new Date(now - 3600_000),
          sourceId: 'test',
          storageVolumeM3: volEach,
          qualityFlag: 0,
        },
      ]);
    }
  };
  await seed(lowId, ['DW-L1', 'DW-L2', 'DW-L3'], 200); // 200/1000 = 0.2
  await seed(highId, ['DW-H1', 'DW-H2', 'DW-H3'], 900); // 0.9
});

afterAll(cleanup);

describe('driestWatersheds', () => {
  test('returns lowest-rate systems first, respecting minReal', async () => {
    const rows = await driestWatersheds(50, 3);
    const low = rows.find((r) => r.slug === 'dw-low');
    const high = rows.find((r) => r.slug === 'dw-high');
    expect(low).toBeTruthy();
    expect(high).toBeTruthy();
    expect(low?.rate).toBeCloseTo(0.2, 5);
    expect(high?.rate).toBeCloseTo(0.9, 5);
    // LOW must sort before HIGH.
    const li = rows.findIndex((r) => r.slug === 'dw-low');
    const hi = rows.findIndex((r) => r.slug === 'dw-high');
    expect(li).toBeLessThan(hi);
  });

  test('minObserved filter excludes systems with too few rate-able dams', async () => {
    // Require 4 rate-able dams — our systems have only 3, so neither appears.
    const rows = await driestWatersheds(50, 4);
    expect(rows.some((r) => r.slug === 'dw-low' || r.slug === 'dw-high')).toBe(false);
  });

  test('limit caps the result count', async () => {
    const rows = await driestWatersheds(1, 3);
    expect(rows.length).toBe(1);
  });
});
