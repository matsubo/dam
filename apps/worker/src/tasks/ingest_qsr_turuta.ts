// apps/worker/src/tasks/ingest_qsr_turuta.ts
//
// 国土交通省 九州地方整備局 鶴田ダム管理所 — 1 国管理ダム (川内川水系).
//
//   鶴田ダム (Kagoshima/46)
//
// Source:
//   https://www.qsr.mlit.go.jp/turuta/cgi-bin/ajax_gethtml.cgi?type=2
//   EUC-JP HTML table, 10分更新; rows in descending time order.
//
// Format: 7 columns per <TR>:
//   [0] date "YYYY/MM/DD"
//   [1] time "HH:MM"
//   [2] rainfall mm
//   [3] storage 千m³  (× 1000 → m³)
//   [4] inflow  m³/s
//   [5] outflow m³/s
//   [6] storage rate % (→ / 100 = ratio)
//
// Priority 303 (MLIT-managed dam). Cron hourly at :22.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.QSR_TURUTA_URL ?? 'https://www.qsr.mlit.go.jp/turuta/cgi-bin/ajax_gethtml.cgi?type=2';

const PREF_CODE = '46';
const SOURCE_ID = 'qsr-turuta-dam';
/** The only dam this office publishes; the feed carries no station id. */
const DAM_NAME = '鶴田ダム';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  observedAt: Date;
  rainfallMm: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

function stripTags(raw: string): string {
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

/** "YYYY/MM/DD HH:MM" JST → UTC. */
export function parseTurutaTimestamp(date: string, time: string): Date | null {
  const dm = date.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const tm = time.trim().match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const d = new Date(
    Date.UTC(
      Number(dm[1]),
      Number(dm[2]) - 1,
      Number(dm[3]),
      Number(tm[1]) - 9,
      Number(tm[2]),
      0,
      0,
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseTurutaHtml(html: string): ParsedRow | null {
  // Extract all <TR> blocks, pick first data row (most recent, descending)
  const trMatches = Array.from(html.matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi));

  for (const tr of trMatches) {
    const tdMatches = Array.from((tr[1] ?? '').matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)).map((m) =>
      stripTags(m[1] ?? ''),
    );

    if (tdMatches.length < 7) continue;

    const observedAt = parseTurutaTimestamp(tdMatches[0] ?? '', tdMatches[1] ?? '');
    if (!observedAt) continue;

    const rainfallMm = parseNum(tdMatches[2] ?? '');
    const storageThousandM3 = parseNum(tdMatches[3] ?? '');
    const storageVolumeM3 = storageThousandM3 !== null ? storageThousandM3 * 1000 : null;
    const inflowM3s = parseNum(tdMatches[4] ?? '');
    const outflowM3s = parseNum(tdMatches[5] ?? '');
    const ratePct = parseNum(tdMatches[6] ?? '');
    const storageRate = ratePct !== null ? Math.max(0, Math.min(1, ratePct / 100)) : null;

    if (storageVolumeM3 === null && inflowM3s === null && outflowM3s === null) {
      continue;
    }

    return {
      observedAt,
      rainfallMm,
      storageVolumeM3,
      inflowM3s,
      outflowM3s,
      storageRate,
    };
  }

  return null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 303,
            '国土交通省 九州地方整備局 鶴田ダム管理所 — 鶴田ダム (川内川水系, Kagoshima)',
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

async function findDamId(log: (s: string) => void): Promise<bigint | null> {
  const targetName = DAM_NAME;
  const stem = normalizeName(targetName);

  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === targetName) rank = 0;
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
    log(`${SOURCE_ID}: no master match for "鶴田ダム" in pref ${PREF_CODE}`);
    return null;
  }
  return best.id;
}

// --- task --------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Resolved
  // before the fetch so a bad response still leaves a scan on record.
  const damId = await findDamId(log);
  await recordUniverse(SOURCE_ID, [
    { externalId: DAM_NAME, name: DAM_NAME, prefCode: PREF_CODE, resolvedDamId: damId },
  ]);
  if (!damId) return;

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
  const html = new TextDecoder('euc-jp').decode(raw);
  const row = parseTurutaHtml(html);

  if (!row) {
    log(`${SOURCE_ID}: no data row found; aborting`);
    return;
  }
  log(`${SOURCE_ID}: parsed row at ${row.observedAt.toISOString()}`);

  const written = await upsertObservations([
    {
      observedAt: row.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: null,
      rainfallMm: row.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    },
  ]);
  log(`${SOURCE_ID} done: written=${written}`);
};

export default task;
