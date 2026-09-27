import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { rebindObservations } from './observations_rebind.ts';

// Fixture rows keyed by these NDI ids; cleanup is scoped to them.
const FROM_NDI = '9999999993';
const TO_NDI = '9999999992';
const SOURCE = 'test-rebind';
const OTHER = 'test-rebind-other';

const ids = new Map<string, bigint>();
const t = (h: number) => new Date(Date.UTC(2026, 8, 20, h));

async function cleanup(): Promise<void> {
  const rows = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' IN (${FROM_NDI}, ${TO_NDI})
  `;
  for (const r of rows) await sql`DELETE FROM observations WHERE dam_id = ${r.id}`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' IN (${FROM_NDI}, ${TO_NDI})`;
}

beforeAll(async () => {
  await cleanup();
  // The wrong row (the （元）) has a small capacity, the right one (the （再）) a larger one.
  for (const [ndi, slug, name, cap] of [
    [FROM_NDI, 'rebind-test-moto', '試験（元）', 1000],
    [TO_NDI, 'rebind-test-sai', '試験（再）', 4000],
  ] as const) {
    const [r] = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, location, external_ids, active_capacity_m3)
      VALUES (${slug}, ${name}, '01', ST_GeogFromText('POINT(142 43)'),
              jsonb_build_object('ndi', ${ndi}::text), ${cap})
      RETURNING id
    `;
    ids.set(ndi, r?.id ?? 0n);
  }
  const from = ids.get(FROM_NDI) ?? 0n;
  const to = ids.get(TO_NDI) ?? 0n;
  await upsertObservations([
    // Derived by the trigger against the wrong capacity: 500 / 1000.
    { damId: from, observedAt: t(1), sourceId: SOURCE, storageVolumeM3: 500, qualityFlag: 0 },
    // The source's own rate — must move untouched.
    {
      damId: from,
      observedAt: t(2),
      sourceId: SOURCE,
      storageVolumeM3: 600,
      storageRate: 0.9,
      qualityFlag: 0,
    },
    // Already written to the right row after the fix: the right row's copy wins.
    { damId: from, observedAt: t(3), sourceId: SOURCE, storageVolumeM3: 1, qualityFlag: 0 },
    { damId: to, observedAt: t(3), sourceId: SOURCE, storageVolumeM3: 700, qualityFlag: 0 },
    // Another source on the wrong row stays where it is.
    { damId: from, observedAt: t(1), sourceId: OTHER, storageVolumeM3: 100, qualityFlag: 0 },
  ]);
});

afterAll(cleanup);

describe('rebindObservations', () => {
  test('moves one source from the wrong row to the right one', async () => {
    const moved = await rebindObservations(sql, {
      sourceId: SOURCE,
      fromNdi: FROM_NDI,
      toNdi: TO_NDI,
    });
    expect(moved).toBe(2);

    const rows = await sql<{ h: number; vol: string; rate: string; derived: boolean }[]>`
      SELECT EXTRACT(HOUR FROM observed_at)::int AS h, storage_volume_m3::TEXT AS vol,
             storage_rate::TEXT AS rate, (quality_flag & 32) = 32 AS derived
      FROM observations WHERE dam_id = ${ids.get(TO_NDI) ?? 0n} AND source_id = ${SOURCE}
      ORDER BY 1
    `;
    expect(rows.map((r) => [r.h, Number(r.vol), Number(r.rate), r.derived])).toEqual([
      [1, 500, 0.125, true], // re-derived against the right row: 500 / 4000
      [2, 600, 0.9, false],
      [3, 700, 0.175, true],
    ]);
  });

  test('leaves the wrong row with other sources only', async () => {
    const rows = await sql<{ source_id: string }[]>`
      SELECT source_id FROM observations WHERE dam_id = ${ids.get(FROM_NDI) ?? 0n}
    `;
    expect(rows.map((r) => r.source_id)).toEqual([OTHER]);
  });

  test('unknown NDI ids are an error, not a silent no-op', async () => {
    await expect(
      rebindObservations(sql, { sourceId: SOURCE, fromNdi: 'nope', toNdi: TO_NDI }),
    ).rejects.toThrow(/nope/);
  });
});
