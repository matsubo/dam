// apps/worker/src/tasks/ingest_okayama.ts
//
// Phase B2 (#6): おかやま防災ポータル prefectural dam telemetry.
//
// Source: https://www.bousai.pref.okayama.jp (Dojo SPA). The SPA reads a
// flat-file JSON feed published every 30 minutes:
//
//   data/damQuantities/data.json            → { latestDateTimestamp }
//   data/damQuantities/list/{YYYY-MM-DD-HH-MM}.json → { items: [...] }
//
// Each item carries the dam's current values plus a per-field "Flg" where
// "0" means the value is valid and anything else (2/4) is the portal's own
// 欠測 / 調整中 mark. 21 dams are listed; ~15 report a storage value at any
// given fetch, and a dam whose every field is flagged is provider-marked
// empty. 苫田ダム(国) is also covered by cgr-mlit-dam at higher priority;
// source priority resolves the overlap.
//
// Values:
//   damQuantitiesLevel            → water level (m)
//   damInflowQuantities           → inflow (m³/s)
//   damTotalReleaseQuantities     → outflow (m³/s)
//   damEffectiveStorageQuantities → effective storage (m³, already absolute)
//   storageRateEffectiveCapacity  → % of effective capacity (often absent);
//     fall back to storageRateWaterUseCapacity (利水貯水率), which the
//     portal itself surfaces as the headline 貯水率 for most dams.
//
// Cron: hourly at :21 (feed refreshes every 30 min; we take the freshest
// snapshot and spread load away from the other prefectural sources).

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.OKAYAMA_DAM_URL ?? 'https://www.bousai.pref.okayama.jp';
const PREF_CODE = '33';
const SOURCE_ID = 'okayama-bousai';

interface OkayamaItem {
  name: string;
  observatoryId: string;
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
  dataTimestamp: string;
}

/** Parse 「YYYY-MM-DD HH:MM:SS」 (JST) → UTC Date. */
export function parseOkayamaTimestamp(s: string): Date | null {
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
export function okayamaReading(it: OkayamaItem): Reading {
  const field = (value: number | null, flg: string): Cell => cell(value, flg !== '0');
  const level = field(it.damQuantitiesLevel, it.damQuantitiesLevelFlg);
  const inflow = field(it.damInflowQuantities, it.damInflowQuantitiesFlg);
  const outflow = field(it.damTotalReleaseQuantities, it.damTotalReleaseQuantitiesFlg);
  const storage = field(it.damEffectiveStorageQuantities, it.damEffectiveStorageQuantitiesFlg);
  const rateEffective = field(it.storageRateEffectiveCapacity, it.storageRateEffectiveCapacityFlg);
  const rateWaterUse = field(it.storageRateWaterUseCapacity, it.storageRateWaterUseCapacityFlg);

  const state = cellState([level, inflow, outflow, storage, rateEffective, rateWaterUse]);
  if (state === 'empty') return { state, mark: 'Flg ≠ 0 on every field' };
  if (state === 'unreadable') return { state, why: 'no Flg-0 value' };
  const observedAt = parseOkayamaTimestamp(it.dataTimestamp ?? '');
  if (!observedAt) return { state: 'unreadable', why: `dataTimestamp "${it.dataTimestamp}"` };
  // 有効貯水率 is often absent; the portal's headline 貯水率 is the 利水 one.
  const ratePct = numberIn(rateEffective) ?? numberIn(rateWaterUse);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        // damEffectiveStorageQuantities is already in m³ on this feed.
        storageVolumeM3: numberIn(storage),
        storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      },
    ],
  };
}

/** Every listed dam: the feed's list is the universe. */
export function okayamaEntries(items: OkayamaItem[]): Entry[] {
  return items.map((it) => ({
    key: it.observatoryId,
    name: it.name,
    pref: PREF_CODE,
    reading: okayamaReading(it),
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
    `/data/damQuantities/data.json?request.preventCache=${Date.now()}`,
  );
  // 「2026-05-25 11:30:00」 → list/2026-05-25-11-30.json
  const slug = latest.slice(0, 16).replace(/[ :]/g, '-');
  const { items } = await fetchJson<{ items: OkayamaItem[] }>(
    `/data/damQuantities/list/${slug}.json`,
  );
  log(`${SOURCE_ID}: ${items.length} dams at ${latest}`);
  return { entries: okayamaEntries(items) };
});
