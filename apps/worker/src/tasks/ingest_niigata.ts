// apps/worker/src/tasks/ingest_niigata.ts
//
// Phase B3 (#7): 新潟県河川防災情報システム prefectural dam telemetry.
//
// The site (doboku-bousai.pref.niigata.jp/kasen) runs the "防災Web" vendor
// stack shared by many 都道府県. Its dam table is a single GET — no SPA
// scraping required — once a JSESSIONID is established:
//
//   1. GET …/kasen/jsp/index.jsp           (sets JSESSIONID cookie)
//   2. GET …/kasen/servlet/bousaiweb.servletBousaiTableStatus
//          ?tvm=0&tsw=0&sv=3&dk=4&mp=0&no=0&fn=0&pg=1&unq=<n>   (dk=4 = dams)
//
// The response is a Shift_JIS HTML table, 10 cells per dam:
//   観測所名(+river) | 最新観測時刻 | 平常時最高貯水位[m] | 貯水位[m] |
//   洪水時最高水位[m] | 貯水率[%] | 洪水流入量 | 流入量[m³/s] |
//   計画高水流量 | 全放流量[m³/s]
//
// Numeric cells are prefixed with trend arrows (&rarr;/&uarr;/&darr;) and
// &nbsp; padding; 「---」 means no value. The timestamp carries no year, so
// we infer it from "now" (rolling back a year if MM/DD is in the future).
//
// We get level + rate + inflow + outflow (no absolute m³). ~20 prefectural
// dams in one fetch. Cron hourly at :23.
//
// NOTE: the same servlet path serves other 防災Web prefectures (Phase B6).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.NIIGATA_DAM_BASE ?? 'http://doboku-bousai.pref.niigata.jp/kasen';
const PREF_CODE = '15';
const SOURCE_ID = 'niigata-bousai';

const TABLE_PATH =
  '/servlet/bousaiweb.servletBousaiTableStatus?tvm=0&tsw=0&sv=3&dk=4&mp=0&no=0&fn=0&pg=1';

export interface ParsedRow {
  niigataName: string;
  riverName: string | null;
  observedAt: Date;
  waterLevelM: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

/** Decode the entities/arrows/padding the table wraps numeric cells in. */
function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(rarr|uarr|darr|harr|larr);/g, ' ')
    .replace(/[→↑↓←]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract a signed decimal from a cleaned cell, or null for 「---」/blank. */
function parseNum(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse 「MM/DD HH:MM」 (JST, no year) → UTC, inferring the year from `ref`.
 * If the resulting date would be in the future relative to `ref` (e.g. a
 * 12/31 stamp seen on Jan 1), roll back one year.
 */
export function parseStampWithYear(s: string, ref: Date): Date | null {
  const m = s.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const hour = Number(m[3]);
  const min = Number(m[4]);
  // Reference year in JST terms.
  const refJst = new Date(ref.getTime() + 9 * 3600_000);
  let year = refJst.getUTCFullYear();
  let utc = Date.UTC(year, month - 1, day, hour - 9, min, 0, 0);
  // Allow a small future skew (clock differences); roll back a full year if
  // the stamp is clearly ahead of the reference.
  if (utc - ref.getTime() > 24 * 3600_000) {
    year -= 1;
    utc = Date.UTC(year, month - 1, day, hour - 9, min, 0, 0);
  }
  return new Date(utc);
}

/** Split a flat table into rows of cell strings. */
function tableRows(html: string): string[][] {
  return Array.from(html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
    Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) => c[1] ?? ''),
  );
}

/**
 * Parse the dk=4 dam table. A dam row's first cell looks like
 * 「奥胎内ダム (胎内川)」; header / spacer rows are skipped.
 */
export function parseNiigataTable(html: string, ref: Date): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const cells of tableRows(html)) {
    if (cells.length < 10) continue;
    const first = cleanCell(cells[0] ?? '');
    const nameMatch = first.match(/^(.+?ダム)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?$/);
    if (!nameMatch) continue;
    const observedAt = parseStampWithYear(cleanCell(cells[1] ?? ''), ref);
    if (!observedAt) continue;

    const ratePct = parseNum(cleanCell(cells[5] ?? ''));
    out.push({
      niigataName: nameMatch[1] ?? '',
      riverName: nameMatch[2] ?? null,
      observedAt,
      waterLevelM: parseNum(cleanCell(cells[3] ?? '')),
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      inflowM3s: parseNum(cleanCell(cells[7] ?? '')),
      outflowM3s: parseNum(cleanCell(cells[9] ?? '')),
    });
  }
  return out;
}

/**
 * Fold visually-identical kanji variants so the feed and master compare
 * equal. Kept here (vs. shared util) per-adapter to make the mapping
 * explicit; extend if a 新潟 dam surfaces a variant.
 */
function foldVariants(s: string): string {
  return s.replace(/槇/g, '槙');
}

/** Strip ダム + （...）annotations, fold kanji variants for matching. */
export function normalizeName(s: string): string {
  return foldVariants(
    s
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/ダム$/, '')
      .trim(),
  );
}

/** Best master dam for a feed stem; exact stem match beats substring. */
export function chooseMaster(stem: string, masters: { id: bigint; name: string }[]): bigint | null {
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
  return best?.id ?? null;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '新潟県河川防災情報システム — hourly, ~20 県管理ダム (防災Web dk=4 table)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  niigataName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  for (const r of rows) {
    const stem = normalizeName(r.niigataName);
    if (!stem) continue;
    const damId = chooseMaster(stem, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for ${r.niigataName}`);
      continue;
    }
    out.push({ niigataName: r.niigataName, damId });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.niigataName}::text)
      WHERE id = ${damId}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.niigataName}
    `;
  }
  return out;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // 1) Establish a session cookie via the frameset entry page.
  const entry = await fetch(`${BASE_URL}/jsp/index.jsp`, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = entry.headers.get('set-cookie') ?? '';
  const jsession = setCookie.match(/JSESSIONID=[^;]+/)?.[0] ?? '';

  // 2) Fetch the dam table (Shift_JIS).
  const res = await fetch(`${BASE_URL}${TABLE_PATH}&unq=${Date.now()}`, {
    headers: { 'user-agent': ua, ...(jsession ? { cookie: jsession } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }
  const html = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
  const parsed = parseNiigataTable(html, new Date());
  log(`${SOURCE_ID}: parsed ${parsed.length} dam rows`);

  const matches = await matchMaster(parsed, log);
  const damByName = new Map(matches.map((m) => [m.niigataName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of parsed) {
    const damId = damByName.get(p.niigataName);
    if (!damId) continue;
    if (
      p.waterLevelM == null &&
      p.storageRate == null &&
      p.inflowM3s == null &&
      p.outflowM3s == null
    ) {
      continue;
    }
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
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
  log(`${SOURCE_ID} done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
