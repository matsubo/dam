import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { latestObservation, upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';

// issue #60: say whether the displayed 貯水率 is the operator's own figure or
// one we computed from 貯水量 ÷ 有効貯水容量.

const EXT_IDS = ['ORIGIN-TEST-A', 'ORIGIN-TEST-B', 'ORIGIN-TEST-C', 'ORIGIN-TEST-D'];
// 'niigata-bousai' is one of the sources migration 0040 marks trusted_rate_basis.
const TRUSTED_SOURCE = 'niigata-bousai';
const UNTRUSTED_SOURCE = 'test';
const DERIVED_RATE = 32;

const damIds = new Map<string, bigint>();

async function cleanup(): Promise<void> {
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])
  `;
  for (const s of stale) await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;
}

beforeAll(async () => {
  await cleanup();
  for (const [i, ext] of EXT_IDS.entries()) {
    const id = await upsertDamByExternalId('ndi', {
      slug: ext.toLowerCase(),
      name: ext,
      prefCode: '13',
      lat: 40.1 + i / 10,
      lng: 150.5,
      externalIds: { ndi: ext },
    });
    damIds.set(ext, id);
  }
  await sql`UPDATE dams SET active_capacity_m3 = 5700 WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;

  const at = new Date(Date.now() - 3600 * 1000);
  const obs = (ext: string, sourceId: string, storageRate: number | null, qualityFlag: number) => ({
    damId: damIds.get(ext) ?? 0n,
    observedAt: at,
    sourceId,
    storageVolumeM3: 2230,
    storageRate,
    qualityFlag,
  });
  await upsertObservations([
    obs('ORIGIN-TEST-A', TRUSTED_SOURCE, 0.973, 0),
    obs('ORIGIN-TEST-B', UNTRUSTED_SOURCE, 0.973, 0),
    obs('ORIGIN-TEST-C', TRUSTED_SOURCE, 2230 / 5700, DERIVED_RATE),
  ]);
  // D: a level-only reading — no volume, so no 貯水率 is shown at all.
  await upsertObservations([
    {
      damId: damIds.get('ORIGIN-TEST-D') ?? 0n,
      observedAt: at,
      sourceId: UNTRUSTED_SOURCE,
      waterLevelM: 100,
      qualityFlag: 0,
    },
  ]);
});

afterAll(cleanup);

describe('latestObservation.storageRateOrigin', () => {
  const origin = async (ext: string) =>
    (await latestObservation(damIds.get(ext) ?? 0n))?.storageRateOrigin;

  test("a trusted source's own rate is published", async () => {
    expect(await origin('ORIGIN-TEST-A')).toBe('published');
  });

  test('an untrusted source is recomputed from volume, so computed', async () => {
    expect(await origin('ORIGIN-TEST-B')).toBe('computed');
  });

  test('a rate the trigger derived is computed even for a trusted source', async () => {
    expect(await origin('ORIGIN-TEST-C')).toBe('computed');
  });

  test('no volume means no rate to label', async () => {
    expect(await origin('ORIGIN-TEST-D')).toBeNull();
  });
});
