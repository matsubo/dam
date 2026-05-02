/**
 * Seed plausible synthetic hourly observations so the dam-detail charts render
 * before the realtime adapter has a real upstream feed.
 *
 * The Kasen-Bosai endpoint (www.river.go.jp) explicitly blocks programmatic
 * scraping ("Access Restrictions — This site prohibits data acquisition using
 * tools"). Until we negotiate access or wire in a different upstream, this
 * synth seeder lets the UI/API exercise the time-series stack end-to-end.
 *
 * Each row is tagged `source_id = 'synthetic'` so the quality UI surfaces it
 * as non-authoritative, and source_priorities ranks it lowest.
 *
 * Strategy per dam:
 *   - Baseline storage_rate sampled around 0.55 ± 0.20 (clamped to [0.10, 0.95])
 *   - Hourly values follow a slow random-walk + small diurnal sin
 *   - storage_volume = total_capacity_m3 * storage_rate (skip if no capacity)
 *   - inflow / outflow drawn from log-normal scaled by capacity
 *   - rainfall: zero most hours, occasional bursts
 *
 * Usage:
 *   bun run apps/web/bin/seed_synthetic_observations.ts [--days 30] [--limit 2749]
 */
import { sql } from '@dam/db/client';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  if (k && v) args.set(k.replace(/^--/, ''), v);
}
const DAYS = Number(args.get('days') ?? '30');
const LIMIT = Number(args.get('limit') ?? '5000');
const SOURCE = 'synthetic';

interface DamRow {
  id: bigint;
  total_capacity_m3: string | null;
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
  // Ensure source_priorities knows about the synthetic source.
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE}, 10, 'Synthetic placeholder (UI-only, not authoritative)', true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority = EXCLUDED.priority, description = EXCLUDED.description
  `;

  const dams = await sql<DamRow[]>`
    SELECT id, total_capacity_m3::TEXT AS total_capacity_m3
    FROM dams
    WHERE total_capacity_m3 IS NOT NULL
    ORDER BY id
    LIMIT ${LIMIT}
  `;
  console.log(`seeding ${DAYS} days × ${dams.length} dams (~${(DAYS * 24 * dams.length).toLocaleString()} rows)`);

  // Wipe prior synthetic rows so the seeder is idempotent.
  await sql`DELETE FROM observations WHERE source_id = ${SOURCE}`;

  const now = new Date();
  // Round down to last whole hour for deterministic timestamps.
  now.setMinutes(0, 0, 0);
  const totalHours = DAYS * 24;

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
    const capacity = Number(dam.total_capacity_m3);
    if (!Number.isFinite(capacity) || capacity <= 0) continue;
    const baseRate = clamp(0.55 + 0.2 * randNormal(), 0.1, 0.95);
    const flowScale = Math.cbrt(capacity) / 100; // m³/s units, very rough
    let rate = baseRate;

    for (let h = totalHours; h >= 1; h--) {
      const ts = new Date(now.getTime() - h * 3600_000);
      // Slow random walk + diurnal
      rate = clamp(rate + 0.0008 * randNormal() + 0.001 * Math.sin((h / 24) * Math.PI), 0.05, 1.0);
      const volume = capacity * rate;
      const inflow = clamp(flowScale * Math.exp(0.4 * randNormal()), 0, 1000);
      const outflow = clamp(inflow * (0.85 + 0.2 * Math.random()), 0, 1000);
      // Rainfall: 90% zero, 10% positive
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

  // Recompute the daily continuous aggregate manually so the API can read it.
  await sql`CALL refresh_continuous_aggregate('obs_daily', NULL, NULL)`;
  await sql`CALL refresh_continuous_aggregate('obs_monthly', NULL, NULL)`;

  console.log(JSON.stringify({ dams: dams.length, rowsWritten: written, days: DAYS }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
