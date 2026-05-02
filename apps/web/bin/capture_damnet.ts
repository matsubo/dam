/**
 * Capture damnet (dambinran.damnet.or.jp) dam data via the WordPress
 * `/wp-json/dmap/dam-info/{wp_post_id}` JSON API. Probes the post-ID range
 * and saves successful responses to a JSONL file (one line per dam).
 *
 * Usage:
 *   bun run apps/web/bin/capture_damnet.ts [--from 124000] [--to 128000] \
 *                                          [--concurrency 8] [--out data/damnet/dams.jsonl]
 */
import { writeFile } from 'node:fs/promises';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  if (k && v) args.set(k.replace(/^--/, ''), v);
}
const FROM = Number(args.get('from') ?? '123500');
const TO = Number(args.get('to') ?? '128000');
const CONCURRENCY = Number(args.get('concurrency') ?? '8');
const OUT = args.get('out') ?? 'data/damnet/dams.jsonl';
const UA = `DamDataPlatform/0.1 (+contact: ${process.env.HTTP_CONTACT_EMAIL ?? 'matsubokkuri@gmail.com'})`;

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

async function fetchOne(postId: number): Promise<DamInfo | null> {
  try {
    const r = await fetch(`https://dambinran.damnet.or.jp/wp-json/dmap/dam-info/${postId}`, {
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

async function main(): Promise<void> {
  const ids: number[] = [];
  for (let i = FROM; i <= TO; i++) ids.push(i);
  const collected: DamInfo[] = [];
  let done = 0;

  const worker = async (queue: number[]): Promise<void> => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      const info = await fetchOne(id);
      done++;
      if (info) collected.push(info);
      if (done % 500 === 0) {
        process.stderr.write(`progress: ${done}/${ids.length} hits=${collected.length}\n`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const queue = [...ids];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  collected.sort((a, b) => a.id - b.id);
  await writeFile(OUT, `${collected.map((d) => JSON.stringify(d)).join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ probed: ids.length, hits: collected.length, out: OUT }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
