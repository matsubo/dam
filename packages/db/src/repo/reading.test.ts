// The reading (dam_reading(), 0226; GLOSSARY "Reading", docs/adr/0002): the
// one observation every view of a dam at a moment shows.
//
// Issue #32 — the displayed 貯水率 must not change basis with the clock.
// 北海道開発局's 18 直轄ダム are written by two sources: `kasenbosai` at
// :03 (hourly, trusted_rate_basis — publishes a 利水容量 rate) and
// `hkd-mlit-dam` at :13 (10-minute values, NOT trusted — its own published
// 貯水率 is 有効容量-based). Picking the newest row meant hkd won from :13 to
// the next :03, and effective_active_capacity_m3() then fell back to the
// static 有効貯水容量. 美利河 read 83.6 % at 07:10 and 11.4 % at 08:55.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';

const SLUG = 'reading-test';
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

/** The dam's reading. */
async function displayed(): Promise<{ source_id: string; storage_rate: string | null } | null> {
  const rows = await sql<{ source_id: string; storage_rate: string | null }[]>`
    SELECT source_id, storage_rate::TEXT FROM dam_reading(${damId})
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
    VALUES (${SLUG}, 'Reading Test', '01',
            ST_SetSRID(ST_MakePoint(140.1, 42.4), 4326)::geography, '{}'::jsonb, 14500000)
    RETURNING id
  `;
  damId = rows[0]?.id as bigint;

  // Both sources must exist and carry the trust flags the real ones do. They
  // are written by the source sync at boot, so on a bare test DB
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

describe('the reading (#32)', () => {
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

describe('the reading — p_need_volume', () => {
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

    const [withVolume] = await sql`SELECT * FROM dam_reading(${damId})`;
    const [anyRow] = await sql`SELECT * FROM dam_reading(${damId}, FALSE)`;

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
      SELECT source_id FROM dam_reading(${damId}, FALSE)
    `;
    expect(row?.source_id).toBe(TRUSTED);
  });
});

describe('the reading — derived rates (#45)', () => {
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

// 0223: several sources stamp the same observed_at. The pick used to depend on
// the plan; now the higher active source_priorities.priority wins, then the
// greater source_id — in the reading and in obs_daily's daily value.
describe('timestamp ties (0223)', () => {
  /** The source the rule picks among TRUSTED and UNTRUSTED, from their real rows. */
  async function expectedWinner(): Promise<string> {
    const rows = await sql<{ source_id: string }[]>`
      SELECT source_id FROM source_priorities
      WHERE source_id IN (${TRUSTED}, ${UNTRUSTED})
      ORDER BY COALESCE(CASE WHEN active THEN priority END, -1) DESC, source_id DESC
      LIMIT 1
    `;
    return rows[0]?.source_id as string;
  }

  test('the reading picks the higher-priority source on a tie', async () => {
    if (!dbAvailable) return;

    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    // Three days old, so neither row is a current trusted reading: only the
    // tie-break decides.
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES
        (${damId}, date_trunc('hour', NOW()) - INTERVAL '3 days', ${UNTRUSTED}, 1660000, 0.114),
        (${damId}, date_trunc('hour', NOW()) - INTERVAL '3 days', ${TRUSTED},   1800000, 0.836)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;

    const row = await displayed();
    expect(row?.source_id).toBe(await expectedWinner());
  });

  test("obs_daily's last value takes the tie's higher-priority volume, never a level-only NULL", async () => {
    if (!dbAvailable) return;

    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, water_level_m)
      VALUES
        (${damId}, '2001-01-01T12:00:00Z', ${UNTRUSTED}, 1660000, NULL),
        (${damId}, '2001-01-01T12:00:00Z', ${TRUSTED},   1800000, NULL),
        (${damId}, '2001-01-01T13:00:00Z', ${UNTRUSTED}, NULL,    100.5)
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;
    const refresh = `CALL refresh_continuous_aggregate('obs_daily', '2001-01-01', '2001-01-02', force => true)`;
    try {
      await sql.unsafe(refresh);
      const [day] = await sql<{ last: string | null }[]>`
        SELECT last_storage_volume_m3::TEXT AS last FROM obs_daily
        WHERE dam_id = ${damId} AND day = '2001-01-01T00:00:00Z'
      `;
      const winner = await expectedWinner();
      expect(Number(day?.last)).toBe(winner === TRUSTED ? 1800000 : 1660000);
    } finally {
      await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
      await sql.unsafe(refresh);
    }
  });
});

// 0226: a row without a value, the rank of inactive/unlisted sources, a
// reading at an earlier moment, and a window.
describe('the reading — 0226', () => {
  // A retired source the source sync keeps inactive, and the fixture source
  // no declaration lists.
  const INACTIVE = 'niigata-bousai';
  const UNLISTED = 'test';

  async function readingAt(
    asOf: string | null,
    window: string | null = null,
  ): Promise<{ source_id: string; storage_volume_m3: string } | undefined> {
    const [row] = await sql<{ source_id: string; storage_volume_m3: string }[]>`
      SELECT source_id, storage_volume_m3::TEXT
      FROM dam_reading(${damId}, TRUE, ${window}::INTERVAL, ${asOf}::TIMESTAMPTZ)
    `;
    return row;
  }

  async function seed(rows: [ago: string, source: string, volume: number | null][]) {
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    for (const [ago, source, volume] of rows) {
      await sql`
        INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
        VALUES (${damId}, date_trunc('hour', NOW()) - ${ago}::INTERVAL, ${source}, ${volume},
                CASE WHEN ${volume}::NUMERIC IS NULL THEN NULL ELSE 0.5 END)
      `;
    }
  }

  test('a row that carries no value is never the reading', async () => {
    if (!dbAvailable) return;
    // An untrusted feed keeps writing empty rows after its last value.
    await seed([
      ['3 days', UNTRUSTED, 1660000],
      ['1 hour', UNTRUSTED, null],
    ]);
    const [any] = await sql<{ observed_at: Date }[]>`
      SELECT observed_at FROM dam_reading(${damId}, FALSE)
    `;
    expect(Date.now() - (any?.observed_at.getTime() ?? 0)).toBeGreaterThan(2 * 24 * 3600 * 1000);
  });

  test('an inactive source ranks below an active one, an unlisted one alike', async () => {
    if (!dbAvailable) return;
    const [inactive] = await sql<{ active: boolean }[]>`
      SELECT active FROM source_priorities WHERE source_id = ${INACTIVE}
    `;
    expect(inactive?.active).toBe(false);

    await seed([
      ['3 days', INACTIVE, 1],
      ['3 days', UNTRUSTED, 2],
    ]);
    expect((await readingAt(null))?.source_id).toBe(UNTRUSTED);
    // Both rank -1, so the greater source_id decides.
    await seed([
      ['3 days', INACTIVE, 1],
      ['3 days', UNLISTED, 2],
    ]);
    expect((await readingAt(null))?.source_id).toBe(UNLISTED);
  });

  test('as of an earlier moment, freshness is measured from that moment', async () => {
    if (!dbAvailable) return;
    // At T the trusted row is 2 h old and wins; now it is two days old.
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`
      INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
      VALUES
        (${damId}, date_trunc('hour', NOW()) - INTERVAL '50 hours', ${TRUSTED},   1800000, 0.836),
        (${damId}, date_trunc('hour', NOW()) - INTERVAL '49 hours', ${UNTRUSTED}, 1660000, 0.114),
        (${damId}, date_trunc('hour', NOW()) - INTERVAL '1 hour',   ${UNTRUSTED}, 1500000, 0.103)
    `;
    const t = await sql<
      { t: string }[]
    >`SELECT (date_trunc('hour', NOW()) - INTERVAL '48 hours')::TEXT AS t`;
    const asOf = t[0]?.t as string;
    expect((await readingAt(asOf))?.source_id).toBe(TRUSTED);
    expect(Number((await readingAt(null))?.storage_volume_m3)).toBe(1500000);
  });

  test('as of a moment long after the last value, that value is still the reading', async () => {
    if (!dbAvailable) return;
    // The lower bound is the newest value before the moment, not moment − 24 h.
    await seed([
      ['30 days', UNTRUSTED, 1660000],
      ['20 days', UNLISTED, 1500000],
    ]);
    const t = await sql<{ t: string }[]>`SELECT (NOW() - INTERVAL '5 days')::TEXT AS t`;
    expect((await readingAt(t[0]?.t as string))?.source_id).toBe(UNLISTED);
  });

  test('a reading older than the window is absent, not replaced', async () => {
    if (!dbAvailable) return;
    await seed([['3 hours', UNTRUSTED, 1660000]]);
    expect(await readingAt(null, '2 hours')).toBeUndefined();
    expect((await readingAt(null, '4 hours'))?.source_id).toBe(UNTRUSTED);
  });
});
