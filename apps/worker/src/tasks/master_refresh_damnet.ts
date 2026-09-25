// apps/worker/src/tasks/master_refresh_damnet.ts
//
// Pull current master metadata for every dam from dambinran.damnet.or.jp:
//
//   1. Walk paginated /dams/japan/?page=N (HTML) to enumerate WP post IDs
//      (87 pages × 30 dams ≈ 2,600 entries).
//   2. Fetch /wp-json/dmap/dam-info/{post_id} (JSON) for each ID.
//   3. Assign each record to a master by (pref_code, name, （元）/（再）
//      marker) — see packages/adapters/damnet/src/assign.ts. Stamp
//      external_ids->>'damnet' and back-fill attributes.
//
// Replaces an earlier implementation that pointed at the legacy
// `damnet.or.jp/Dambinran/binran/All_Dam.html` URL — that endpoint now 301s
// to dambinran.damnet.or.jp/ and the old HTML parser returned an empty list.
//
// Idempotent: a rerun over the same records makes no stamp changes, and
// attribute UPDATEs use COALESCE(new, existing).

import { applyDamnetCaptures, type DamInfo } from '@dam/adapters-damnet';
import type { Task } from 'graphile-worker';

const BASE = process.env.DAMNET_V2_BASE_URL ?? 'https://dambinran.damnet.or.jp';
const MAX_PAGES = Number(process.env.DAMNET_V2_MAX_PAGES ?? '200');
const ENUMERATE_DELAY_MS = Number(process.env.DAMNET_V2_LIST_DELAY_MS ?? '250');
const FETCH_DELAY_MS = Number(process.env.DAMNET_V2_FETCH_DELAY_MS ?? '120');
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.DAMNET_V2_CONCURRENCY ?? '4')));
const UA =
  process.env.HTTP_USER_AGENT ??
  `DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: ${process.env.HTTP_CONTACT_EMAIL ?? 'https://discord.gg/UbWqspWbAk'})`;

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

async function fetchDamInfo(postId: number): Promise<DamInfo | null> {
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
  // Listing page renders chip popovers per dam with IDs of the form
  // `popover-chip-purpose{POST_ID}` / `popover-chip-type{POST_ID}`.
  const ids = new Set<number>();
  const re = /popover-chip-(?:purpose|type)([0-9]{4,})/g;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    const id = Number(m[1]);
    if (Number.isFinite(id)) ids.add(id);
    m = re.exec(html);
  }
  return [...ids];
}

async function enumeratePostIds(log: (s: string) => void): Promise<number[]> {
  const all = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchText(`${BASE}/dams/japan/?page=${page}`);
    if (!html) {
      log(`page ${page}: fetch failed, stopping`);
      break;
    }
    const ids = extractPostIdsFromPage(html);
    if (ids.length === 0) {
      log(`page ${page}: no IDs, stopping`);
      break;
    }
    let added = 0;
    for (const id of ids) {
      if (!all.has(id)) {
        all.add(id);
        added++;
      }
    }
    if (added === 0) {
      // Pagination exhausted (some themes loop the last page).
      break;
    }
    if (page % 10 === 0) log(`page ${page}: total ${all.size}`);
    await new Promise((r) => setTimeout(r, ENUMERATE_DELAY_MS));
  }
  return [...all].sort((a, b) => a - b);
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  log(`damnet-v2: enumerating post IDs from ${BASE}/dams/japan/`);
  const postIds = await enumeratePostIds(log);
  log(`damnet-v2: enumerated ${postIds.length} post IDs`);

  if (postIds.length === 0) {
    log('damnet-v2: nothing to do (no IDs); aborting');
    return;
  }

  // Fetch every record first: which record belongs to which master is decided
  // per name group (see assignCaptures), so nothing is written mid-stream.
  const captures: DamInfo[] = [];
  const queue = [...postIds];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      const info = await fetchDamInfo(id);
      if (info) captures.push(info);
      if (captures.length > 0 && captures.length % 200 === 0) {
        log(`damnet-v2: fetched=${captures.length}/${postIds.length}`);
      }
      await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const stats = await applyDamnetCaptures(captures, log);
  log(`damnet-v2 done: ${JSON.stringify(stats)}`);
};

export default task;
