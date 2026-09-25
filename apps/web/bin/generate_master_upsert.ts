#!/usr/bin/env bun
/**
 * Generate a non-destructive UPSERT seed file for production.
 *
 * Output (`deploy/seed/master_upsert.sql.gz`) is a single transaction that:
 *   1. Loads watersheds + dams + source_priorities into TEMP tables
 *   2. UPSERTs into the live tables, matching watersheds by `code`
 *      and dams by `external_ids->>'ndi'`
 *   3. Adds missing external ids and blank elevation / image on existing
 *      dams (prod wins everywhere else) and never touches `observations`,
 *      `raw_snapshots`, or `match_review`
 *   4. Inserts brand-new dams that exist locally but not on prod
 *
 * bootstrap.sh applies it on every web boot, so it must only converge prod on
 * rows prod lacks — see buildMasterUpsertSql() in master_upsert_sql.ts.
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { sql } from '@dam/db/client';
import {
  buildMasterUpsertSql,
  type SeedDam,
  type SeedSource,
  type SeedWatershed,
} from './master_upsert_sql.ts';

async function main(): Promise<void> {
  const watersheds = await sql<SeedWatershed[]>`
    SELECT id::TEXT, code, slug, name, name_kana, kind, ndi_code,
           CASE WHEN boundary IS NULL THEN NULL ELSE encode(boundary::bytea, 'hex') END AS boundary,
           area_km2::TEXT AS area_km2
    FROM watersheds
    ORDER BY id
  `;
  const dams = await sql<SeedDam[]>`
    SELECT id::TEXT, slug, name, name_kana, pref_code,
           river_id::TEXT, watershed_id::TEXT,
           manager, type,
           height_m::TEXT, total_capacity_m3::TEXT,
           effective_capacity_m3::TEXT, flood_capacity_m3::TEXT,
           active_capacity_m3::TEXT,
           completed_year, construction_start_year,
           purposes, crest_length_m::TEXT, embankment_volume_m3::TEXT,
           watershed_area_km2::TEXT, reservoir_area_km2::TEXT,
           left_bank_location, main_contractor, redevelopment_status,
           elevation_m, image_url,
           encode(location::bytea, 'hex') AS location,
           external_ids
    FROM dams
    ORDER BY id
  `;
  const sources = await sql<SeedSource[]>`
    SELECT source_id, description, priority, active FROM source_priorities ORDER BY priority DESC
  `;

  const sqlText = buildMasterUpsertSql({ sources, watersheds, dams });
  const gz = gzipSync(Buffer.from(sqlText, 'utf8'));
  const out = `${process.cwd()}/deploy/seed/master_upsert.sql.gz`;
  writeFileSync(out, gz);
  console.log(
    JSON.stringify({
      out,
      bytes_uncompressed: sqlText.length,
      bytes_gzipped: gz.length,
      watersheds: watersheds.length,
      dams: dams.length,
      sources: sources.length,
    }),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
