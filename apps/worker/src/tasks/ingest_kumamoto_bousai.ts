// apps/worker/src/tasks/ingest_kumamoto_bousai.ts
//
// 熊本県防災情報システム 地方別ダム情報 — 6 ダム, 60分更新.
//
//   6 dams: 市房/氷川/石打/上津浦/亀川/路木
//
// Source:
//   https://www.bousai.pref.kumamoto.jp/Dsp/GmnDspD.exe?52A0
// Format: Shift_JIS JS page; DspDat[] array, 12 comma-separated fields per dam.
//   Fields: name(HTML) / river / datetime(YYYY/MM/DD HH:MM JST) / 貯水位(m) /
//           全流入量(m³/s) / 全放流量(m³/s) / 有効貯水量(10³m³) / 利水量(10³m³) /
//           治水量(10³m³) / 貯水率(有効容量)(%) / 貯水率(利水容量)(%) / 貯水率(治水容量)(%)
// We store: waterLevelM, inflowM3s, outflowM3s, 有効貯水量×1000→m³, 貯水率(利水容量).
// storageRate prefers 貯水率(利水容量) over 貯水率(有効容量) so it matches this
// site's own 貯水率 definition (storage_volume_m3/active_capacity_m3, 利水容量);
// both rate columns share the same numerator (有効貯水量) so pairing either
// with storageVolumeM3 stays dimensionally consistent. See issue #17 — some
// of these dams' 有効容量-based and 利水容量-based rates diverge sharply
// (e.g. 氷川ダム: 22% vs 94%), the same static-vs-seasonal-capacity mismatch
// found for 八田原ダム.
// Priority 308.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.KUMAMOTO_BOUSAI_URL ?? 'https://www.bousai.pref.kumamoto.jp/Dsp/GmnDspD.exe?52A0';

const PREF_CODE = '43';
const SOURCE_ID = 'kumamoto-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  kumamotoName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM" JST → UTC Date */
export function parseKumamotoDatetime(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): number | null {
  const clean = s.replace(/[^\d.\-]/g, '').trim();
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one DspDat entry value (the string inside the single quotes).
 *
 * The value is a comma-separated list of 12 HTML-encoded fields:
 *   [0] <a href="..."><u>DAM_NAME</u></a>
 *   [1] river name
 *   [2] YYYY/MM/DD HH:MM (JST)
 *   [3] 貯水位 (m)
 *   [4] 全流入量 (m³/s)
 *   [5] 全放流量 (m³/s)
 *   [6] 有効貯水量 (10³m³)
 *   [7] 利水量 (10³m³)
 *   [8] 治水量 (10³m³)
 *   [9] 貯水率(有効容量) (%)
 *  [10] 貯水率(利水容量) (%)
 *  [11] 貯水率(治水容量) (%)
 */
export function parseDspDatEntry(raw: string): ParsedRow | null {
  // Extract dam name from HTML link before stripping tags
  const nameMatch = raw.match(/<u>([^<]+)<\/u>/i);
  if (!nameMatch) return null;
  const kumamotoName = nameMatch[1]?.trim() ?? '';
  if (!kumamotoName) return null;

  // Strip all HTML tags; arrow chars (↑↓→) get stripped by parseNum
  const stripped = raw.replace(/<[^>]+>/g, '');
  const fields = stripped.split(',');
  if (fields.length < 10) return null;

  const observedAt = parseKumamotoDatetime(fields[2] ?? '');
  if (!observedAt) return null;

  const effectiveKm3 = parseNum(fields[6] ?? '');

  return {
    kumamotoName,
    observedAt,
    waterLevelM: parseNum(fields[3] ?? ''),
    inflowM3s: parseNum(fields[4] ?? ''),
    outflowM3s: parseNum(fields[5] ?? ''),
    storageVolumeM3: effectiveKm3 !== null ? effectiveKm3 * 1_000 : null,
    storageRate: (() => {
      const r = parseNum(fields[10] ?? '') ?? parseNum(fields[9] ?? '');
      return r !== null ? r / 100 : null;
    })(),
  };
}

/** Extract all DspDat entries from the JS page source */
export function parseKumamotoPage(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const re = /DspDat\[\d+\]\s*=\s*'([^']+)'/g;
  for (const m of html.matchAll(re)) {
    const entry = parseDspDatEntry(m[1] ?? '');
    if (entry) rows.push(entry);
  }
  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '熊本県防災情報システム 地方別ダム情報 — 6 ダム (Shift_JIS JS, 60分更新)',
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
  kumamotoName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.kumamotoName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.kumamotoName) rank = 0;
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
      log(`${SOURCE_ID}: no master match for "${r.kumamotoName}"`);
      continue;
    }

    out.push({ kumamotoName: r.kumamotoName, damId: best.id });
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
  const rows = parseKumamotoPage(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.kumamotoName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.kumamotoName);
    if (!damId) continue;
    if (
      p.waterLevelM === null &&
      p.inflowM3s === null &&
      p.outflowM3s === null &&
      p.storageVolumeM3 === null &&
      p.storageRate === null
    )
      continue;

    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
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
