// apps/worker/src/tasks/ingest_kochi_bousai.ts
//
// 高知県水防情報システム ダム諸量現況表 — 11 ダム hourly.
//
//   pref-managed (7): 和食 / 永瀬 / 鎌井谷 / 鏡 / 桐見 / 坂本 / 以布利川
//   MLIT (4):         早明浦 / 大渡 / 中筋川 / 横瀬川
//
// Source:
//   https://suibo-kouho.suibou.pref.kochi.lg.jp/suibou/status/tableStatusDam_0_1_0_now.html
//   Pre-generated static Shift_JIS HTML; refreshed each hour. The 観測所名
//   column is the only id the table publishes, so the printed name is the key.
//
// Table columns (14 per data row):
//   [0]  管理者名
//   [1]  河川名
//   [2]  観測所名  (dam name)
//   [3]  フリガナ
//   [4]  所在地
//   [5]  最新観測時刻  "YYYY/MM/DD HH:MM" JST
//   [6]  貯水率[%]   (有効容量ベース)  fallback if [7] missing
//   [7]  貯水率[%]   (利水容量ベース)  → storageRate ÷ 100 (preferred)
//   [8]  貯水位[m]
//   [9]  貯水量[10³m³]                 → storageVolumeM3 × 1000
//   [10] 流入量[m³/s]
//   [11] 全放流量[m³/s]
//   [12] 洪水量[m³/s]   (alarm — not stored)
//   [13] 計画高水流量[m³/s]  (not stored)
//
// Priority 308. Cron hourly at :38.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.KOCHI_BOUSAI_URL ??
  'https://suibo-kouho.suibou.pref.kochi.lg.jp/suibou/status/tableStatusDam_0_1_0_now.html';

const PREF_CODE = '39';
const SOURCE_ID = 'kochi-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  kochiName: string;
  observedAt: Date | null;
  storageRate: number | null;
  storageVolumeM3: number | null;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC. Returns null on parse failure. */
export function parseKochiTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract all dam rows from the tableStatusDam HTML. */
export function parseKochiTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const trMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rawCells = Array.from((trMatch[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(
      (c) => c[1] ?? '',
    );

    if (rawCells.length < 12) continue;

    const damName = cleanCell(rawCells[2] ?? '');
    if (!damName) continue;

    const ts = cleanCell(rawCells[5] ?? '');
    const observedAt = parseKochiTimestamp(ts);

    // Prefer 利水容量ベース [7] over 有効容量ベース [6] so this matches the
    // site's own 貯水率 definition (storage_volume_m3/active_capacity_m3,
    // 利水容量) — the two can diverge sharply for flood-control dams during
    // 洪水期 (see issue #17). Fall back to [6] if [7] is unavailable.
    const ratePct =
      parseNum(cleanCell(rawCells[7] ?? '')) ?? parseNum(cleanCell(rawCells[6] ?? ''));
    const volRaw = parseNum(cleanCell(rawCells[9] ?? ''));

    rows.push({
      kochiName: damName,
      observedAt,
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
      waterLevelM: parseNum(cleanCell(rawCells[8] ?? '')),
      inflowM3s: parseNum(cleanCell(rawCells[10] ?? '')),
      outflowM3s: parseNum(cleanCell(rawCells[11] ?? '')),
    });
  }

  return rows;
}

/** A row with a time and a 貯水位 or 貯水量 has values; the table prints no 欠測 mark. */
export function kochiReading(p: ParsedRow): Reading {
  if (!p.observedAt) return { state: 'unreadable', why: 'no 最新観測時刻' };
  if (p.waterLevelM === null && p.storageVolumeM3 === null) {
    return { state: 'unreadable', why: 'no 貯水位 or 貯水量' };
  }
  return {
    state: 'values',
    observations: [
      {
        observedAt: p.observedAt,
        storageRate: p.storageRate,
        storageVolumeM3: p.storageVolumeM3,
        waterLevelM: p.waterLevelM,
        inflowM3s: p.inflowM3s,
        outflowM3s: p.outflowM3s,
      },
    ],
  };
}

/** Every row of the table. */
export function kochiEntries(rows: ParsedRow[]): Entry[] {
  return rows.map((p) => ({
    key: p.kochiName,
    name: p.kochiName,
    pref: PREF_CODE,
    reading: kochiReading(p),
  }));
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async (log) => {
  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status}`);

  const html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
  const rows = parseKochiTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);
  return { entries: kochiEntries(rows) };
});
