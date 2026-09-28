import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { dailyVolumeSparklines, upsertObservations } from './observations.ts';

const EXT_IDS = ['SPARK-TEST-VOL', 'SPARK-TEST-LEVEL'];
const DAY_MS = 24 * 3600 * 1000;

let withVolume: bigint;
let levelOnly: bigint;

async function cleanup(): Promise<void> {
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])
  `;
  for (const s of stale) await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;
}

beforeAll(async () => {
  await cleanup();
  const mkDam = (ext: string, slug: string) =>
    upsertDamByExternalId('ndi', {
      slug,
      name: slug,
      prefCode: '13',
      lat: 35.7,
      lng: 139.5,
      externalIds: { ndi: ext },
    });
  withVolume = await mkDam('SPARK-TEST-VOL', 'spark-test-vol');
  levelOnly = await mkDam('SPARK-TEST-LEVEL', 'spark-test-level');

  const now = Date.now();
  await upsertObservations([
    {
      damId: withVolume,
      observedAt: new Date(now - 2 * DAY_MS),
      sourceId: 'test',
      storageVolumeM3: 100,
    },
    {
      damId: withVolume,
      observedAt: new Date(now - DAY_MS),
      sourceId: 'test',
      storageVolumeM3: 200,
    },
    // A dam that reports only its water level: its daily buckets exist, with
    // every storage volume NULL.
    { damId: levelOnly, observedAt: new Date(now - DAY_MS), sourceId: 'test', waterLevelM: 12.3 },
  ]);
  await sql.unsafe(
    `CALL refresh_continuous_aggregate('obs_daily', NOW() - INTERVAL '4 days', NOW())`,
  );
});

afterAll(cleanup);

test('dailyVolumeSparklines skips a dam whose daily buckets carry no volume', async () => {
  const lines = await dailyVolumeSparklines([withVolume, levelOnly]);
  expect(lines.get(withVolume.toString())).toEqual([100, 200]);
  expect(lines.has(levelOnly.toString())).toBe(false);
});
