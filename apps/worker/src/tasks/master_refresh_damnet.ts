// apps/worker/src/tasks/master_refresh_damnet.ts
//
// Pull current master metadata for every dam from dambinran.damnet.or.jp:
//
//   1. Walk paginated /dams/japan/?page=N (HTML) to enumerate WP post IDs
//      (87 pages × 30 dams ≈ 2,600 entries).
//   2. Fetch /wp-json/dmap/dam-info/{post_id} (JSON) for each ID.
//   3. Match each capture to the local master by (pref_code + normalised
//      name). Stamp external_ids->>'damnet' and back-fill any missing
//      attributes (name_kana, manager, type, capacities, ...).
//
// Replaces an earlier implementation that pointed at the legacy
// `damnet.or.jp/Dambinran/binran/All_Dam.html` URL — that endpoint now 301s
// to dambinran.damnet.or.jp/ and the old HTML parser returned an empty list.
//
// Idempotent: every UPDATE uses COALESCE so we never overwrite existing
// values, and the dam_number uniqueness constraint is checked before
// stamping external_ids->>'damnet'.

import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

const BASE = process.env.DAMNET_V2_BASE_URL ?? 'https://dambinran.damnet.or.jp';
const MAX_PAGES = Number(process.env.DAMNET_V2_MAX_PAGES ?? '200');
const ENUMERATE_DELAY_MS = Number(process.env.DAMNET_V2_LIST_DELAY_MS ?? '250');
const FETCH_DELAY_MS = Number(process.env.DAMNET_V2_FETCH_DELAY_MS ?? '120');
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.DAMNET_V2_CONCURRENCY ?? '4')));
const UA =
  process.env.HTTP_USER_AGENT ??
  `DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: ${process.env.HTTP_CONTACT_EMAIL ?? 'https://discord.gg/UbWqspWbAk'})`;

interface DamInfo {
  id: number;
  dam_number: string;
  dam_name: string;
  dam_name_kana: string;
  prefecture: string;
  river_name: string;
  completion_year: string;
  construction_start_year: string;
  type: string;
  height: string;
  capacity_total: string;
  capacity_active: string;
  operator: string;
  purposes: string;
  crest_length: string;
  embankment_volume: string;
  watershed_area: string | number;
  reservoir_area: string | number;
  left_bank_location: string;
  main_contractor: string;
  redevelopment_status: string;
}

const TYPE_LETTER_TO_LABEL: Record<string, string> = {
  G: '重力式コンクリート',
  A: 'アーチ式コンクリート',
  GA: '重力式アーチ',
  HG: '中空重力',
  E: 'アースフィル',
  R: 'ロックフィル',
  CFRD: 'コンクリート表面遮水壁型ロックフィル',
  GE: '重力式コンクリート・アースフィル複合',
  GF: '重力式コンクリート・フィル複合',
  BU: 'バットレス',
  MA: '多目的アーチ',
};

const PREFECTURES_BY_NAME: Record<string, string> = {
  北海道: '01',
  青森県: '02',
  岩手県: '03',
  宮城県: '04',
  秋田県: '05',
  山形県: '06',
  福島県: '07',
  茨城県: '08',
  栃木県: '09',
  群馬県: '10',
  埼玉県: '11',
  千葉県: '12',
  東京都: '13',
  神奈川県: '14',
  新潟県: '15',
  富山県: '16',
  石川県: '17',
  福井県: '18',
  山梨県: '19',
  長野県: '20',
  岐阜県: '21',
  静岡県: '22',
  愛知県: '23',
  三重県: '24',
  滋賀県: '25',
  京都府: '26',
  大阪府: '27',
  兵庫県: '28',
  奈良県: '29',
  和歌山県: '30',
  鳥取県: '31',
  島根県: '32',
  岡山県: '33',
  広島県: '34',
  山口県: '35',
  徳島県: '36',
  香川県: '37',
  愛媛県: '38',
  高知県: '39',
  福岡県: '40',
  佐賀県: '41',
  長崎県: '42',
  熊本県: '43',
  大分県: '44',
  宮崎県: '45',
  鹿児島県: '46',
  沖縄県: '47',
};

interface DamRow {
  id: bigint;
  slug: string;
  name: string;
  pref_code: string;
  external_ids: Record<string, string> | null;
}

function normalizeName(s: string): string {
  // NDI splits redeveloped dams into separate rows suffixed with （再）/（元）/
  // （新）. Strip those + the trailing ダム/貯水池/池 suffix so both NDI rows
  // collapse onto the same Damnet entry.
  return s
    .normalize('NFKC')
    .replace(/[（(](?:再|元|新)[）)]/gu, '')
    .replace(/(?:ダム|貯水池|池)$/u, '')
    .trim()
    .toLowerCase();
}

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (!v || v === '-') return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function intish(v: string): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
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

interface Stats {
  enumerated: number;
  fetched: number;
  matched: number;
  skipped_no_pref: number;
  skipped_not_found: number;
  skipped_conflict: number;
  attached: number;
  attrs_updated: number;
  slug_updated: number;
}

async function applyCapture(
  c: DamInfo,
  damByKey: Map<string, DamRow[]>,
  allSlugs: Set<string>,
  stats: Stats,
): Promise<void> {
  const prefCode = PREFECTURES_BY_NAME[c.prefecture];
  if (!prefCode) {
    stats.skipped_no_pref++;
    return;
  }
  const key = `${prefCode}|${normalizeName(c.dam_name)}`;
  const targets = damByKey.get(key);
  if (!targets || targets.length === 0) {
    stats.skipped_not_found++;
    return;
  }
  stats.matched++;
  const target = targets[0];
  if (!target) return;

  // 1. Stamp external_ids.damnet (idempotent + uniqueness-checked).
  const alreadyHas = target.external_ids?.damnet === c.dam_number;
  if (!alreadyHas) {
    const conflict = await sql<{ id: bigint }[]>`
      SELECT id FROM dams
      WHERE external_ids->>'damnet' = ${c.dam_number} AND id <> ${target.id}
      LIMIT 1
    `;
    if (conflict.length > 0) {
      stats.skipped_conflict++;
      return;
    }
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('damnet', ${c.dam_number}::text)
      WHERE id = ${target.id}
    `;
    stats.attached++;
  }

  // 2. Back-fill master attributes (COALESCE — never overwrite). Apply to
  //    every row in the name-collision group so （再）/（元）siblings inherit
  //    the same metadata.
  const completed = intish(c.completion_year);
  const heightM = num(c.height);
  const capacityTotalK = num(c.capacity_total);
  const capacityM3 = capacityTotalK !== null ? capacityTotalK * 1_000 : null;
  const capacityActiveK = num(c.capacity_active);
  const activeCapacityM3 = capacityActiveK !== null ? capacityActiveK * 1_000 : null;
  const typeLabel = c.type ? (TYPE_LETTER_TO_LABEL[c.type] ?? c.type) : null;
  const operator = c.operator || null;
  const kana = c.dam_name_kana || null;
  const constructionStart = intish(c.construction_start_year);
  const purposes = c.purposes || null;
  const crestLengthM = num(c.crest_length);
  const embankmentK = num(c.embankment_volume);
  const embankmentVolumeM3 = embankmentK !== null ? embankmentK * 1_000 : null;
  const watershedAreaKm2 = num(c.watershed_area);
  const reservoirAreaHa = num(c.reservoir_area);
  const reservoirAreaKm2 = reservoirAreaHa != null ? reservoirAreaHa / 100 : null;
  const leftBankLocation = c.left_bank_location || null;
  const mainContractor = c.main_contractor || null;
  const redevelopmentStatus = c.redevelopment_status || null;
  const hasAnyUpdate =
    kana ||
    operator ||
    typeLabel ||
    heightM ||
    capacityM3 ||
    activeCapacityM3 ||
    completed ||
    constructionStart ||
    purposes ||
    crestLengthM ||
    embankmentVolumeM3 ||
    watershedAreaKm2 ||
    reservoirAreaKm2 ||
    leftBankLocation ||
    mainContractor ||
    redevelopmentStatus;
  if (hasAnyUpdate) {
    const ids = targets.map((t) => t.id.toString());
    await sql`
      UPDATE dams SET
        name_kana               = COALESCE(${kana}, name_kana),
        manager                 = COALESCE(${operator}, manager),
        type                    = COALESCE(${typeLabel}, type),
        height_m                = COALESCE(${heightM}, height_m),
        total_capacity_m3       = COALESCE(${capacityM3}, total_capacity_m3),
        active_capacity_m3      = COALESCE(${activeCapacityM3}, active_capacity_m3),
        effective_capacity_m3   = COALESCE(${activeCapacityM3}, effective_capacity_m3),
        completed_year          = COALESCE(${completed}, completed_year),
        construction_start_year = COALESCE(${constructionStart}, construction_start_year),
        purposes                = COALESCE(${purposes}, purposes),
        crest_length_m          = COALESCE(${crestLengthM}, crest_length_m),
        embankment_volume_m3    = COALESCE(${embankmentVolumeM3}, embankment_volume_m3),
        watershed_area_km2      = COALESCE(${watershedAreaKm2}, watershed_area_km2),
        reservoir_area_km2      = COALESCE(${reservoirAreaKm2}, reservoir_area_km2),
        left_bank_location      = COALESCE(${leftBankLocation}, left_bank_location),
        main_contractor         = COALESCE(${mainContractor}, main_contractor),
        redevelopment_status    = COALESCE(${redevelopmentStatus}, redevelopment_status)
      WHERE id::TEXT = ANY(${ids}::TEXT[])
    `;
    stats.attrs_updated += targets.length;
  }

  // 3. Repair placeholder slugs (`dam-NNNN-PP`) once we know the kana.
  if (target.slug.startsWith('dam-') && kana) {
    const base = toSlug(kana) || target.slug.replace(/^dam-/, '').split('-')[0] || '';
    if (base) {
      const candidate = `${base}-${prefCode}`;
      const newSlug = suffixedSlug(candidate, allSlugs);
      if (newSlug !== target.slug) {
        allSlugs.delete(target.slug);
        allSlugs.add(newSlug);
        await sql`UPDATE dams SET slug = ${newSlug} WHERE id = ${target.id}`;
        stats.slug_updated++;
      }
    }
  }
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  const stats: Stats = {
    enumerated: 0,
    fetched: 0,
    matched: 0,
    skipped_no_pref: 0,
    skipped_not_found: 0,
    skipped_conflict: 0,
    attached: 0,
    attrs_updated: 0,
    slug_updated: 0,
  };

  log(`damnet-v2: enumerating post IDs from ${BASE}/dams/japan/`);
  const postIds = await enumeratePostIds(log);
  stats.enumerated = postIds.length;
  log(`damnet-v2: enumerated ${postIds.length} post IDs`);

  if (postIds.length === 0) {
    log('damnet-v2: nothing to do (no IDs); aborting');
    return;
  }

  // Preload master dams so the matching loop is O(captures), not O(captures × dams).
  const allDams = await sql<DamRow[]>`
    SELECT id, slug, name, pref_code, external_ids FROM dams
  `;
  const damByKey = new Map<string, DamRow[]>();
  for (const d of allDams) {
    const key = `${d.pref_code}|${normalizeName(d.name)}`;
    const list = damByKey.get(key);
    if (list) list.push(d);
    else damByKey.set(key, [d]);
  }
  const allSlugs = new Set(allDams.map((d) => d.slug));

  // Fetch + apply with bounded concurrency. Each capture's apply runs UPDATEs
  // serialised within its own iteration; multiple iterations may overlap on
  // the network fetch but DB writes interleave on the connection pool.
  const queue = [...postIds];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      const info = await fetchDamInfo(id);
      if (info) {
        stats.fetched++;
        try {
          await applyCapture(info, damByKey, allSlugs, stats);
        } catch (err) {
          helpers.logger.warn(`apply failed for postId=${id}: ${(err as Error).message}`);
        }
      }
      if (stats.fetched > 0 && stats.fetched % 200 === 0) {
        log(
          `damnet-v2: fetched=${stats.fetched}/${postIds.length} matched=${stats.matched} attached=${stats.attached}`,
        );
      }
      await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  log(`damnet-v2 done: ${JSON.stringify(stats)}`);
};

export default task;
