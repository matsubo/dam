/**
 * Cross-mesh dissolve of W07 dissolved geojsons into watershed boundaries.
 *
 * Reads every *.geojson in data/nlni/w07/dissolved/ (one per mesh, already
 * dissolved by W07_004 within the mesh), loads them into a Postgres temp
 * table, then ST_Union groups by name across meshes and upserts into
 * watersheds.boundary.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';

interface Feature {
  type: 'Feature';
  properties: { W07_002?: string; W07_004?: string };
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}
interface FC {
  type: 'FeatureCollection';
  features: Feature[];
}
const isFC = (v: unknown): v is FC =>
  typeof v === 'object' && v !== null && (v as { type?: string }).type === 'FeatureCollection';

async function main(): Promise<void> {
  const dir = process.argv[2] ?? `${process.cwd()}/data/nlni/w07/dissolved`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.geojson'));
  console.log(`reading ${files.length} dissolved meshes from ${dir}`);

  await sql`DROP TABLE IF EXISTS stage_w07`;
  await sql`
    CREATE TABLE stage_w07 (
      code TEXT,
      name TEXT,
      geom geometry(MULTIPOLYGON, 4326)
    )
  `;

  let staged = 0;
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const data: unknown = JSON.parse(text);
    if (!isFC(data)) continue;
    for (const f of data.features) {
      const code = f.properties.W07_002;
      const name = f.properties.W07_004;
      if (!code || !name || !f.geometry) continue;
      const geomJson = JSON.stringify(f.geometry);
      await sql`
        INSERT INTO stage_w07 (code, name, geom)
        VALUES (${code}, ${name}, ST_Multi(ST_GeomFromGeoJSON(${geomJson})))
      `;
      staged++;
    }
    process.stderr.write(`  ${file}: ${data.features.length} features (running total ${staged})\n`);
  }

  console.log(`staged ${staged} features; dissolving cross-mesh...`);

  // Cross-mesh dissolve: one row per name with ST_Union.
  await sql`DROP TABLE IF EXISTS stage_w07_final`;
  await sql`
    CREATE TABLE stage_w07_final AS
    SELECT
      name,
      min(code) AS code,
      ST_Multi(ST_Union(geom))::geography AS boundary
    FROM stage_w07
    GROUP BY name
  `;

  // Backfill boundary on existing W01-seeded watersheds where the river-system
  // name matches a W07 name. Don't INSERT new rows here — keep the master
  // anchored to W01's set of 644 names; W07-only systems can be added later.
  const backfill = await sql`
    UPDATE watersheds w
    SET boundary = s.boundary
    FROM stage_w07_final s
    WHERE w.name = s.name
  `;
  const result = [{ updated: BigInt(0), inserted: BigInt(0) }];

  await sql`DROP TABLE stage_w07`;
  await sql`DROP TABLE stage_w07_final`;

  console.log(JSON.stringify({
    staged,
    inserted: Number(result[0]?.inserted ?? 0),
    updated: Number(result[0]?.updated ?? 0),
    backfilled: backfill.count,
  }));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
