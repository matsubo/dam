// apps/worker/src/tasks/ingest_gifu_kasen.ts
//
// 岐阜県 川の防災情報 ダム諸量 — 14 ダム, hourly.
//
//   14 dams: 阿多岐/大ヶ洞/岩村/中野方/丹生川/矢作/小里川/横山/徳山/丸山/
//            阿木川/岩屋/牧尾/味噌川
//
// Source:
//   https://www.kasen.pref.gifu.lg.jp/h/Dam.html
// Format: UTF-8 HTML. Single JST timestamp ("YYYY/MM/DD HH:MM現在") for all dams.
//   Each dam in "[ダム名]" section followed by <pre> block with three metrics.
//   "***" = 欠測 (missing), "---" = 無効 (invalid) → null.
//   Values: 貯水量 (千m³) / 放流量 (m³/s) / 全流入量 (m³/s).
// Priority 308.

import { type BindableMaster, preferMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL = process.env.GIFU_KASEN_DAM_URL ?? 'https://www.kasen.pref.gifu.lg.jp/h/Dam.html';

const SOURCE_ID = 'gifu-kasen';

// Names alone cross prefectures: ダム便覧 has a 岩村 in 北海道 (lower id) as
// well as this page's 岩村 in 岐阜. Every station here is in 岐阜 except three
// upper-Kiso / Yahagi dams the prefecture also reports, which ダム便覧 files
// under 長野 and 愛知.
const GIFU_PREF = '21';
const PREF_OUTSIDE_GIFU: Record<string, string> = {
  矢作ダム: '23',
  牧尾ダム: '20',
  味噌川ダム: '20',
};

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  gifuName: string;
  observedAt: Date;
  storageVolumeM3: number | null;
  outflowM3s: number | null;
  inflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM現在" JST → UTC Date */
export function parseGifuDatetime(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})現在/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse a numeric value; "***" (missing) and "---" (invalid) → null */
function parseVal(s: string): number | null {
  const t = s.replace(/&nbsp;/g, '').trim();
  if (t === '***' || t === '---' || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseGifuPage(html: string): ParsedRow[] {
  const tsMatch = html.match(/(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}現在)/);
  if (!tsMatch) return [];
  const observedAt = parseGifuDatetime(tsMatch[1] ?? '');
  if (!observedAt) return [];

  const rows: ParsedRow[] = [];

  // Each section: [XxxダムYyy] ... 貯水量 ... 放流量 ... 全流入量.
  // The `[^\]<]+ダム` guard excludes the [更新] link bracket at the top of the page.
  const sectionRe =
    /\[([^\]<]+ダム[^\]<]*)\][\s\S]*?貯水量\s+([\S]+)\s+千m3\s*[\r\n]+\s*放流量\s+([\S]+)\s+m3\/s\s*[\r\n]+\s*全流入量\s+([\S]+)\s+m3\/s/g;

  const decoded = html.replace(/&nbsp;/g, ' ');
  for (const m of decoded.matchAll(sectionRe)) {
    const name = m[1]?.trim() ?? '';
    if (!name) continue;
    const storage = parseVal(m[2] ?? '');
    const outflow = parseVal(m[3] ?? '');
    const inflow = parseVal(m[4] ?? '');

    if (storage === null && outflow === null && inflow === null) continue;

    rows.push({
      gifuName: name,
      observedAt,
      storageVolumeM3: storage !== null ? storage * 1_000 : null,
      outflowM3s: outflow,
      inflowM3s: inflow,
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '岐阜県川の防災情報 ダム諸量 — 14 ダム (UTF-8 HTML, hourly)',
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
  gifuName: string;
  damId: bigint;
}

export interface GifuMaster extends BindableMaster {
  prefCode: string | null;
}

/**
 * Best master dam for a station name, among the station's prefecture:
 * exact name, stem, then substring.
 */
export function chooseMaster(gifuName: string, masters: GifuMaster[]): bigint | null {
  const stem = normalizeName(gifuName);
  if (!stem) return null;
  const pref = PREF_OUTSIDE_GIFU[gifuName] ?? GIFU_PREF;
  let best: { m: GifuMaster; rank: number } | null = null;
  for (const m of masters) {
    if (m.prefCode !== pref) continue;
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === gifuName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
      best = { m, rank };
    }
  }
  return best?.m.id ?? null;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<GifuMaster[]>`
    SELECT id, name, completed_year AS "completedYear", pref_code AS "prefCode"
    FROM dams ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Keyed by
  // name so a page that repeats a section can't break the upsert.
  const universe = new Map<string, UniverseRow>();

  for (const r of rows) {
    if (!normalizeName(r.gifuName)) continue;
    const damId = chooseMaster(r.gifuName, masters);

    // The page publishes no station id, so the name is the key, and the
    // station's prefecture keeps it apart from same-named dams elsewhere.
    universe.set(r.gifuName, {
      externalId: r.gifuName,
      name: r.gifuName,
      prefCode: PREF_OUTSIDE_GIFU[r.gifuName] ?? GIFU_PREF,
      resolvedDamId: damId,
    });

    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.gifuName}"`);
      continue;
    }

    out.push({ gifuName: r.gifuName, damId });
  }

  await recordUniverse(SOURCE_ID, [...universe.values()]);
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

  const html = await r.text();
  const rows = parseGifuPage(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.gifuName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.gifuName);
    if (!damId) continue;

    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: null,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
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
