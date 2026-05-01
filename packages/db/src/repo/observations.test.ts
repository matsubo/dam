import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { findSeries, upsertObservations } from './observations.ts';

let damId: bigint;

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'OBS-TEST-1'`;
  damId = await upsertDamByExternalId('ndi', {
    slug: 'obs-test-1',
    name: 'Obs Test',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'OBS-TEST-1' },
  });
});

afterAll(async () => {
  await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
  await sql`DELETE FROM dams WHERE id = ${damId}`;
});

describe('observations repo', () => {
  test('upsert + find round trip', async () => {
    const t0 = new Date('2026-04-30T10:00:00Z');
    const t1 = new Date('2026-04-30T11:00:00Z');
    await upsertObservations([
      {
        observedAt: t0,
        damId,
        sourceId: 'kasenbosai',
        storageVolumeM3: 1_000_000,
        storageRate: 0.5,
      },
      {
        observedAt: t1,
        damId,
        sourceId: 'kasenbosai',
        storageVolumeM3: 1_010_000,
        storageRate: 0.51,
      },
    ]);
    const series = await findSeries({
      damId,
      from: new Date('2026-04-30T00:00:00Z'),
      to: new Date('2026-05-01T00:00:00Z'),
      bucket: 'hourly',
    });
    expect(series.length).toBe(2);
    expect(Number(series[0]?.storageVolumeM3)).toBe(1_000_000);
  });

  test('upsert is idempotent', async () => {
    const t = new Date('2026-04-30T12:00:00Z');
    await upsertObservations([
      { observedAt: t, damId, sourceId: 'kasenbosai', storageVolumeM3: 999_999 },
    ]);
    await upsertObservations([
      { observedAt: t, damId, sourceId: 'kasenbosai', storageVolumeM3: 999_999 },
    ]);
    const rows = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM observations
      WHERE dam_id = ${damId} AND observed_at = ${t} AND source_id = 'kasenbosai'
    `;
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
  });
});
