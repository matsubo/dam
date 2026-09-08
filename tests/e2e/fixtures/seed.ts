/**
 * Minimal E2E fixture for a freshly migrated database (CI).
 *
 * Migrations 0028-0034 insert a handful of dams but no watershed, so
 * /watersheds and /api/v1/watershed have nothing to render. Seed:
 *
 * - one watershed whose boundary covers central Tokyo (the point api.spec
 *   probes), with one of the migrated dams attached;
 * - 利根川 (一級, 830303) and 堤川 (二級, 020036) under their master codes,
 *   each with one migrated dam attached, so watershed-kind.spec can check the
 *   河川法 classification on a fresh database. Migration 0041 only UPDATEs
 *   rows that already exist, so kind / ndi_code are set here directly.
 *
 * Idempotent, and a no-op on a database that already carries the master
 * (same codes → ON CONFLICT DO NOTHING; dams already attached → no UPDATE).
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
    damSlug: 'nakazato-20',
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
} finally {
  await sql.end();
}
