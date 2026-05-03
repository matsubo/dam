// Scrape one cover image URL per dam from Damnet (dambinran.damnet.or.jp).
//
// Damnet's per-dam page embeds photos at /wp-content/uploads/YYYY/MM/{NNNN}DC*.jpg
// where {NNNN} is the dam_number. We extract the first such URL and store it
// in dams.image_url so the UI can render it as a cover.
//
// Idempotent — skips dams that already have image_url set unless --refresh.
//
// Concurrency is intentionally low (4) to be polite to the upstream.
//
// Usage:
//   bun run bin/fetch_dam_images.ts [--refresh] [--limit N] [--concurrency C]
// Bun's runtime doesn't resolve workspace aliases for files outside a
// workspace package, so use a relative import.
import { sql } from '../packages/db/src/client.ts';

async function main(): Promise<void> {
const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const limit = Number(args[args.indexOf('--limit') + 1] ?? '0') || null;
const concurrency = Number(args[args.indexOf('--concurrency') + 1] ?? '4') || 4;

const BASE = 'https://dambinran.damnet.or.jp';
const UA =
  process.env.HTTP_USER_AGENT ??
  process.env.KASENBOSAI_USER_AGENT ??
  `dam-data-platform/0.1 (${process.env.HTTP_CONTACT_EMAIL ?? 'matsubokkuri@gmail.com'})`;

interface Row {
  id: string;
  damnet: string | null;
  current: string | null;
}

const rows = await sql<Row[]>`
  SELECT id::TEXT,
         external_ids->>'damnet' AS damnet,
         image_url AS current
  FROM dams
  WHERE external_ids ? 'damnet'
    AND ${refresh ? sql`TRUE` : sql`image_url IS NULL`}
  ORDER BY id
  ${limit ? sql`LIMIT ${limit}` : sql``}
`;

console.log(`fetching cover images for ${rows.length} dams (concurrency=${concurrency})`);

let done = 0;
let found = 0;
let missing = 0;
let errored = 0;

async function processOne(row: Row): Promise<void> {
  if (!row.damnet) return;
  const url = `${BASE}/dams/japan/${row.damnet}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      errored += 1;
      return;
    }
    const html = await res.text();
    // Match the first uploaded photo (jpg/jpeg/png/webp) under /wp-content/uploads/.
    // Site logos and theme assets live under /wp-content/themes/, so they're skipped.
    const match = html.match(
      /https:\/\/dambinran\.damnet\.or\.jp\/wp-content\/uploads\/[^"\s)]+\.(?:jpe?g|png|webp)/i,
    );
    if (!match) {
      missing += 1;
      return;
    }
    const imageUrl = match[0];
    await sql`UPDATE dams SET image_url = ${imageUrl}, updated_at = NOW() WHERE id = ${row.id}::BIGINT`;
    found += 1;
  } catch (err) {
    errored += 1;
    if (errored <= 5) console.error('  err', row.damnet, (err as Error).message);
  } finally {
    done += 1;
    if (done % 50 === 0) {
      console.log(`  progress: ${done}/${rows.length} (found=${found}, missing=${missing}, err=${errored})`);
    }
  }
}

// Worker pool: keep `concurrency` requests in flight at once.
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
