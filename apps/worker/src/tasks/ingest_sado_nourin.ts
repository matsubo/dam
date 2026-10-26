// apps/worker/src/tasks/ingest_sado_nourin.ts
//
// 新潟県 佐渡地域振興局 農林水産振興部「【佐渡】農業用ダムの貯水量情報」— 県営農業用ダム 7 基。
//
//   羽茂 / 竹田川 / 小倉川 / 藤津川 / 新穂 / 新穂第2 / 佐和田
//
// Source:
//   https://www.pref.niigata.lg.jp/site/sado-nourinsuisan-nouson/122000000.html
// The index links one static page per dam; each page states its 有効貯水量 and
// one sentence of current data:
//   「令和8年8月15日時点の貯水量は、367,800立法メートルで貯水率は80%、
//     直近10か年平均と比べ152%の貯水率です。」
// None of the seven is in niigata-bousai (河川防災, 県管理 river dams); the two
// 国営 dams on 佐渡 the index mentions are not published here.
//
// Values: volume in m³ and a whole-percent rate against the page's own
// 有効貯水量 (羽茂 367,800 / 460,000 = 80.0 %; 小倉川 529,469 / 706,790 = 74.9 %
// where the master holds 900,000). A page whose rate contradicts that identity
// is unreadable. The date has no hour; stored at JST midnight.
//
// Cadence: irregular, roughly twice a month in かんがい期 (the 8月15日 values
// were posted 8月24日). Polled daily; re-runs upsert the same survey.
// Priority 281 — no other source covers these dams.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const INDEX_URL =
  process.env.SADO_NOURIN_URL ??
  'https://www.pref.niigata.lg.jp/site/sado-nourinsuisan-nouson/122000000.html';

const ORIGIN = 'https://www.pref.niigata.lg.jp';
const PREF_CODE = '15';
const SOURCE_ID = 'sado-nourin';

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

/** A per-dam page's HTML; throws when the page cannot be fetched. */
export type FetchPage = (url: string) => Promise<string>;

// --- parsing ----------------------------------------------------------------

/** Every per-dam page linked from the index, in page order, once each. */
export function parseSadoDamLinks(html: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const m of html.matchAll(
    /href="(\/site\/sado-nourinsuisan-nouson\/\d+\.html)"[^>]*>\s*([^<\s]+ダム)\s*</g,
  )) {
    const name = m[2] as string;
    if (out.some((l) => l.name === name)) continue;
    out.push({ name, url: `${ORIGIN}${m[1]}` });
  }
  return out;
}

/** What one per-dam page publishes: volume and rate at the stated date. */
export function sadoDamReading(html: string): Reading {
  const name = html.match(/<h1>【佐渡】(\S+?ダム)の貯水量情報<\/h1>/)?.[1];
  const text = html.replace(/<[^>]+>/g, '').replace(/,/g, '');
  const capacity = text.match(/有効貯水量\s*(\d+)\s*立[法方]メートル/);
  const current = text.match(
    /令和(\d+)年(\d+)月(\d+)日時点の貯水量は、?\s*(\d+)\s*立[法方]メートルで貯水率は\s*(\d+)\s*[%％]/,
  );
  if (!name) return { state: 'unreadable', why: 'no 【佐渡】…ダムの貯水量情報 heading' };
  if (!capacity) return { state: 'unreadable', why: 'no 有効貯水量' };
  if (!current) return { state: 'unreadable', why: 'no 「…時点の貯水量は」 sentence' };

  const capacityM3 = Number(capacity[1]);
  const volume = Number(current[4]);
  const pct = Number(current[5]);
  // 0 % on an irrigation reservoir is a drained pond, not a reading (0038/0039).
  if (!(capacityM3 > 0 && pct > 0 && pct <= 100)) {
    return { state: 'unreadable', why: `貯水率 ${pct} % of ${capacityM3} m³` };
  }
  // The whole-percent rate must round from volume / 有効貯水量 on the same page.
  if (Math.abs((100 * volume) / capacityM3 - pct) > 1) {
    return { state: 'unreadable', why: `printed ${pct} % is not ${volume}/${capacityM3}` };
  }

  // JST midnight = 15:00 UTC the previous day.
  const observedAt = new Date(
    Date.UTC(2018 + Number(current[1]), Number(current[2]) - 1, Number(current[3]) - 1, 15),
  );
  return {
    state: 'values',
    observations: [{ observedAt, storageVolumeM3: volume, storageRate: pct / 100 }],
  };
}

// --- entries ----------------------------------------------------------------

/**
 * One entry per dam the index links, so one failing page cannot drop a dam;
 * each reads its own page. Exact stem only: 新穂 must not take 新穂第2's
 * page, nor the reverse.
 */
export function sadoNourinEntries(indexHtml: string, fetchPage: FetchPage): Entry[] {
  return parseSadoDamLinks(indexHtml).map((link) => ({
    key: link.name,
    name: link.name,
    pref: PREF_CODE,
    bind: { exact: true },
    reading: async () => sadoDamReading(await fetchPage(link.url)),
  }));
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// A page template change reads as unreadable on every dam while every fetch
// succeeds; the run then fails the job instead of exiting green.
export default ingestTask(SOURCE_ID, async (log) => {
  const entries = sadoNourinEntries(await fetchHtml(INDEX_URL), fetchHtml);
  log(`${SOURCE_ID}: ${entries.length} dam pages linked`);
  // The survey date is the newest value a page publishes: holding it keeps
  // the dam covered between the twice-monthly surveys.
  return { entries, dated: true };
});
