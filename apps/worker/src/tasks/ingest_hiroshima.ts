// apps/worker/src/tasks/ingest_hiroshima.ts
//
// Phase B5 (#9): 広島県防災Web prefectural dam telemetry.
//
// Source: https://www.bousai.pref.hiroshima.lg.jp (Remix SPA). The SPA reads
// a flat-file JSON feed published every 10 minutes:
//
//   /data/dam/data.json                     → { latestDateTimestamp }
//   /data/dam/list/{YYYY-MM-DD-HH-mm}.json  → { items: [...] }
//   /data/master/observatory/dam.json       → master list (static)
//
// The observation feed uses the same field schema as おかやま防災ポータル but
// damEffectiveStorageQuantities is in 千m³ (confirmed: 2651 千m³ = 26.8% of
// 9,900,000 m³ for 小瀬川ダム). Values carry per-field Flg codes where "0" =
// valid and anything else (1=欠, 2=未, 3=閉) means no data.
//
// 18 dams total; 12 prefectural (managerCd 23/24/26) + 5 MLIT (25) already
// covered by cgr-mlit-dam. All 18 report data every observation period; a
// dam whose every field is flagged is provider-marked empty. MLIT dams are
// ingested here too; source_priorities (cgr-mlit at 304, this source at 310)
// ensure cgr-mlit wins as preferredSource for those overlap dams.
//
// Metrics:
//   damQuantitiesLevel            → water level (m)
//   damInflowQuantities           → inflow (m³/s)
//   damTotalReleaseQuantities     → outflow (m³/s)
//   damEffectiveStorageQuantities → effective storage (千m³ → × 1000 = m³)
//   storageRateWaterUseCapacity   → % 利水容量 (preferred, season-aware)
//     fallback: storageRateEffectiveCapacity (有効容量貯水率)
//
// Cron: hourly at :29.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.HIROSHIMA_DAM_URL ?? 'https://www.bousai.pref.hiroshima.lg.jp';
const PREF_CODE = '34';
const SOURCE_ID = 'hiroshima-bousai';

export interface HiroshimaItem {
  name: string;
  observatoryId: number;
  managerCd: string;
  dataTimestamp: string;
  damQuantitiesLevel: number | null;
  damQuantitiesLevelFlg: string;
  damInflowQuantities: number | null;
  damInflowQuantitiesFlg: string;
  damTotalReleaseQuantities: number | null;
  damTotalReleaseQuantitiesFlg: string;
  damEffectiveStorageQuantities: number | null;
  damEffectiveStorageQuantitiesFlg: string;
  storageRateEffectiveCapacity: number | null;
  storageRateEffectiveCapacityFlg: string;
  storageRateWaterUseCapacity: number | null;
  storageRateWaterUseCapacityFlg: string;
}

/** Parse 「YYYY-MM-DD HH:MM:SS」 (JST) → UTC Date. */
export function parseHiroshimaTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]) - 9,
      Number(m[5]),
      Number(m[6]),
    ),
  );
}

/** One item's reading. A Flg other than "0" is the portal's own mark. */
export function hiroshimaReading(it: HiroshimaItem): Reading {
  const field = (value: number | null, flg: string): Cell => cell(value, flg !== '0');
  const level = field(it.damQuantitiesLevel, it.damQuantitiesLevelFlg);
  const inflow = field(it.damInflowQuantities, it.damInflowQuantitiesFlg);
  const outflow = field(it.damTotalReleaseQuantities, it.damTotalReleaseQuantitiesFlg);
  // Storage unit is 千m³; converted to m³ below.
  const storage = field(it.damEffectiveStorageQuantities, it.damEffectiveStorageQuantitiesFlg);
  const rateWaterUse = field(it.storageRateWaterUseCapacity, it.storageRateWaterUseCapacityFlg);
  const rateEffective = field(it.storageRateEffectiveCapacity, it.storageRateEffectiveCapacityFlg);

  const state = cellState([level, inflow, outflow, storage, rateWaterUse, rateEffective]);
  if (state === 'empty') return { state, mark: 'Flg ≠ 0 on every field' };
  if (state === 'unreadable') return { state, why: 'no Flg-0 value' };
  const observedAt = parseHiroshimaTimestamp(it.dataTimestamp ?? '');
  if (!observedAt) return { state: 'unreadable', why: `dataTimestamp "${it.dataTimestamp}"` };
  const storageThouM3 = numberIn(storage);
  // 利水容量貯水率 first: it is the season-aware figure the prefecture leads
  // its own table with, and the 有効容量 one divides by the annual pool
  // (御調ダム 2026-09-11 09:00: 利水 100.0 % vs 有効 20.4 %). Same inversion as
  // issue #19 fixed in kasenbosai and #17 in cgr-mlit/熊本/高知.
  const ratePct = numberIn(rateWaterUse) ?? numberIn(rateEffective);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        storageVolumeM3: storageThouM3 != null ? storageThouM3 * 1000 : null,
        storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      },
    ],
  };
}

/** Every listed dam: the feed's list is the universe. */
export function hiroshimaEntries(items: HiroshimaItem[]): Entry[] {
  return items.map((it) => ({
    key: String(it.observatoryId),
    name: it.name,
    pref: PREF_CODE,
    reading: hiroshimaReading(it),
  }));
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export default ingestTask(SOURCE_ID, async (log) => {
  const { latestDateTimestamp: latest } = await fetchJson<{ latestDateTimestamp: string }>(
    '/data/dam/data.json',
  );
  if (!latest) throw new Error(`${SOURCE_ID}: data.json has no latestDateTimestamp`);
  // 「2026-06-05 08:10:00」 → list/2026-06-05-08-10.json
  const slug = latest.slice(0, 16).replace(/[ :]/g, '-');
  const snapshot = await fetchJson<{ items?: HiroshimaItem[] }>(`/data/dam/list/${slug}.json`);
  if (!snapshot.items) throw new Error(`${SOURCE_ID}: snapshot ${slug} has no items`);
  log(`${SOURCE_ID}: ${snapshot.items.length} dams at ${latest}`);
  return { entries: hiroshimaEntries(snapshot.items) };
});
