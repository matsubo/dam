// apps/worker/src/tasks/ingest_tndam_hyogo.ts
//
// 兵庫県 丹波農林振興事務所 ダムテレメータ — 6 dams (Tanba area).
//
// Source:
//   http://tndam.pref.hyogo.lg.jp/dam/DamData.jsp?PSNO={1-6}
//   Shift_JIS HTML; single latest observation per dam (no time series).
//   更新時刻: JST timestamp. "0000/00/00 00:00:00" = dam offline → skip.
//
// Dams (PSNO → name):
//   1 鍔市ダム    2 八幡谷ダム  3 藤岡ダム
//   4 佐仲ダム    5 黒石ダム    6 大杉ダム
//   (PSNO=2,4 currently offline — timestamp "0000/00/00")
//
// Table: 貯水位(m), 貯水量(m³ — NOT 千m³), 貯水率(%), 流入量(m³/s),
//        越流量(ignored), 放流量(m³/s), 時間雨量(mm)
//
// Priority 308. Cron hourly at :53.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.TNDAM_HYOGO_URL ?? 'http://tndam.pref.hyogo.lg.jp/dam/DamData.jsp';
const PREF_CODE = '28';
const SOURCE_ID = 'tndam-hyogo';
const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

const DAMS = [
  { psno: 1, name: '鍔市ダム' },
  { psno: 2, name: '八幡谷ダム' },
  { psno: 3, name: '藤岡ダム' },
  { psno: 4, name: '佐仲ダム' },
  { psno: 5, name: '黒石ダム' },
  { psno: 6, name: '大杉ダム' },
] as const;

// --- types -------------------------------------------------------------------

export interface TndamReading {
  psno: number;
  damName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

// --- parsing -----------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const trimmed = s.trim().replace(/[　\s]/g, '');
  if (!trimmed || trimmed === '-' || trimmed === '---') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract label→value pairs from bgcolor="#aaffaa" cells.
 * The page has alternating <td bgcolor="#aaffaa"> cells: label, value, label, value…
 * Labels contain superscript HTML (e.g. m<SUP>3</SUP>) which collapse to m3.
 */
export function extractDataMap(html: string): Map<string, string> {
  const cells: string[] = [];
  for (const m of html.matchAll(/<td[^>]*bgcolor="#aaffaa"[^>]*>([\s\S]*?)<\/td>/gi)) {
    cells.push(stripTags(m[1] ?? ''));
  }
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < cells.length; i += 2) {
    map.set(cells[i] ?? '', cells[i + 1] ?? '');
  }
  return map;
}

/**
 * Parse 「更新時刻：YYYY/MM/DD HH:MM:SS」 (JST) → UTC Date.
 * Returns null for "0000/00/00 00:00:00" (dam offline).
 */
export function parseTndamTimestamp(html: string): Date | null {
  const m = html.match(/更新時刻[：:](\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const yr = +(m[1] ?? 0);
  if (yr === 0) return null;
  const d = new Date(Date.UTC(yr, +(m[2] ?? 0) - 1, +(m[3] ?? 0), +(m[4] ?? 0) - 9, +(m[5] ?? 0)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse one dam page HTML into a TndamReading.
 * Returns null if the dam is offline (no timestamp) or no useful data.
 */
export function parseTndamPage(html: string, psno: number, damName: string): TndamReading | null {
  const observedAt = parseTndamTimestamp(html);
  const data = extractDataMap(html);

  const waterLevelM = parseNum(data.get('貯水位(m)') ?? '');
  const storageVolumeM3 = parseNum(data.get('貯水量(m3)') ?? '');
  const storageRatePct = parseNum(data.get('貯水率(%)') ?? '');
  const inflowM3s = parseNum(data.get('流入量(m3/s)') ?? '');
  const outflowM3s = parseNum(data.get('放流量(m3/s)') ?? '');
  const rainfallMm = parseNum(data.get('時間雨量(mm)') ?? '');

  if (waterLevelM === null && storageVolumeM3 === null && storageRatePct === null) return null;

  return {
    psno,
    damName,
    observedAt,
    waterLevelM,
    storageVolumeM3,
    storageRate: storageRatePct !== null ? storageRatePct / 100 : null,
    inflowM3s,
    outflowM3s,
    rainfallMm,
  };
}

// --- DB helpers --------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '兵庫県丹波農林振興事務所 ダムテレメータ — 6 dams (Tanba area), hourly',
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
  psno: number;
  damId: bigint;
}

async function matchMaster(
  readings: TndamReading[],
  log: (s: string) => void,
): Promise<DamMatch[]> {
  const masters = await sql<
    { id: bigint; name: string; external_ids: Record<string, string> | null }[]
  >`
    SELECT id, name, external_ids FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];

  for (const r of readings) {
    const psnoKey = String(r.psno);

    const byExtId = masters.find((m) => m.external_ids?.[SOURCE_ID] === psnoKey);
    if (byExtId) {
      universe.push({
        externalId: psnoKey,
        name: r.damName,
        prefCode: PREF_CODE,
        resolvedDamId: byExtId.id,
      });
      out.push({ psno: r.psno, damId: byExtId.id });
      continue;
    }

    const stem = normalizeName(r.damName);
    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.damName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    universe.push({
      externalId: psnoKey,
      name: r.damName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });
    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.damName}" (PSNO=${r.psno})`);
      continue;
    }

    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${psnoKey}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${psnoKey}
    `;
    out.push({ psno: r.psno, damId: best.id });
  }

  // The 6 DamData.jsp pages are the published catalogue, so record all of
  // them — a dam whose page is offline ("0000/00/00", currently PSNO 2 and 4)
  // parses to nothing but is still published, and must read as "published,
  // unlinked" rather than "nobody publishes it". Resolution falls back to the
  // external_ids stamp, which every dam matched on an earlier run carries.
  const seen = new Set(readings.map((r) => r.psno));
  for (const d of DAMS) {
    if (seen.has(d.psno)) continue;
    const psnoKey = String(d.psno);
    universe.push({
      externalId: psnoKey,
      name: d.name,
      prefCode: PREF_CODE,
      resolvedDamId: masters.find((m) => m.external_ids?.[SOURCE_ID] === psnoKey)?.id ?? null,
    });
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task --------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const results = await Promise.allSettled(
    DAMS.map(async ({ psno, name }) => {
      const url = `${BASE_URL}?PSNO=${psno}`;
      const resp = await fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (resp.status !== 200) {
        log(`${SOURCE_ID}: PSNO=${psno} HTTP ${resp.status}`);
        return null;
      }
      const buf = await resp.arrayBuffer();
      const html = new TextDecoder('shift_jis').decode(buf);
      return parseTndamPage(html, psno, name);
    }),
  );

  const readings: TndamReading[] = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((r): r is TndamReading => r !== null);

  log(`${SOURCE_ID}: fetched ${readings.length} readings`);

  const matches = await matchMaster(readings, log);
  const damByPsno = new Map(matches.map((m) => [m.psno, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const r of readings) {
    const damId = damByPsno.get(r.psno);
    if (!damId) continue;
    if (!r.observedAt) {
      log(`${SOURCE_ID}: PSNO=${r.psno} has no timestamp; skipping`);
      continue;
    }

    inputs.push({
      observedAt: r.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: r.storageVolumeM3,
      storageRate: r.storageRate,
      inflowM3s: r.inflowM3s,
      outflowM3s: r.outflowM3s,
      waterLevelM: r.waterLevelM,
      rainfallMm: r.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${readings.length} matched=${matches.length} written=${written}`);
};

export default task;
