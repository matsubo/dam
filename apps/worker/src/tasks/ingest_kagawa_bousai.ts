// apps/worker/src/tasks/ingest_kagawa_bousai.ts
//
// かがわ防災Webポータル ダム諸量 — 18 ダム hourly.
//
//   椛川(試験湛水) / 門入 / 千足 / 内海 / 吉田 / 内場 / 野口 / 長柄 /
//   前山 / 殿川 / 粟井 / 五名 / 田万 / 大川 / 大内 / 五郷 / 府中 / 粟地
//
// Source:
//   https://www.bousai-kagawa.jp/bousai_data/tm/dam_station.json
//   Single JSON fetch; all 18 dams in one response; updated every 10 min.
//
// JSON schema per item:
//   station_name   — dam name
//   obs_datetime   — "YYYY/MM/DD HH:MM" JST
//   store          — 貯水位[m]
//   stored         — 貯水量[千m³]  → storageVolumeM3 × 1000
//   storage_rate   — 貯水率[%]     → storageRate ÷ 100  (clamped 0–1)
//   inflow         — 流入量[m³/s]
//   discharge      — 全放流量[m³/s]
// A value the portal does not show is an explicit null (粟井ダム, every value
// null with displaykind -1, 2026-10-27): the portal's own blank.
//
// Priority 308. Cron hourly at :39.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.KAGAWA_BOUSAI_URL ?? 'https://www.bousai-kagawa.jp/bousai_data/tm/dam_station.json';

const PREF_CODE = '37';
const SOURCE_ID = 'kagawa-bousai';

// --- types ------------------------------------------------------------------

interface KagawaItem {
  station_name: string;
  obs_datetime: string;
  store?: number | null;
  stored?: number | null;
  storage_rate?: number | null;
  inflow?: number | null;
  discharge?: number | null;
}

interface KagawaJson {
  result?: number;
  ret_time?: string;
  items?: KagawaItem[];
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM" JST → UTC. Returns null on parse failure. */
export function parseKagawaTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** An explicit null is the portal's blank; a missing field is not. */
function valueCell(v: number | null | undefined): Cell {
  return cell(v, v === null);
}

function itemReading(it: KagawaItem): Reading {
  const level = valueCell(it.store);
  const volume = valueCell(it.stored);
  const rate = valueCell(it.storage_rate);
  const inflow = valueCell(it.inflow);
  const outflow = valueCell(it.discharge);
  const state = cellState([level, volume, rate, inflow, outflow]);
  if (state === 'empty') return { state, mark: 'every value null' };
  if (state === 'unreadable') return { state, why: 'no numeric value' };
  const observedAt = parseKagawaTimestamp(it.obs_datetime ?? '');
  if (!observedAt) return { state: 'unreadable', why: `obs_datetime "${it.obs_datetime}"` };
  const ratePct = numberIn(rate);
  const volRaw = numberIn(volume);
  return {
    state,
    observations: [
      {
        observedAt,
        storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
        storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/**
 * Every listed dam. The feed's station_no is not the key: the published name
 * has been, so existing stamps carry it.
 */
export function kagawaEntries(json: KagawaJson): Entry[] {
  const entries: Entry[] = [];
  for (const it of json.items ?? []) {
    const name = it.station_name?.trim();
    if (!name) continue;
    entries.push({ key: name, name, pref: PREF_CODE, reading: itemReading(it) });
  }
  return entries;
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const entries = kagawaEntries((await upstream.fetch(DATA_URL)).json<KagawaJson>());
  log(`${SOURCE_ID}: ${entries.length} dams listed`);
  return { entries };
});
