// Backfill dams.elevation_m via GSI's public DEM API (国土地理院 標高API).
// Free, no key, polite concurrency = 4.
//
// Usage:
//   bun run bin/fetch_dam_elevation.ts [--refresh] [--limit N] [--concurrency C]
import { sql } from '../packages/db/src/client.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1] ?? '0') : 0;
  const concurrencyFlag = args.indexOf('--concurrency');
  const concurrency = concurrencyFlag >= 0 ? Number(args[concurrencyFlag + 1] ?? '4') : 4;

  const UA =
    process.env.HTTP_USER_AGENT ??
    `dam-data-platform/0.1 (${process.env.HTTP_CONTACT_EMAIL ?? 'matsubokkuri@gmail.com'})`;

  interface Row {
    id: string;
    lat: number;
    lng: number;
  }

  const rows = await sql<Row[]>`
    SELECT id::TEXT,
           ST_Y(location::geometry) AS lat,
           ST_X(location::geometry) AS lng
    FROM dams
    WHERE ${refresh ? sql`TRUE` : sql`elevation_m IS NULL`}
      AND location IS NOT NULL
    ORDER BY id
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;
  console.log(`fetching elevation for ${rows.length} dams (concurrency=${concurrency})`);

  let done = 0;
  let found = 0;
  let missing = 0;
  let errored = 0;

  async function processOne(r: Row): Promise<void> {
    const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${r.lng}&lat=${r.lat}&outtype=JSON`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        errored += 1;
        return;
      }
      const body = (await res.json()) as { elevation?: number | string; hsrc?: string };
      // GSI returns "-----" for points outside the DEM coverage (e.g. open sea).
      const elev =
        typeof body.elevation === 'number'
          ? body.elevation
          : Number.parseFloat(String(body.elevation ?? ''));
      if (!Number.isFinite(elev)) {
        missing += 1;
        return;
      }
      await sql`UPDATE dams SET elevation_m = ${elev}, updated_at = NOW() WHERE id = ${r.id}::BIGINT`;
      found += 1;
    } catch (err) {
      errored += 1;
      if (errored <= 5) console.error('  err', r.id, (err as Error).message);
    } finally {
      done += 1;
      if (done % 100 === 0) {
        console.log(
          `  progress: ${done}/${rows.length} (found=${found}, missing=${missing}, err=${errored})`,
        );
      }
    }
  }

  const queue = [...rows];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const r = queue.shift();
      if (!r) return;
      await processOne(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`\ndone: found=${found}, missing=${missing}, errored=${errored} of ${rows.length}`);
}

main()
  .then(() => sql.end())
  .catch((e) => {
    console.error(e);
    sql.end();
    process.exit(1);
  });
