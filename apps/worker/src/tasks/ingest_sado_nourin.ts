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
// is dropped. The date has no hour; stored at JST midnight.
//
// Cadence: irregular, roughly twice a month in かんがい期 (the 8月15日 values
// were posted 8月24日). Polled daily; re-runs upsert the same survey.
// Priority 281 — no other source covers these dams.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const INDEX_URL =
  process.env.SADO_NOURIN_URL ??
  'https://www.pref.niigata.lg.jp/site/sado-nourinsuisan-nouson/122000000.html';

const ORIGIN = 'https://www.pref.niigata.lg.jp';
const PREF_CODE = '15';
const SOURCE_ID = 'sado-nourin';

export interface ParsedPage {
  /** 「羽茂ダム」 as the page heading prints it — the stamp and universe key. */
  name: string;
  observedAt: Date;
  /** 有効貯水量 printed on the page, m³. */
  capacityM3: number;
  storageVolumeM3: number;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number;
}

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

export function parseSadoDamPage(html: string): ParsedPage | null {
  const name = html.match(/<h1>【佐渡】(\S+?ダム)の貯水量情報<\/h1>/)?.[1];
  const text = html.replace(/<[^>]+>/g, '').replace(/,/g, '');
  const capacity = text.match(/有効貯水量\s*(\d+)\s*立[法方]メートル/);
  const current = text.match(
    /令和(\d+)年(\d+)月(\d+)日時点の貯水量は、?\s*(\d+)\s*立[法方]メートルで貯水率は\s*(\d+)\s*[%％]/,
  );
  if (!name || !capacity || !current) return null;

  const capacityM3 = Number(capacity[1]);
  const volume = Number(current[4]);
  const pct = Number(current[5]);
  // 0 % on an irrigation reservoir is a drained pond, not a reading (0038/0039).
  if (!(capacityM3 > 0 && pct > 0 && pct <= 100)) return null;
  // The whole-percent rate must round from volume / 有効貯水量 on the same page.
  if (Math.abs((100 * volume) / capacityM3 - pct) > 1) return null;

  // JST midnight = 15:00 UTC the previous day.
  const observedAt = new Date(
    Date.UTC(2018 + Number(current[1]), Number(current[2]) - 1, Number(current[3]) - 1, 15),
  );
  return { name, observedAt, capacityM3, storageVolumeM3: volume, storageRate: pct / 100 };
}

// --- matching ---------------------------------------------------------------

/** Exact stem only: 新穂 must not take 新穂第2's page, nor the reverse. */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = name.replace(/ダム$/, '');
  let best: BindableMaster | null = null;
  for (const m of masters) {
    if (m.name.replace(/[（(][^）)]*[）)]/g, '').trim() !== stem) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 281,
            '新潟県 佐渡地域振興局 農業用ダムの貯水量情報 — 県営農業用ダム 7 基, 月1-2回 (貯水量+貯水率)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const headers = {
    'user-agent':
      process.env.HTTP_USER_AGENT ??
      'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
  };

  const indexRes = await fetch(INDEX_URL, { headers, signal: AbortSignal.timeout(20_000) });
  if (indexRes.status !== 200) {
    log(`${SOURCE_ID}: index HTTP ${indexRes.status}; aborting`);
    return;
  }
  const links = parseSadoDamLinks(await indexRes.text());

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let fetched = 0;
  let parsed = 0;
  for (const link of links) {
    const damId = chooseMaster(link.name, masters);
    universe.push({
      externalId: link.name,
      name: link.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${link.name}"`);
      continue;
    }
    await bindExternalId(damId, SOURCE_ID, link.name);

    const res = await fetch(link.url, { headers, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 200) {
      log(`${SOURCE_ID}: HTTP ${res.status} for ${link.url}; skipping`);
      continue;
    }
    fetched += 1;
    const page = parseSadoDamPage(await res.text());
    if (!page) {
      log(`${SOURCE_ID}: no usable reading on ${link.url}`);
      continue;
    }
    parsed += 1;
    inputs.push({
      observedAt: page.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: page.storageVolumeM3,
      storageRate: page.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  await recordUniverse(SOURCE_ID, universe);

  const written = await upsertObservations(inputs);
  log(
    `${SOURCE_ID} done: published=${links.length} parsed=${parsed} matched=${inputs.length} written=${written}`,
  );

  // A page template change reads as "no usable reading" on every dam while
  // every fetch succeeds; fail loudly instead of exiting green.
  if (fetched > 0 && parsed === 0) {
    throw new Error(`${SOURCE_ID}: ${fetched} dam pages but no readings — layout change?`);
  }
};

export default task;
