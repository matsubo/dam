// apps/worker/src/tasks/ingest_kkr_mlit.ts
//
// 国土交通省 近畿地方整備局 — 12 国管理ダム 貯水率 (JSON feed, 日次).
//
//   Dams (key → name → prefecture):
//     managawa  → 真名川ダム  (Fukui  18)
//     kuzuryu   → 九頭竜ダム  (Fukui  18)
//     amagase   → 天ヶ瀬ダム  (Kyoto  26)
//     hiyoshi   → 日吉ダム    (Kyoto  26)
//     muro      → 室生ダム    (Nara   29)
//     syourenji → 青蓮寺ダム  (Mie    24)
//     takayama  → 高山ダム    (Nara   29)
//     nunome    → 布目ダム    (Nara   29)
//     hinati    → 比奈知ダム  (Mie    24)
//     hitokura  → 一庫ダム    (Hyogo  28)
//     otaki     → 大滝ダム    (Nara   29)
//     sarutani  → 猿谷ダム    (Nara   29)
//
// Source:
//   https://www.kkr.mlit.go.jp/river/json/dam.json
// Format: UTF-8 JSON. "datetime" field is JST "YYYY-MM-DD HH:MM:SS".
//   Each dam entry: { chosuiritsu: { today: "XX.X", diff: ["X.X", "↑"] } }
// Cadence: weekday daily (土日祝日除く). We poll daily at 03:00 UTC = 12:00 JST.
//   UPSERT on (dam_id, observed_at, source_id) makes repeated polls idempotent.
// Priority: 302 — MLIT national management, daily cadence.
//   Slightly below hourly MLIT sources (304) but above JWA daily (296).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL = process.env.KKR_MLIT_URL ?? 'https://www.kkr.mlit.go.jp/river/json/dam.json';

const SOURCE_ID = 'kkr-mlit-dam';

// Map from JSON key to canonical Japanese dam name
const KEY_TO_NAME: Record<string, string> = {
  managawa: '真名川ダム',
  kuzuryu: '九頭竜ダム',
  amagase: '天ヶ瀬ダム',
  hiyoshi: '日吉ダム',
  muro: '室生ダム',
  syourenji: '青蓮寺ダム',
  takayama: '高山ダム',
  nunome: '布目ダム',
  hinati: '比奈知ダム',
  hitokura: '一庫ダム',
  otaki: '大滝ダム',
  sarutani: '猿谷ダム',
};

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  key: string;
  damName: string;
  observedAt: Date;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY-MM-DD HH:MM:SS" JST → UTC Date */
export function parseKkrDatetime(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  const sc = Number(m[6]);
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, sc, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

interface KkrJson {
  datetime: string;
  dam: Record<string, { chosuiritsu?: { today?: string } }>;
}

export function parseKkrJson(raw: unknown): ParsedRow[] {
  const data = raw as KkrJson;
  const observedAt = parseKkrDatetime(data.datetime ?? '');
  if (!observedAt) return [];

  const rows: ParsedRow[] = [];
  for (const [key, name] of Object.entries(KEY_TO_NAME)) {
    const entry = data.dam?.[key];
    if (!entry) continue;
    const rateStr = entry.chosuiritsu?.today?.trim() ?? '';
    const rate = rateStr === '' ? null : Number(rateStr);
    rows.push({
      key,
      damName: name,
      observedAt,
      storageRate: rate !== null && Number.isFinite(rate) ? rate : null,
    });
  }
  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 302,
            '国土交通省 近畿地方整備局 — 12 国管理ダム 貯水率 (JSON, 日次, 土日祝除く)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .replace(/貯水池$/, '')
    .trim();
}

interface DamMatch {
  damName: string;
  damId: bigint;
}

/**
 * Match every dam in KEY_TO_NAME, not just the ones the current fetch
 * returned. KEY_TO_NAME *is* the feed's published catalogue, so walking it
 * keeps `source_universe` complete on a day when one dam's entry is missing
 * from the JSON; the match itself depends only on the name, never on the
 * fetched values.
 */
async function matchMaster(log: (s: string) => void): Promise<DamMatch[]> {
  // Search all dams (no pref_code filter — these span Fukui/Kyoto/Nara/Mie/Hyogo)
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];

  for (const [key, damName] of Object.entries(KEY_TO_NAME)) {
    const stem = normalizeName(damName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === damName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    // The feed's own JSON key is the stable id; these 12 dams span five
    // prefectures and the feed publishes no pref code, so leave it null.
    universe.push({
      externalId: key,
      name: damName,
      resolvedDamId: best?.id ?? null,
    });

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${damName}"`);
      continue;
    }

    out.push({ damName, damId: best.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${key}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${key}
    `;
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; aborting`);
    return;
  }

  const json: unknown = await r.json();
  const rows = parseKkrJson(json);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(log);
  const damByName = new Map(matches.map((m) => [m.damName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.damName);
    if (!damId) continue;
    if (p.storageRate === null) {
      log(`${SOURCE_ID}: no storage rate for "${p.damName}"; skipping`);
      continue;
    }

    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
