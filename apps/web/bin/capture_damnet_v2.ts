/**
 * Capture all dams from dambinran.damnet.or.jp (the new Dam Binran site).
 *
 * Strategy: enumerate WP post IDs by walking the paginated /dams/japan/?page=N
 * listing (87 pages × 30 dams ≈ 2,600 entries, far more than the legacy
 * /wp-json range probe we did before), then fetch each dam's master record
 * via /wp-json/dmap/dam-info/{post_id}. Output is JSONL compatible with
 * apps/web/bin/match_damnet.ts.
 *
 * Usage:
 *   bun run apps/web/bin/capture_damnet_v2.ts \
 *     [--out data/damnet/dams.jsonl] [--concurrency 6] [--max-pages 200]
 */
import { writeFile } from 'node:fs/promises';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  if (k && v) args.set(k.replace(/^--/, ''), v);
}
const OUT = args.get('out') ?? 'data/damnet/dams.jsonl';
const CONCURRENCY = Number(args.get('concurrency') ?? '6');
const MAX_PAGES = Number(args.get('max-pages') ?? '200');
const UA = `DamDataPlatform/0.1 (+contact: ${process.env.HTTP_CONTACT_EMAIL ?? 'matsubokkuri@gmail.com'})`;
const BASE = 'https://dambinran.damnet.or.jp';

interface DamInfo {
  id: number;
  dam_number: string;
  dam_name: string;
  dam_name_kana: string;
  dam_url: string;
  prefecture: string;
  left_bank_location: string;
  river_name: string;
  construction_start_year: string;
  completion_year: string;
  purposes: string;
  type: string;
  height: string;
  crest_length: string;
  embankment_volume: string;
  capacity_total: string;
  capacity_active: string;
  watershed_area: number | string;
  reservoir_area: string;
  operator: string;
  main_contractor: string;
  redevelopment_status: string;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) return null;
    return await r.text();
  } catch {
    return null;
  }
}

async function fetchJson(postId: number): Promise<DamInfo | null> {
  try {
    const r = await fetch(`${BASE}/wp-json/dmap/dam-info/${postId}`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status !== 200) return null;
    const text = await r.text();
    const data = JSON.parse(text) as DamInfo | { code?: string };
    if ('code' in data && data.code) return null;
    return data as DamInfo;
  } catch {
    return null;
  }
}

function extractPostIdsFromPage(html: string): number[] {
  // The listing page renders chip popovers per dam with IDs of the form
  // `popover-chip-purpose{POST_ID}` and `popover-chip-type{POST_ID}`. Both
  // resolve to the same WP post id used by /wp-json/dmap/dam-info/{id}.
  const ids = new Set<number>();
  const re = /popover-chip-(?:purpose|type)([0-9]{4,})/g;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    const id = Number(m[1]);
    if (Number.isFinite(id)) ids.add(id);
    m = re.exec(html);
  }
  return [...ids].sort((a, b) => a - b);
}

async function enumeratePostIds(): Promise<number[]> {
  const all = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchText(`${BASE}/dams/japan/?page=${page}`);
    if (!html) {
      process.stderr.write(`page ${page}: fetch failed, stopping\n`);
      break;
    }
    const ids = extractPostIdsFromPage(html);
    if (ids.length === 0) {
      process.stderr.write(`page ${page}: no IDs, stopping\n`);
      break;
    }
    let added = 0;
    for (const id of ids) {
      if (!all.has(id)) {
        all.add(id);
        added++;
      }
    }
    process.stderr.write(`page ${page}: +${added} (total ${all.size})\n`);
    if (added === 0) {
      // Pagination exhausted (last page repeats earlier IDs in some themes).
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return [...all].sort((a, b) => a - b);
}

async function main(): Promise<void> {
  process.stderr.write('phase 1: enumerating post IDs from list pages...\n');
  const ids = await enumeratePostIds();
  process.stderr.write(`enumerated ${ids.length} post IDs\n`);

  process.stderr.write(`phase 2: fetching dam-info for each ID (concurrency=${CONCURRENCY})...\n`);
  const collected: DamInfo[] = [];
  let done = 0;
  const queue = [...ids];

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      const info = await fetchJson(id);
      done++;
      if (info) collected.push(info);
      if (done % 200 === 0) {
        process.stderr.write(`  progress: ${done}/${ids.length} hits=${collected.length}\n`);
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  collected.sort((a, b) => a.id - b.id);
  await writeFile(OUT, `${collected.map((d) => JSON.stringify(d)).join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ enumerated: ids.length, hits: collected.length, out: OUT }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
