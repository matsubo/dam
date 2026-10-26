// apps/worker/src/tasks/ingest_kyoto_bousai.ts
//
// 京都府 河川防災情報 ダム諸量現況表 — 6 ダム hourly.
//
//   大野ダム / 畑川ダム (大野ダム管理) /
//   天ヶ瀬ダム (淀川ダム統管) /
//   日吉ダム / 高山ダム / 布目ダム (水資源機構)
//   (+ 瀬田洗堰1・瀬田洗堰2 appear as sluice gates; they are not one master
//    dam, and are recorded in source_universe with a null resolvedDamId)
//
// The 局名 cell is the only id the table publishes, so the printed name is the
// key. 布目ダム is managed by 水資源機構 and sits in Nara (29) but appears in
// this feed, so masters are looked up in 26 and 29.
//
// Source:
//   https://chisuibousai2.pref.kyoto.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4
//   Single Shift_JIS HTML page; single page (1/1); standard row-per-dam table.
//
// Table columns:
//   col[0] 管理者名  col[1] 河川名  col[2] 局名 (dam name in <a>)
//   col[3] 所在地    col[4] 最新観測時刻 "YYYY MM/DD HH:MM" JST
//   col[5] 時間雨量  col[6] 累計雨量
//   col[7] 貯水位 [EL.m]
//   col[8] 貯水量 [×10³m³] → storageVolumeM3 × 1000
//   col[9] 流入量 [m³/s]   col[10] 放流量 [m³/s]
//   Values prefixed with → / ↑ / ↓ arrow entities; &nbsp; as spacer.
//
// Priority 308. Cron hourly at :42.

import { ingestTask } from '../ingest/run.ts';
import type { Bind, Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.KYOTO_BOUSAI_URL ??
  'https://chisuibousai2.pref.kyoto.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4';

const PREFS = ['26', '29'];
const SOURCE_ID = 'kyoto-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  kyotoName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function cleanCell(html: string): string {
  return html
    .replace(/&(?:rarr|uarr|darr|larr|nbsp|amp|lt|gt);/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/** "YYYY MM/DD HH:MM" (non-breaking spaces allowed, JST) → UTC. */
export function parseKyotoTimestamp(s: string): Date | null {
  const normalized = s
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = normalized.match(/^(\d{4})\s+(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseVal(s: string): number | null {
  const t = s.replace(/[↑↓→←]/g, '').trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseKyotoTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const trMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rawCells = Array.from((trMatch[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(
      (c) => c[1] ?? '',
    );
    if (rawCells.length < 11) continue;

    const damName = cleanCell(rawCells[2] ?? '');
    if (!damName) continue;

    const volRaw = parseVal(cleanCell(rawCells[8] ?? ''));
    rows.push({
      kyotoName: damName,
      observedAt: parseKyotoTimestamp(cleanCell(rawCells[4] ?? '')),
      waterLevelM: parseVal(cleanCell(rawCells[7] ?? '')),
      storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
      inflowM3s: parseVal(cleanCell(rawCells[9] ?? '')),
      outflowM3s: parseVal(cleanCell(rawCells[10] ?? '')),
    });
  }

  return rows;
}

/** A row with a time and a 貯水位 or a flow has values; blank cells carry no legend. */
export function kyotoReading(p: ParsedRow): Reading {
  if (!p.observedAt) return { state: 'unreadable', why: 'no 最新観測時刻' };
  if (p.waterLevelM === null && p.inflowM3s === null && p.outflowM3s === null) {
    return { state: 'unreadable', why: 'no 貯水位 or flow' };
  }
  return {
    state: 'values',
    observations: [
      {
        observedAt: p.observedAt,
        waterLevelM: p.waterLevelM,
        storageVolumeM3: p.storageVolumeM3,
        inflowM3s: p.inflowM3s,
        outflowM3s: p.outflowM3s,
      },
    ],
  };
}

/**
 * How a row binds when the name ladder cannot: 天ヶ瀬ダム's stem matches
 * 天ヶ瀬（再）/（元） and a third, bare 天ヶ瀬 row (no NDI), so it is pinned to
 * the redeveloped 天ヶ瀬（再） (NDI 1495) kkr-mlit-dam and kasenbosai feed. The
 * 瀬田洗堰 sluice gates are no master dam.
 */
function bindFor(kyotoName: string): Bind | undefined {
  if (kyotoName === '天ヶ瀬ダム') return { ndi: '1495' };
  if (kyotoName.includes('洗堰')) return 'never';
  return undefined;
}

/** Every row of the table. */
export function kyotoEntries(rows: ParsedRow[]): Entry[] {
  return rows.map((p): Entry => {
    const bind = bindFor(p.kyotoName);
    return {
      key: p.kyotoName,
      name: p.kyotoName,
      pref: PREFS,
      ...(bind ? { bind } : {}),
      reading: kyotoReading(p),
    };
  });
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
  const rows = parseKyotoTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);
  return { entries: kyotoEntries(rows) };
});
