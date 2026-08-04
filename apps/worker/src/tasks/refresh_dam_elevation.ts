// Periodic elevation refresh via GSI's free DEM API.
// Only fills dams where elevation_m IS NULL — existing values are kept.
import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

const refreshDamElevation: Task = async (_payload, _helpers) => {
  const UA =
    process.env.HTTP_USER_AGENT ??
    `dam-data-platform/0.1 (${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`;

  const rows = await sql<{ id: string; lat: number; lng: number }[]>`
    SELECT id::TEXT,
           ST_Y(location::geometry) AS lat,
           ST_X(location::geometry) AS lng
    FROM dams
    WHERE elevation_m IS NULL AND location IS NOT NULL
  `;
  let found = 0;
  for (const r of rows) {
    try {
      const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${r.lng}&lat=${r.lat}&outtype=JSON`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { elevation?: number | string };
      const elev =
        typeof body.elevation === 'number'
          ? body.elevation
          : Number.parseFloat(String(body.elevation ?? ''));
      if (!Number.isFinite(elev)) continue;
      await sql`UPDATE dams SET elevation_m = ${elev}, updated_at = NOW() WHERE id = ${r.id}::BIGINT`;
      found += 1;
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      // skip; retry next run
    }
  }
  console.log(`[master:refresh:elevation] checked=${rows.length} found=${found}`);
};

export default refreshDamElevation;
