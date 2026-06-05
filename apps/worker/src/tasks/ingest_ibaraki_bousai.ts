// apps/worker/src/tasks/ingest_ibaraki_bousai.ts
//
// 茨城県河川防災情報 ダム諸量現況表 — 防災Web HTML table, hourly.
//
//   7 county-managed dams: 小山(大北川) / 飯田(飯田川) / 藤井川 /
//   竜神(竜神川) / 十王(十王川) / 花貫(花貫川) / 花園(花園川).
//
// Source:
//   http://www.kasen.pref.ibaraki.jp/pc/sv/bousaiTableStatus.html?sv=3&dk=4&mp=0&no=0&fn=0&pg=1
// Format: Shift_JIS HTML table (no session required). 9 columns per row:
//   管理者 | 河川名 | 局名(dam) | 所在地 | 最新観測時刻 |
//   貯水位[m] | 貯水量[10³m³] | 流入量[m³/s] | 全放流量[m³/s]
// Timestamp: "YYYY MM/DD HH:MM" JST.
// No 貯水率 column (storage rate set null).
// Priority 308, matching other 防災Web prefectural sources.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.IBARAKI_BOUSAI_URL ??
  'http://www.kasen.pref.ibaraki.jp/pc/sv/bousaiTableStatus.html?sv=3&dk=4&mp=0&no=0&fn=0&pg=1';

const PREF_CODE = '08';
const SOURCE_ID = 'ibaraki-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  ibarakiName: string;
  riverName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(rarr|uarr|darr|harr|larr);/g, ' ')
    .replace(/[→↑↓←]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY MM/DD HH:MM" or "YYYY MM/DD HH:MM" JST → UTC Date */
export function parseIbarakiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\s+(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mi] = m.map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract rows from the 防災Web table (9 columns per data row). */
export function parseIbarakiTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/gi);
  const dataTable = tableMatch?.[1] ?? '';

  const trList = Array.from(dataTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
    Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) => c[1] ?? ''),
  );

  for (const cells of trList) {
    if (cells.length < 9) continue;
    // Header/unit rows have no dam name or numeric data in col 5.
    const damName = cleanCell(cells[2] ?? '');
    if (!damName || (!damName.includes('ダム') && !damName.includes('貯水池'))) continue;

    const ts = cleanCell(cells[4] ?? '');
    const observedAt = parseIbarakiTimestamp(ts);

    const storageThou = parseNum(cleanCell(cells[6] ?? ''));

    rows.push({
      ibarakiName: damName,
      riverName: cleanCell(cells[1] ?? ''),
      observedAt,
      waterLevelM: parseNum(cleanCell(cells[5] ?? '')),
      storageVolumeM3: storageThou !== null ? storageThou * 1_000 : null,
      inflowM3s: parseNum(cleanCell(cells[7] ?? '')),
      outflowM3s: parseNum(cleanCell(cells[8] ?? '')),
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '茨城県河川防災情報 ダム諸量現況表 — 防災Web HTML table, 7 dams, hourly',
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
  ibarakiName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.ibarakiName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (mStem === stem) rank = 0;
      else if (m.name === `${stem}ダム`) rank = 1;
      else if (mStem.startsWith(stem)) rank = 2;
      else if (mStem.includes(stem)) rank = 3;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.ibarakiName}"`);
      continue;
    }

    out.push({ ibarakiName: r.ibarakiName, damId: best.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.ibarakiName}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.ibarakiName}
    `;
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

  const raw = await r.arrayBuffer();
  const html = new TextDecoder('shift_jis').decode(raw);
  const rows = parseIbarakiTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.ibarakiName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.ibarakiName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.ibarakiName}"; skipping`);
      continue;
    }
    if (p.waterLevelM === null && p.storageVolumeM3 === null) continue;

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
