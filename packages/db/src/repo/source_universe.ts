import { type Db, sql } from '../client.ts';

/**
 * One station as published by an upstream source, whether or not we managed
 * to tie it to a master dam.
 */
export interface UniverseRow {
  /**
   * The upstream's own stable id. Sources that publish none pass the
   * normalised dam name — and must then also pass `prefCode`, so two
   * identically-named dams in different prefectures stay distinct.
   */
  externalId: string;
  name: string;
  prefCode?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** null = upstream publishes it but we can't match it to a master dam. */
  resolvedDamId?: bigint | null;
  /**
   * Whether this row carried a value: true = yes, false = the provider itself
   * marks it empty (調査対象外, "---" in every column, a page with no rows).
   * Leave it unset when unsure — a cell the parser could not read may be our
   * own breakage, and calling that "no data" would hide it. Every scan
   * overwrites the stored value, unset included, so a row that stops parsing
   * drops back to unknown instead of keeping an earlier "no data".
   */
  hasData?: boolean | null;
  /**
   * The `observedAt` the task stores for this row's current value, when the
   * provider prints its own date (a monthly survey, a weekly table). A dam
   * whose newest observation from this source is at or after it counts as
   * covered even when that date is older than the 30-day window: there is
   * nothing newer to take. Leave it unset for real-time feeds. Every scan
   * overwrites the stored value, unset included.
   */
  publishedAt?: Date | null;
}

/**
 * Record the full list a source publishes, replacing nothing: rows are
 * upserted so `first_seen_at` survives and `last_seen_at` advances on every
 * scan. Stamping the run is what later lets the coverage triage say
 * "nobody publishes this dam" instead of "we haven't looked yet".
 *
 * Call it with the WHOLE list the provider publishes, matched and unmatched
 * alike — a partial call would silently shrink the known universe. Where the
 * provider's catalogue is a constant in the task, build the list from that
 * constant rather than from the rows that happened to parse this run, so a
 * single failing page doesn't drop a station from the universe.
 */
export async function recordUniverse(
  sourceId: string,
  rows: UniverseRow[],
  opts: RecordUniverseOptions = {},
): Promise<number> {
  // Fail-safe by design, for the callers outside the ingest run
  // (match:kasenbosai, the backfills), which await this BEFORE writing
  // observations: anything thrown here would cost that run its observations
  // to protect coverage metadata. A failure is logged and swallowed; the next
  // successful run re-records the same list. The ingest run uses
  // recordUniverseOrThrow inside its transaction instead.
  try {
    return await recordUniverseOrThrow(sourceId, rows, opts.keepHasData ?? false);
  } catch (err) {
    console.error(`recordUniverse(${sourceId}) failed; observations continue:`, err);
    return 0;
  }
}

export interface RecordUniverseOptions {
  /**
   * Leave `has_data` as stored: this list comes from a catalogue that shows
   * no values, and another task answers `has_data` through
   * `recordUniverseHasData` (kasenbosai: weekly sweep vs hourly value fetch).
   */
  keepHasData?: boolean;
}

/**
 * The same write without the safety net: a failure throws. The ingest run
 * (apps/worker/src/ingest) calls it inside the transaction that also writes
 * the observations, so a universe failure fails the job instead of hiding.
 */
export async function recordUniverseOrThrow(
  sourceId: string,
  rows: UniverseRow[],
  keepHasData = false,
  db: Db = sql,
): Promise<number> {
  // De-duplicate on the primary key before building the multi-row INSERT.
  // postgres.js emits one statement, and Postgres rejects a duplicate target
  // with `21000: ON CONFLICT DO UPDATE command cannot affect row a second
  // time`. Several providers legitimately repeat a station (the same names in
  // every monthly ZIP of a backfill). The last entry wins; the ingest run
  // merges duplicate keys itself before calling this.
  const deduped = [...new Map(rows.map((r) => [r.externalId, r])).values()];
  if (deduped.length > 0) {
    const values = deduped.map((r) => ({
      source_id: sourceId,
      source_external_id: r.externalId,
      source_name: r.name,
      pref_code: r.prefCode ?? null,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      resolved_dam_id: r.resolvedDamId ?? null,
      has_data: r.hasData ?? null,
      published_at: r.publishedAt ?? null,
    }));
    await db`
      INSERT INTO source_universe ${db(values)}
      ON CONFLICT (source_id, source_external_id) DO UPDATE SET
        source_name     = EXCLUDED.source_name,
        pref_code       = COALESCE(EXCLUDED.pref_code, source_universe.pref_code),
        lat             = COALESCE(EXCLUDED.lat, source_universe.lat),
        lng             = COALESCE(EXCLUDED.lng, source_universe.lng),
        -- Never downgrade a good match back to NULL. Some tasks resolve from
        -- rows that survived this run's fetch, so a partial outage would
        -- otherwise wipe resolved_dam_id for every station that happened to
        -- be missing — turning a matched dam into unmatched backlog. A real
        -- re-match still overwrites, because it supplies a non-NULL id.
        resolved_dam_id = COALESCE(EXCLUDED.resolved_dam_id, source_universe.resolved_dam_id),
        -- Unlike resolved_dam_id, the latest scan always wins: a row that
        -- stops parsing (NULL) must clear an earlier FALSE, or a parser break
        -- would hide under 提供元に値なし. Each source has a single has_data
        -- writer: this call, or recordUniverseHasData when keepHasData is set.
        has_data        = CASE WHEN ${keepHasData} THEN source_universe.has_data
                               ELSE EXCLUDED.has_data END,
        -- Same rule as an unset has_data: the latest scan wins.
        published_at    = EXCLUDED.published_at,
        -- not_dam_reason is deliberately absent: migrations set it (0131) and
        -- no scan can know a station is a 堰 rather than an unlinked dam.
        last_seen_at    = NOW()
    `;
  }
  // An empty list does NOT count as a scan. Every provider here publishes at
  // least one dam, so `rows.length === 0` means the fetch or parse failed —
  // and stamping a run for it would let a transient upstream outage close the
  // honesty gate and flip that provider's dams to 提供元なし.
  if (deduped.length === 0) return 0;
  await db`
    INSERT INTO source_universe_runs (source_id, last_full_scan_at, row_count)
    VALUES (${sourceId}, NOW(), ${deduped.length})
    ON CONFLICT (source_id) DO UPDATE SET
      last_full_scan_at = EXCLUDED.last_full_scan_at,
      row_count         = EXCLUDED.row_count
  `;
  return deduped.length;
}

/**
 * Set `has_data` on stations another task already listed, for a source whose
 * published list and whose values come from different tasks. Rows the list
 * does not hold are ignored: this annotates the universe, it never grows it.
 * Same semantics as `UniverseRow.hasData`, the latest answer winning — null
 * included. Fail-safe like `recordUniverse`.
 */
export async function recordUniverseHasData(
  sourceId: string,
  rows: { externalId: string; hasData: boolean | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await sql`
      UPDATE source_universe su
      SET has_data = v."hasData"
      FROM jsonb_to_recordset(${sql.json(rows)}) AS v ("externalId" TEXT, "hasData" BOOLEAN)
      WHERE su.source_id = ${sourceId}
        AND su.source_external_id = v."externalId"
        AND su.has_data IS DISTINCT FROM v."hasData"
    `;
  } catch (err) {
    console.error(`recordUniverseHasData(${sourceId}) failed:`, err);
  }
}
