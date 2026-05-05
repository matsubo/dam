/**
 * Seed plausible synthetic observations so the dam-detail charts render
 * before the realtime adapter has a real upstream feed.
 *
 * The Kasen-Bosai endpoint (www.river.go.jp) explicitly blocks programmatic
 * scraping ("Access Restrictions — This site prohibits data acquisition using
 * tools"). Until we negotiate access or wire in a different upstream, this
 * synth seeder lets the UI/API exercise the time-series stack end-to-end.
 *
 * Two-tier resolution so all three chart toggles have enough plots:
 *   - Last `--hourly-days` (default 30): full hourly resolution
 *   - Last `--years` (default 5) before that: one observation per day at 12:00
 *     (cheap to store, dense enough for the 1-year/5-year aggregate views)
 *
 * Each row is tagged `source_id = 'synthetic'`. source_priorities ranks it
 * highest while we lack a real feed; bump it down to 10 once a real adapter
 * lands.
 *
 * Strategy per dam:
 *   - Baseline storage_rate sampled around 0.55 ± 0.20 (clamped to [0.10, 0.95])
 *   - Slow random walk + small diurnal sin + seasonal sinusoid (annual)
 *   - storage_volume = total_capacity_m3 * storage_rate (skip if no capacity)
 *   - inflow / outflow drawn from log-normal scaled by capacity
 *   - rainfall: zero most hours, occasional bursts
 *
 * Usage:
 *   bun run apps/web/bin/seed_synthetic_observations.ts \
 *     [--hourly-days 30] [--years 5] [--limit 5000]
 */
import { sql } from '@dam/db/client';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  if (k && v) args.set(k.replace(/^--/, ''), v);
}
const HOURLY_DAYS = Number(args.get('hourly-days') ?? args.get('days') ?? '30');
const YEARS = Number(args.get('years') ?? '5');
const LIMIT = Number(args.get('limit') ?? '5000');
const SOURCE = 'synthetic';

interface DamRow {
  id: bigint;
  total_capacity_m3: string | null;
  active_capacity_m3: string | null;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function randNormal(): number {
  // Box–Muller
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

async function main(): Promise<void> {
  // Ensure source_priorities knows about the synthetic source. Pinned high
  // (200) so the chart route picks synthetic data while the real adapters
  // are still pending; lower this manually when a real upstream lands.
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE}, 200, 'Synthetic placeholder (UI-only, not authoritative)', true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority = EXCLUDED.priority, description = EXCLUDED.description, active = true
  `;

  const dams = await sql<DamRow[]>`
    SELECT id,
           total_capacity_m3::TEXT  AS total_capacity_m3,
           active_capacity_m3::TEXT AS active_capacity_m3
    FROM dams
    WHERE total_capacity_m3 IS NOT NULL
    ORDER BY id
    LIMIT ${LIMIT}
  `;
  const olderDays = Math.max(0, YEARS * 365 - HOURLY_DAYS);
  const expectedRows = (HOURLY_DAYS * 24 + olderDays) * dams.length;
  console.log(
    `seeding ${HOURLY_DAYS} d hourly + ${olderDays} d daily × ${dams.length} dams (~${expectedRows.toLocaleString()} rows)`,
  );

  // Wipe prior synthetic rows so the seeder is idempotent.
  await sql`DELETE FROM observations WHERE source_id = ${SOURCE}`;

  const now = new Date();
  // Round down to last whole hour for deterministic timestamps.
  now.setMinutes(0, 0, 0);

  const BATCH = 5_000;
  const buf: Array<{
    observed_at: Date;
    dam_id: bigint;
    source_id: string;
    storage_volume_m3: number | null;
    storage_rate: number | null;
    inflow_m3s: number | null;
    outflow_m3s: number | null;
    water_level_m: number | null;
    rainfall_mm: number | null;
    quality_flag: number;
  }> = [];
  let written = 0;

  async function flush(): Promise<void> {
    if (buf.length === 0) return;
    await sql`
      INSERT INTO observations ${sql(buf)}
      ON CONFLICT (dam_id, observed_at, source_id) DO NOTHING
    `;
    written += buf.length;
    buf.length = 0;
  }

  for (const dam of dams) {
    // Volume baseline = 利水容量 (active_capacity_m3) when available, else
    // total_capacity_m3. The site computes 貯水率 = volume / active_capacity,
    // so basing the synthetic volume on total_capacity made rates exceed
    // 100 % whenever active_capacity < total_capacity (typical: ~60 % of
    // total). Falling back to total_capacity is fine for dams where 利水
    // 容量 isn't recorded — the rate denominator doesn't apply there
    // either, so the chart just uses the raw volume.
    const activeCap = dam.active_capacity_m3 ? Number(dam.active_capacity_m3) : NaN;
    const totalCap = Number(dam.total_capacity_m3);
    const capacity =
      Number.isFinite(activeCap) && activeCap > 0 ? activeCap : totalCap;
    if (!Number.isFinite(capacity) || capacity <= 0) continue;
    const baseRate = clamp(0.55 + 0.2 * randNormal(), 0.1, 0.95);
    const flowScale = Math.cbrt(capacity) / 100; // m³/s units, very rough
    let rate = baseRate;

    // Tier 1: oldest → newest, daily resolution at 12:00 JST for the years
    // beyond the hourly window. Walk forward in time so the random walk
    // accumulates naturally; storage_rate "lands" at the hourly window edge.
    for (let d = olderDays; d >= 1; d--) {
      const ts = new Date(now.getTime() - (HOURLY_DAYS + d) * 86_400_000);
      ts.setUTCHours(3, 0, 0, 0); // 12:00 JST
      // Seasonal: yearly sinusoid (peaks late summer/typhoon season).
      const dayOfYear = Math.floor((ts.getTime() / 86_400_000) % 365);
      const seasonal = 0.05 * Math.sin((dayOfYear / 365) * 2 * Math.PI);
      rate = clamp(rate + 0.005 * randNormal() + seasonal * 0.02, 0.05, 1.0);
      const volume = capacity * rate;
      const inflow = clamp(flowScale * Math.exp(0.4 * randNormal()), 0, 1000);
      const outflow = clamp(inflow * (0.85 + 0.2 * Math.random()), 0, 1000);
      const rainfall = Math.random() < 0.85 ? 0 : Math.abs(3 * randNormal());

      buf.push({
        observed_at: ts,
        dam_id: dam.id,
        source_id: SOURCE,
        storage_volume_m3: Math.round(volume * 100) / 100,
        storage_rate: Math.round(rate * 10000) / 10000,
        inflow_m3s: Math.round(inflow * 1000) / 1000,
        outflow_m3s: Math.round(outflow * 1000) / 1000,
        water_level_m: null,
        rainfall_mm: Math.round(rainfall * 100) / 100,
        quality_flag: 0,
      });
      if (buf.length >= BATCH) await flush();
    }

    // Tier 2: hourly resolution for the most recent HOURLY_DAYS.
    const totalHours = HOURLY_DAYS * 24;
    for (let h = totalHours; h >= 1; h--) {
      const ts = new Date(now.getTime() - h * 3600_000);
      // Slow random walk + diurnal
      rate = clamp(rate + 0.0008 * randNormal() + 0.001 * Math.sin((h / 24) * Math.PI), 0.05, 1.0);
      const volume = capacity * rate;
      const inflow = clamp(flowScale * Math.exp(0.4 * randNormal()), 0, 1000);
      const outflow = clamp(inflow * (0.85 + 0.2 * Math.random()), 0, 1000);
      const rainfall = Math.random() < 0.9 ? 0 : Math.abs(2 * randNormal());

      buf.push({
        observed_at: ts,
        dam_id: dam.id,
        source_id: SOURCE,
        storage_volume_m3: Math.round(volume * 100) / 100,
        storage_rate: Math.round(rate * 10000) / 10000,
        inflow_m3s: Math.round(inflow * 1000) / 1000,
        outflow_m3s: Math.round(outflow * 1000) / 1000,
        water_level_m: null,
        rainfall_mm: Math.round(rainfall * 100) / 100,
        quality_flag: 0,
      });
      if (buf.length >= BATCH) await flush();
    }
  }
  await flush();

  console.log(`wrote ${written} rows; refreshing continuous aggregates...`);
  // refresh_continuous_aggregate cannot run inside an implicit transaction;
  // postgres.js auto-commits each top-level statement so this works.
  await sql.unsafe(`CALL refresh_continuous_aggregate('obs_daily', NULL, NULL)`);
  await sql.unsafe(`CALL refresh_continuous_aggregate('obs_monthly', NULL, NULL)`);

  console.log(
    JSON.stringify({
      dams: dams.length,
      rowsWritten: written,
      hourlyDays: HOURLY_DAYS,
      years: YEARS,
    }),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
