// docs/adr/0002: every view of a dam at a moment shows the same reading and
// divides by its effective capacity. Before, five pick rules existed; 平年比
// and 全国 took the newest row while the dam page preferred a trusted one,
// and 全国 divided by the static 有効貯水容量.
//
// The fixture makes every shortcut visible: the newest row is empty, the
// newest row with a value is untrusted, and the reading is a trusted row two
// hours old whose own rate implies a capacity (4,000,000) that is not the
// master's (5,000,000).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import {
  latestObservation,
  latestRateAndSourceByDam,
  latestRateByDam,
  lowStorageDams,
  storageChange,
  upsertDamByExternalId,
} from './dams.ts';
import { damSeasonalNorm, watershedSeasonalNorm } from './seasonal.ts';
import { storageTotalsByWatershed } from './storage_totals.ts';
import {
  aggregateWatershed,
  driestWatersheds,
  ratesForWatersheds,
  upsertWatershed,
  watershedStorageChange,
} from './watersheds.ts';

const TRUSTED = 'kasenbosai';
const UNTRUSTED = 'hkd-mlit-dam';
const HISTORY = 'test';
const SLUG = 'reading-views-test';
const NDI = 'READING-VIEWS';
const WS_CODE = 'TEST-READING-VIEWS';
const WS_SLUG = 'test-reading-views';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const VOLUME = 2_000_000;
const EFFECTIVE = 4_000_000;
const historyWindow = `NOW() - INTERVAL '800 days', NOW() - INTERVAL '61 days'`;

let watershedId: bigint;
let damId: bigint;

async function cleanup(): Promise<void> {
  await sql`
    DELETE FROM observations WHERE dam_id IN (
      SELECT id FROM dams WHERE external_ids ->> 'ndi' = ${NDI}
    )`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ${NDI}`;
  await sql`DELETE FROM watersheds WHERE code = ${WS_CODE}`;
}

beforeAll(async () => {
  await cleanup();
  for (const id of [TRUSTED, UNTRUSTED]) {
    const [row] = await sql<{ trusted: boolean }[]>`
      SELECT trusted_rate_basis AS trusted FROM source_priorities WHERE source_id = ${id}
    `;
    expect(row?.trusted).toBe(id === TRUSTED);
  }
  watershedId = await upsertWatershed({
    code: WS_CODE,
    slug: WS_SLUG,
    name: 'Reading Views Test',
    kind: 'other',
    // Far offshore so it never overlaps a real watershed polygon.
    boundaryGeoJSON: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [162.0, 30.0],
            [163.0, 30.0],
            [163.0, 31.0],
            [162.0, 31.0],
            [162.0, 30.0],
          ],
        ],
      ],
    },
  });
  damId = await upsertDamByExternalId('ndi', {
    slug: SLUG,
    name: 'Reading Views Test',
    prefCode: '13',
    watershedId,
    lat: 30.5,
    lng: 162.5,
    externalIds: { ndi: NDI },
  });
  await sql`UPDATE dams SET active_capacity_m3 = 5000000 WHERE id = ${damId}`;

  const c = new Date(Math.floor(Date.now() / HOUR) * HOUR - HOUR);
  await sql`
    INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
    VALUES
      (${damId}, ${new Date(c.getTime() - 2 * HOUR)}, ${TRUSTED},   ${VOLUME}, 0.5),
      (${damId}, ${new Date(c.getTime() - HOUR)},     ${UNTRUSTED}, 3000000,   0.6),
      (${damId}, ${c},                                ${UNTRUSTED}, NULL,      NULL)
  `;
  // Same-season history in the two previous years, so 平年比 has a norm.
  const now = Date.now();
  for (const d of [364, 365, 366, 729, 730, 731]) {
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3)
      VALUES (${damId}, ${new Date(now - d * DAY)}, ${HISTORY}, 1000000)
    `;
  }
  await sql.unsafe(`CALL refresh_continuous_aggregate('obs_daily', ${historyWindow})`);
});

afterAll(async () => {
  await cleanup();
  await sql.unsafe(`CALL refresh_continuous_aggregate('obs_daily', ${historyWindow})`);
});

describe('every view shows the reading over its effective capacity', () => {
  test('dam page, list rate, 実測 source and drought list', async () => {
    const obs = await latestObservation(damId);
    expect(obs?.sourceId).toBe(TRUSTED);
    expect(Number(obs?.storageVolumeM3)).toBe(VOLUME);
    expect(Number(obs?.effectiveActiveCapacityM3)).toBe(EFFECTIVE);

    expect((await latestRateByDam([damId])).get(damId.toString())).toBe(0.5);
    const withSource = (await latestRateAndSourceByDam([damId])).get(damId.toString());
    expect(withSource).toEqual({ rate: 0.5, realSourceId: TRUSTED });

    const low = await lowStorageDams(60, 100_000);
    expect(low.find((d) => d.slug === SLUG)?.rate).toBe(0.5);
  });

  test('change strips start from the reading', async () => {
    expect(Number((await storageChange(damId)).current)).toBe(VOLUME);
    expect(Number((await watershedStorageChange(watershedId)).current)).toBe(VOLUME);
  });

  test('平年比 compares the reading', async () => {
    expect(Number((await damSeasonalNorm(damId))?.currentVolumeM3)).toBe(VOLUME);
    expect(Number((await watershedSeasonalNorm(watershedId))?.currentVolumeM3)).toBe(VOLUME);
  });

  test('水系 and 全国 totals sum readings over effective capacity', async () => {
    const totals = (await storageTotalsByWatershed()).get(WS_SLUG);
    expect(Number(totals?.storageM3)).toBe(VOLUME);
    expect(Number(totals?.effectiveCapacityM3)).toBe(EFFECTIVE);

    const agg = await aggregateWatershed(watershedId);
    expect(Number(agg.latestStorageVolumeM3)).toBe(VOLUME);
    expect(Number(agg.observedActiveCapacityM3)).toBe(EFFECTIVE);

    expect((await ratesForWatersheds([watershedId])).get(watershedId.toString())).toBe(0.5);
    const driest = await driestWatersheds(100_000, 1);
    expect(driest.find((w) => w.slug === WS_SLUG)?.rate).toBe(0.5);
  });
});
