import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { nullPhantomZeroSeries } from './quality_recompute.ts';

// A dam whose entire series from a given source is 0 is non-reporting; its
// recent 0-volume rows (and the rate trigger derived from them) must be
// nulled. A dam whose series varies (a real, sometimes-empty dam) is kept.

const EXT = ['QR-PHANTOM', 'QR-REAL'];
let phantomId: bigint;
let realId: bigint;

async function mkDam(slug: string, ext: string): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (slug, name, pref_code, location, external_ids, active_capacity_m3)
    VALUES (${slug}, ${slug}, '13',
            ST_SetSRID(ST_MakePoint(139.5, 35.7), 4326)::geography,
            ${sql.json({ ndi: ext })}::jsonb, 1000000)
    ON CONFLICT ((external_ids ->> 'ndi')) WHERE external_ids ? 'ndi'
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('mkDam failed');
  return id;
}

async function cleanup(): Promise<void> {
  const rows = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT}::text[])
  `;
  for (const r of rows) await sql`DELETE FROM observations WHERE dam_id = ${r.id}`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT}::text[])`;
}

beforeEach(async () => {
  await cleanup();
  phantomId = await mkDam('qr-phantom', 'QR-PHANTOM');
  realId = await mkDam('qr-real', 'QR-REAL');
  const now = Date.now();
  // Phantom dam: always 0 volume (source publishes a placeholder 0).
  await sql`
    INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3)
    VALUES
      (${phantomId}, ${new Date(now - 3600_000)}, 'test-kasen', 0),
      (${phantomId}, ${new Date(now - 2 * 3600_000)}, 'test-kasen', 0),
      (${phantomId}, ${new Date(now - 40 * 24 * 3600_000)}, 'test-kasen', 0)
  `;
  // Real dam: currently 0 but was full earlier — a genuinely drawn-down dam.
  await sql`
    INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3)
    VALUES
      (${realId}, ${new Date(now - 3600_000)}, 'test-kasen', 0),
      (${realId}, ${new Date(now - 40 * 24 * 3600_000)}, 'test-kasen', 800000)
  `;
});

afterAll(cleanup);

describe('nullPhantomZeroSeries', () => {
  test('nulls recent 0 volume + rate for an all-zero (dam, source) series', async () => {
    await nullPhantomZeroSeries(sql);
    const rows = await sql<{ v: string | null; r: string | null }[]>`
      SELECT storage_volume_m3 AS v, storage_rate AS r FROM observations
      WHERE dam_id = ${phantomId} AND observed_at > NOW() - INTERVAL '48 hours'
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.v).toBeNull();
      expect(row.r).toBeNull();
    }
  });

  test('keeps a dam whose series varies (real drawn-down reservoir)', async () => {
    await nullPhantomZeroSeries(sql);
    const rows = await sql<{ v: string | null }[]>`
      SELECT storage_volume_m3 AS v FROM observations
      WHERE dam_id = ${realId} AND observed_at > NOW() - INTERVAL '48 hours'
    `;
    // The recent 0 stays 0 — the dam has real non-zero history, so its 0 is a
    // genuine reading, not a non-reporting placeholder.
    expect(rows.some((r) => r.v !== null && Number(r.v) === 0)).toBe(true);
  });
});
