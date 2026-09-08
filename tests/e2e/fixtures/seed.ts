/**
 * Minimal E2E fixture for a freshly migrated database (CI).
 *
 * Migrations 0028-0034 insert a handful of dams but no watershed, so
 * /watersheds and /api/v1/watershed have nothing to render. Seed one
 * watershed whose boundary covers central Tokyo (the point api.spec probes)
 * and attach one of the migrated dams to it. Idempotent.
 *
 * Usage: DATABASE_URL=postgres://... bun run tests/e2e/fixtures/seed.ts
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const sql = postgres(url);
try {
  await sql`
    INSERT INTO watersheds (code, slug, name, kind, boundary, area_km2)
    VALUES (
      'E2E-0001', 'e2e-tokyo', 'E2Eテスト', 'first',
      ST_Multi(ST_GeomFromText(
        'POLYGON((139.4 35.4, 140.1 35.4, 140.1 36.0, 139.4 36.0, 139.4 35.4))', 4326
      ))::geography,
      1000
    )
    ON CONFLICT (code) DO NOTHING
  `;
  await sql`
    UPDATE dams
    SET watershed_id = (SELECT id FROM watersheds WHERE code = 'E2E-0001')
    WHERE slug = 'amagase-26' AND watershed_id IS NULL
  `;
} finally {
  await sql.end();
}
