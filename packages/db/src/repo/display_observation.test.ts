// Issue #32 — the displayed 貯水率 must not change basis with the clock.
//
// 北海道開発局's 18 直轄ダム are written by two sources: `kasenbosai` at
// :03 (hourly, trusted_rate_basis — publishes a 利水容量 rate) and
// `hkd-mlit-dam` at :13 (10-minute values, NOT trusted — its own published
// 貯水率 is 有効容量-based). Picking the newest row meant hkd won from :13 to
// the next :03, and effective_active_capacity_m3() then fell back to the
// static 有効貯水容量. 美利河 read 83.6 % at 07:10 and 11.4 % at 08:55.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';

const SLUG = 'display-obs-32-test';
const TRUSTED = 'kasenbosai';
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

/** Real source ids — the fixtures must not invent one and leave it behind. */
async function assertSourcesAreReal(): Promise<void> {
  for (const id of [TRUSTED, UNTRUSTED]) {
    const [row] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM source_priorities WHERE source_id = ${id}
    `;
    if ((row?.n ?? 0) === 0) {
      throw new Error(`${id} is not a known source_id — the fixture would invent one`);
    }
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

  // Both sources must exist and carry the trust flags the real ones do. They
  // are seeded by their adapters' ensureSourcePriority(), so on a bare test DB
  // insert them — but only after confirming the ids are the real ones.
  await sql`
    INSERT INTO source_priorities (source_id, priority, trusted_rate_basis)
    VALUES (${TRUSTED}, 100, TRUE), (${UNTRUSTED}, 90, FALSE)
    ON CONFLICT (source_id) DO NOTHING
  `;
  await assertSourcesAreReal();
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

describe('display_observation — p_require_volume', () => {
  test('a level-only dam still yields an observation when volume is not required', async () => {
    if (!dbAvailable) return;

    // ktr-kinu, tokushima-bousai, hrr-mlit and friends write
    // storage_volume_m3 NULL. The detail page shows their 水位/流入量/放流量,
    // so requiring a volume would report "no data" for dams that are live.
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, water_level_m)
      VALUES (${damId}, NOW() - INTERVAL '5 minutes', ${UNTRUSTED}, NULL, 12.34)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    const [withVolume] = await sql`SELECT * FROM display_observation(${damId})`;
    const [anyRow] = await sql`SELECT * FROM display_observation(${damId}, FALSE)`;

    expect(withVolume).toBeUndefined();
    expect(anyRow).toBeDefined();
  });

  test('still prefers a current trusted row over a newer level-only row', async () => {
    if (!dbAvailable) return;

    // Deliberate, and the cost of #32: the detail page is exactly where the
    // 83.6 % → 11.4 % swing was seen, so the trust preference has to hold there
    // too. A dam whose newest row is level-only therefore shows the trusted
    // row's timestamp instead — up to an hour older, kasenbosai being hourly.
    // The alternative reintroduces the swing on the page that reported it.
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`
      INSERT INTO observations
        (dam_id, observed_at, source_id, storage_volume_m3, storage_rate, water_level_m)
      VALUES
        -- An explicit rate, so this exercises trust-vs-recency rather than the
        -- derived-rate path: leaving it NULL makes the 0036 trigger fill it and
        -- 0051 flag it, which costs the row its preference by design (#45).
        (${damId}, NOW() - INTERVAL '2 hours',   ${TRUSTED},   5000000, 0.836, NULL),
        (${damId}, NOW() - INTERVAL '5 minutes', ${UNTRUSTED}, NULL,    NULL,  12.34)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    const [row] = await sql<{ source_id: string }[]>`
      SELECT source_id FROM display_observation(${damId}, FALSE)
    `;
    expect(row?.source_id).toBe(TRUSTED);
  });
});

describe('display_observation — derived rates (#45)', () => {
  test('the 0036 trigger marks a rate it derived with quality_flag bit 32', async () => {
    if (!dbAvailable) return;

    // kasenbosai emits a NULL rate whenever both storPcntIrr and storPcntEff
    // carry a quality code (0047's header). The trigger then fills it from
    // volume / active_capacity_m3 — a 有効-based figure on a source we trust
    // for being 利水-based.
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '20 minutes', ${TRUSTED}, 1800000, NULL)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    const [row] = await sql<{ storage_rate: string; derived: boolean }[]>`
      SELECT storage_rate::TEXT, (quality_flag & 32) = 32 AS derived
      FROM observations WHERE dam_id = ${damId}
    `;
    // 1,800,000 / 14,500,000 = 0.1241 — the 有効 denominator, not 利水.
    expect(Number(row?.storage_rate)).toBeCloseTo(0.1241, 4);
    expect(row?.derived).toBe(true);
  });

  test('falls back to the last native trusted reading rather than a derived one', async () => {
    if (!dbAvailable) return;

    // The #45 swing: without the marker the 20-minute-old derived row won on
    // trust and 美利河 displayed 12.4 % instead of 83.6 % — #32's bug re-keyed
    // from the clock to the upstream quality codes.
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '2 hours', ${TRUSTED}, 1800000, 0.836)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '20 minutes', ${TRUSTED}, 1800000, NULL)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '10 minutes', ${UNTRUSTED}, 1660000, 0.114)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    const row = await displayed();
    expect(row?.source_id).toBe(TRUSTED);
    expect(Number(row?.storage_rate)).toBeCloseTo(0.836, 3);
  });

  test('a derived trusted row does not outrank a newer untrusted one', async () => {
    if (!dbAvailable) return;

    // With no native reading to fall back on, the derived row competes on
    // recency like anything else. Both are 有効-based here, so neither is
    // better — the point is that we stop presenting one as authoritative.
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '20 minutes', ${TRUSTED}, 1800000, NULL)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES (${damId}, NOW() - INTERVAL '10 minutes', ${UNTRUSTED}, 1660000, 0.114)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    const row = await displayed();
    expect(row?.source_id).toBe(UNTRUSTED);
  });
});
