// apps/worker/src/tasks/ingest_tottori_bousai.ts
//
// 鳥取県防災Web dam telemetry.
//
// Source: https://www.bousai.pref.tottori.lg.jp (Remix SPA, same framework as
// 広島県防災Web). Pointer → list JSON pattern:
//
//   /data/dam/data.json                    → { latestDateTimestamp }
//   /data/dam/list/{YYYY-MM-DD-HH-mm}.json → { items: [...] }
//
// 6 dams total (prefectural mgr=40 + mgr=41):
//   百谷/佐治川/東郷/賀祥/朝鍋 → already in tottori-dam (priority 307)
//   菅沢                        → new coverage (not in tottoridam.jp)
//
// source_priorities: tottori-bousai=312 outranks tottori-dam=307 and
// cgr-mlit-dam=304 (priority DESC wins), so it is the chart source for all 6.
//
// damEffectiveStorageQuantities is in 千m³ (× 1000 → m³); confirmed by
// 菅沢: 10,604 千m³ = 61.7% of 17,200,000 m³ effective capacity.
//
// Some items are not the dam's own telemetry, and all carry flag "0" (normal):
//   - incomplete hourly lists (total=2 — 朝鍋 + 菅沢 — instead of 6, ~2 a day
//     in September 2026) hold a 朝鍋 placeholder reading 0 m / 0 千m³, and at
//     times a 菅沢 item copying it field for field;
//   - complete lists sometimes hold a 菅沢 item copying 朝鍋's real values
//     (list 2026-09-27-05-20: both 102.89 m / 280 千m³ / 24 %).
// Each such item prints its own 最低水位 (97.0 m for 朝鍋, 353.1 m for 菅沢),
// and its level sits far below it. Stored as-is they were 423 prod rows of
// plunges on the chart (cleaned by deploy/ops/oneoff/
// 2026-09-28_tottori_bousai_placeholders.sql), so an item whose level is more
// than MIN_LEVEL_MARGIN_M below its own 最低水位 is unreadable whole — its
// rate and flows are another dam's too. A list made only of such items reads
// nothing, and the run fails the job so the next attempt fetches again.
//
// Cron: hourly at :33.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.TOTTORI_BOUSAI_URL ?? 'https://www.bousai.pref.tottori.lg.jp';
const PREF_CODE = '31';
const SOURCE_ID = 'tottori-bousai';
/** managerCd of 鳥取県's own dams; "41" is 国 (the site's manager legend). */
const PREF_MANAGER_CD = '40';

interface TottoriBousaiItem {
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
  /** 最低水位 [EL.m] of the dam, printed on every item. */
  minWaterLevel: number | null;
}

/** Parse 「YYYY-MM-DD HH:MM:SS」 (JST) → UTC Date. */
export function parseTottoriTimestamp(s: string): Date | null {
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

/** How far below its own 最低水位 a level may read before the item is taken
 *  for another dam's data. Every real prod reading since 2026-06-05 is above
 *  最低水位 (closest: 百谷 62.37 vs 60.4 m); the placeholders and copies sit
 *  97–353 m below it. */
const MIN_LEVEL_MARGIN_M = 20;

/** One item's reading; a Flg other than "0" is the site's own mark. */
export function tottoriReading(it: TottoriBousaiItem): Reading {
  if (
    it.damQuantitiesLevel != null &&
    it.minWaterLevel != null &&
    it.damQuantitiesLevel < it.minWaterLevel - MIN_LEVEL_MARGIN_M
  ) {
    return {
      state: 'unreadable',
      why: `level ${it.damQuantitiesLevel} m is far below its 最低水位 ${it.minWaterLevel} m: another dam's values`,
    };
  }
  const field = (value: number | null, flg: string): Cell => cell(value, flg !== '0');
  const level = field(it.damQuantitiesLevel, it.damQuantitiesLevelFlg);
  const inflow = field(it.damInflowQuantities, it.damInflowQuantitiesFlg);
  const outflow = field(it.damTotalReleaseQuantities, it.damTotalReleaseQuantitiesFlg);
  const storageThou = field(it.damEffectiveStorageQuantities, it.damEffectiveStorageQuantitiesFlg);
  const rateWaterUse = field(it.storageRateWaterUseCapacity, it.storageRateWaterUseCapacityFlg);
  // Prefer 利水容量貯水率: it is the rate the manager publishes, against the
  // current-season 利水容量. 有効容量貯水率 divides by an annual capacity and
  // understates flood-control dams — the inversion issue #19 found in
  // kasenbosai. tottori-bousai is trusted_rate_basis, so the stored rate is
  // also back-solved into the denominator the API reports. The 利水 column
  // has been null/flg=2 for every dam since June 2026 (the site itself
  // renders it as "-").
  //
  // Without it, only a dam 鳥取県 manages itself (managerCd "40" = 県) keeps
  // the 有効 column: that is the manager's own figure, and kasenbosai stores
  // the same value every hour. For 国's 菅沢 ("41") it is 鳥取県's
  // republication, volume / 15,403 千m³ (2.9 % at 450 千m³) while the
  // manager's feeds (cgr-mlit-dam, kasenbosai storPcntIrr) read ~39 %; stored
  // as trusted it flipped the displayed rate every hour. Its rate stays NULL
  // so the trigger derives it and flags it (bit 32, migration 0051).
  const prefManaged = it.managerCd === PREF_MANAGER_CD;
  const rateEffective: Cell = prefManaged
    ? field(it.storageRateEffectiveCapacity, it.storageRateEffectiveCapacityFlg)
    : null;
  const cells: Cell[] = [level, inflow, outflow, storageThou, rateWaterUse];
  const state = cellState(prefManaged ? [...cells, rateEffective] : cells);
  if (state === 'empty') return { state, mark: 'Flg ≠ 0 on every field' };
  if (state === 'unreadable') return { state, why: 'no Flg-0 value' };
  const observedAt = parseTottoriTimestamp(it.dataTimestamp ?? '');
  if (!observedAt) return { state: 'unreadable', why: `dataTimestamp "${it.dataTimestamp}"` };
  const thou = numberIn(storageThou);
  const ratePct = numberIn(rateWaterUse) ?? numberIn(rateEffective);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        storageVolumeM3: thou != null ? thou * 1000 : null,
        storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      },
    ],
  };
}

/** Every listed dam: the feed's list is the universe. */
export function tottoriEntries(items: TottoriBousaiItem[]): Entry[] {
  return items.map((it) => ({
    key: String(it.observatoryId),
    name: it.name,
    pref: PREF_CODE,
    reading: tottoriReading(it),
  }));
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const json = async <T>(path: string) =>
    (await upstream.fetch(`${BASE_URL}${path}`, { timeoutMs: 15_000 })).json<T>();
  const { latestDateTimestamp: latest } = await json<{ latestDateTimestamp: string }>(
    '/data/dam/data.json',
  );
  const slug = latest.slice(0, 16).replace(/[ :]/g, '-');
  const { items } = await json<{ items: TottoriBousaiItem[] }>(`/data/dam/list/${slug}.json`);
  log(`${SOURCE_ID}: ${items.length} dams at ${latest}`);
  return { entries: tottoriEntries(items) };
});
