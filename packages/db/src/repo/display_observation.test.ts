// Issue #32 — the displayed 貯水率 must not change basis with the clock.
//
// 北海道開発局's 18 直轄ダム are written by two sources: `kasenbosai-v2` at
// :03 (hourly, trusted_rate_basis — publishes a 利水容量 rate) and
// `hkd-mlit-dam` at :13 (10-minute values, NOT trusted — its own published
// 貯水率 is 有効容量-based). Picking the newest row meant hkd won from :13 to
// the next :03, and effective_active_capacity_m3() then fell back to the
// static 有効貯水容量. 美利河 read 83.6 % at 07:10 and 11.4 % at 08:55.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';

const SLUG = 'display-obs-32-test';
const TRUSTED = 'kasenbosai-v2';
const UNTRUSTED = 'hkd-mlit-dam';

let damId: bigint;
let dbAvailable = false;

async function cleanup(): Promise<void> {
  const rows = await sql<{ id: bigint }[]>`SELECT id FROM dams WHERE slug = ${SLUG}`;
  for (const r of rows) {
    await sql`DELETE FROM observations WHERE dam_id = ${r.id}`;
    await sql`DELETE FROM dams WHERE id = ${r.id}`;
  }
}

/** The row the public read path would display, via the 0049 SQL function. */
async function displayed(): Promise<{ source_id: string; storage_rate: string | null } | null> {
  const rows = await sql<{ source_id: string; storage_rate: string | null }[]>`
    SELECT source_id, storage_rate::TEXT FROM display_observation(${damId})
  `;
  return rows[0] ?? null;
}

beforeAll(async () => {
  try {
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    return;
  }
  await cleanup();

  // 美利河's shape: 有効貯水容量 14,500 千m³ in master, 利水容量 2,159 千m³.
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (slug, name, pref_code, location, external_ids, active_capacity_m3)
    VALUES (${SLUG}, 'Display Observation Test', '01',
            ST_SetSRID(ST_MakePoint(140.1, 42.4), 4326)::geography, '{}'::jsonb, 14500000)
    RETURNING id
  `;
  damId = rows[0]?.id as bigint;

  // Both sources must exist and carry the trust flags the real ones do.
  await sql`
    INSERT INTO source_priorities (source_id, priority, trusted_rate_basis)
    VALUES (${TRUSTED}, 100, TRUE), (${UNTRUSTED}, 90, FALSE)
    ON CONFLICT (source_id) DO NOTHING
  `;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await cleanup();
});

describe('display_observation (#32)', () => {
  test('prefers the trusted-basis row even when an untrusted row is newer', async () => {
    if (!dbAvailable) return;

    // :03 — kasenbosai, trusted, 利水 basis: 1,800 / 2,159 = 83.6 %.
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '20 minutes', ${TRUSTED}, 1800000, 0.836)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;
    // :13 — hkd, untrusted, 有効 basis: 1,660 / 14,500 = 11.4 %.
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '10 minutes', ${UNTRUSTED}, 1660000, 0.114)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    const row = await displayed();
    // Newest is hkd; the displayed row must still be the trusted one, so the
    // denominator stays 利水 and the figure does not swing hourly.
    expect(row?.source_id).toBe(TRUSTED);
    expect(Number(row?.storage_rate)).toBeCloseTo(0.836, 3);
  });

  test('falls back to the newest row once no trusted row is current', async () => {
    if (!dbAvailable) return;

    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    // Trusted row well outside the 24h window — the feed has stopped.
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '3 days', ${TRUSTED}, 1800000, 0.836)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '10 minutes', ${UNTRUSTED}, 1660000, 0.114)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    // Stale trust must not outrank live data indefinitely.
    const row = await displayed();
    expect(row?.source_id).toBe(UNTRUSTED);
  });

  test('uses the newest trusted row when several are current', async () => {
    if (!dbAvailable) return;

    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES
        (${damId}, NOW() - INTERVAL '3 hours', ${TRUSTED}, 1700000, 0.790),
        (${damId}, NOW() - INTERVAL '1 hour',  ${TRUSTED}, 1800000, 0.836)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    const row = await displayed();
    expect(Number(row?.storage_rate)).toBeCloseTo(0.836, 3);
  });
});
