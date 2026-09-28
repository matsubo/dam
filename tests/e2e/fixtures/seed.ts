/**
 * Minimal E2E fixture for a freshly migrated database (CI).
 *
 * Migrations 0028-0034 insert a handful of dams but no watershed, so
 * /watersheds and /api/v1/watershed have nothing to render. Seed:
 *
 * - one watershed whose boundary covers central Tokyo (the point api.spec
 *   probes), with one of the migrated dams attached;
 * - one dam with a 利水容量 and a fresh 貯水量 observation, so 全国貯水率 and
 *   the coverage tiles have something to render;
 * - 利根川 (一級, 830303) and 堤川 (二級, 020036) under their master codes,
 *   each with one migrated dam attached, so watershed-kind.spec can check the
 *   河川法 classification on a fresh database. Migration 0041 only UPDATEs
 *   rows that already exist, so kind / ndi_code are set here directly;
 * - two published stations under the `e2e-fixture` provider, for
 *   coverage-triage.spec: one listed for ryumon-40 (which has no
 *   observation) with no value (`has_data = FALSE`, so the dam is
 *   published_no_data), and one unresolved station with a cited
 *   not_dam_reason. No `source_universe_runs` row is written, so on a fresh
 *   database every enumerable provider stays in the pending-scan list.
 *
 * Idempotent (ON CONFLICT DO NOTHING; dams already attached → no UPDATE), but
 * not a no-op: the observation and the `e2e-fixture` universe rows land on
 * any database and nothing removes them, so run it only on CI's database or
 * a scratch one (AGENTS.md "Tests"), never on the shared dev `dam`.
 * The slugs deliberately avoid the `watershed-` prefix, which the middleware
 * treats as a legacy redirect.
 *
 * Usage: DATABASE_URL=postgres://... bun run tests/e2e/fixtures/seed.ts
 */
import postgres from 'postgres';

interface FixtureWatershed {
  code: string;
  slug: string;
  name: string;
  kind: 'first' | 'second' | 'other';
  ndiCode: string | null;
  /** WKT polygon ring, WGS84. */
  polygon: string;
  /** Slug of a dam inserted by migrations 0028-0034 to attach. */
  damSlug: string;
}

const FIXTURES: readonly FixtureWatershed[] = [
  {
    code: 'E2E-0001',
    slug: 'e2e-tokyo',
    name: 'E2Eテスト',
    kind: 'first',
    ndiCode: null,
    polygon: 'POLYGON((139.4 35.4, 140.1 35.4, 140.1 36.0, 139.4 36.0, 139.4 35.4))',
    damSlug: 'amagase-26',
  },
  {
    code: 'W01-利根川',
    slug: '利根川',
    name: '利根川',
    kind: 'first',
    ndiCode: '830303',
    // North Kanto, clear of the Tokyo probe point above.
    polygon: 'POLYGON((138.8 36.2, 139.6 36.2, 139.6 36.9, 138.8 36.9, 138.8 36.2))',
    damSlug: 'tanano-36',
  },
  {
    code: 'W01-堤川',
    slug: '堤川',
    name: '堤川',
    kind: 'second',
    ndiCode: '020036',
    // Aomori.
    polygon: 'POLYGON((140.6 40.6, 141.0 40.6, 141.0 40.9, 140.6 40.9, 140.6 40.6))',
    damSlug: 'kechi-42',
  },
];

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const sql = postgres(url);
try {
  for (const w of FIXTURES) {
    await sql`
      INSERT INTO watersheds (code, slug, name, kind, ndi_code, boundary, area_km2)
      VALUES (
        ${w.code}, ${w.slug}, ${w.name}, ${w.kind}, ${w.ndiCode},
        ST_Multi(ST_GeomFromText(${w.polygon}, 4326))::geography,
        1000
      )
      ON CONFLICT (code) DO NOTHING
    `;
    await sql`
      UPDATE dams
      SET watershed_id = (SELECT id FROM watersheds WHERE code = ${w.code})
      WHERE slug = ${w.damSlug} AND watershed_id IS NULL
    `;
  }

  // One observed dam so the rate/coverage paths render a real number instead
  // of '—'. coverage-consistency.spec compares those numbers across pages.
  // Hour-truncated timestamp keeps the insert idempotent within a run while
  // staying inside the 7-day freshness window.
  await sql`
    UPDATE dams SET active_capacity_m3 = 1000000
    WHERE slug = 'amagase-26' AND active_capacity_m3 IS NULL
  `;
  await sql`
    INSERT INTO observations (observed_at, dam_id, source_id, storage_volume_m3)
    SELECT date_trunc('hour', NOW()), id, 'e2e-fixture', 400000
    FROM dams WHERE slug = 'amagase-26'
    ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
  `;
  // A second rate-able dam with NO observation. 全国貯水率 must ignore its
  // capacity entirely: with it in the denominator the rate halves, which is
  // exactly the bug coverage-consistency.spec guards against.
  await sql`
    UPDATE dams SET active_capacity_m3 = 1000000
    WHERE slug = 'kechi-42' AND active_capacity_m3 IS NULL
  `;

  // /coverage triage: a provider that lists ryumon-40 but prints no value for
  // it (提供元に値なし), and a station it publishes that is known not to be a
  // dam (excluded from the unmatched backlog).
  await sql`
    INSERT INTO source_universe
      (source_id, source_external_id, source_name, pref_code, resolved_dam_id, has_data)
    SELECT 'e2e-fixture', 'e2e-no-data', 'E2E値なしダム', d.pref_code, d.id, FALSE
    FROM dams d WHERE d.slug = 'ryumon-40'
    ON CONFLICT (source_id, source_external_id) DO NOTHING
  `;
  await sql`
    INSERT INTO source_universe
      (source_id, source_external_id, source_name, not_dam_reason)
    VALUES ('e2e-fixture', 'e2e-weir', 'E2E堰', 'E2E fixture: a 堰 with no dam behind it')
    ON CONFLICT (source_id, source_external_id) DO NOTHING
  `;
} finally {
  await sql.end();
}
