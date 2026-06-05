// apps/worker/src/tasks/ingest_kyoto_bousai.ts
//
// 京都府 河川防災情報 ダム諸量現況表 — 6 ダム hourly.
//
//   大野ダム / 畑川ダム (大野ダム管理) /
//   天ヶ瀬ダム (淀川ダム統管) /
//   日吉ダム / 高山ダム / 布目ダム (水資源機構)
//   (+ 瀬田洗堰1・瀬田洗堰2 appear as sluice gates — no master match)
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

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.KYOTO_BOUSAI_URL ??
  'https://chisuibousai2.pref.kyoto.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4';

const PREF_CODE = '26';
const SOURCE_ID = 'kyoto-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  kyotoName: string;
  observedAt: Date;
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
    .replace(/ /g, ' ')
    .trim();
}

/** "YYYY MM/DD HH:MM" (non-breaking spaces allowed, JST) → UTC. */
export function parseKyotoTimestamp(s: string): Date | null {
  const normalized = s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
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

    const nameHtml = rawCells[2] ?? '';
    const damName = cleanCell(nameHtml);
    if (!damName) continue;

    const tsRaw = cleanCell(rawCells[4] ?? '');
    const observedAt = parseKyotoTimestamp(tsRaw);
    if (!observedAt) continue;

    const waterLevelM = parseVal(cleanCell(rawCells[7] ?? ''));
    const volRaw = parseVal(cleanCell(rawCells[8] ?? ''));
    const inflowM3s = parseVal(cleanCell(rawCells[9] ?? ''));
    const outflowM3s = parseVal(cleanCell(rawCells[10] ?? ''));

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;

    rows.push({
      kyotoName: damName,
      observedAt,
      waterLevelM,
      storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
      inflowM3s,
      outflowM3s,
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '京都府 河川防災情報 ダム諸量現況表 — 6 ダム hourly',
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
  kyotoName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.kyotoName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.kyotoName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.kyotoName}"`);
      continue;
    }
    out.push({ kyotoName: r.kyotoName, damId: best.id });
  }

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

  const buf = await r.arrayBuffer();
  const html = new TextDecoder('shift_jis').decode(buf);
  const rows = parseKyotoTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.kyotoName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.kyotoName);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: null,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
