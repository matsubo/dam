// apps/worker/src/tasks/ingest_toyama_bousai.ts
//
// 富山県 県内ダム情報実況表 — 16 ダム, hourly (Salesforce public page).
//
//   室牧/上市川/和田川/利賀川/白岩川/子撫川/角川/熊野川/上市川第二/朝日小川/
//   布施川/城端/境川/大谷/久婦須川/舟川
//
// Source:
//   https://d2800000147bueaq.my.salesforce-sites.com/bousai2/TBW_VF_BousaidamReport
// Format: UTF-8 HTML. Japanese text encoded as &#N; numeric entities.
//   Single timestamp in <h2>: （YYYY年MM月DD日 HH時MM分）
//   Table columns: ダム名 | 水系名 | 全流入量(m³/s) | 全放流量(m³/s) | 貯水位(m) | threshold cols…
//   Water level wrapped in <span class="normal|low|…">; arrows in second span.
//   Missing values: "--" → null. No storage volume or storage rate.
// Priority 308.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.TOYAMA_BOUSAI_DAM_URL ??
  'https://d2800000147bueaq.my.salesforce-sites.com/bousai2/TBW_VF_BousaidamReport';

const PREF_CODE = '16';
const SOURCE_ID = 'toyama-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  toyamaName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

/** Replace &#N; numeric HTML entities with their Unicode characters. */
function decodeNumericEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * Parse the page-level timestamp from:
 *   <h2>…（YYYY年MM月DD日 HH時MM分）</h2>
 * where 年月日時分 and （） are encoded as &#N; numeric entities.
 */
export function parseToyamaTimestamp(html: string): Date | null {
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '';
  const decoded = decodeNumericEntities(h2);
  const m = decoded.match(/（(\d{4})年(\d{2})月(\d{2})日\s+(\d{2})時(\d{2})分）/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): number | null {
  const t = s.trim();
  if (t === '--' || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseToyamaPage(html: string): ParsedRow[] {
  const observedAt = parseToyamaTimestamp(html);
  if (!observedAt) return [];

  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return [];

  const rows: ParsedRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;

  for (const rowM of tbodyMatch[1].matchAll(rowRe)) {
    const rowHtml = rowM[1];

    // Dam name — anchor text is numeric-entity-encoded
    const nameM = rowHtml.match(/data-title="ダム名"[^>]*>[\s\S]*?target="_blank">([\s\S]*?)<\/a>/);
    if (!nameM) continue;
    const toyamaName = decodeNumericEntities(nameM[1]).trim();
    if (!toyamaName) continue;

    // Inflow and outflow are plain ASCII digits
    const inflowM = rowHtml.match(/data-title="全流入量[^"]*">([\s\S]*?)<\/td>/);
    const outflowM = rowHtml.match(/data-title="全放流量[^"]*">([\s\S]*?)<\/td>/);
    const inflowM3s = parseNum(inflowM?.[1] ?? '');
    const outflowM3s = parseNum(outflowM?.[1] ?? '');

    // Water level is in the first <span> of the 貯水位 cell
    let waterLevelM: number | null = null;
    const levelCellM = rowHtml.match(/data-title="貯水位 \(m\)">([\s\S]*?)<\/td>/);
    if (levelCellM) {
      const spanM = levelCellM[1].match(/<span[^>]*>\s*([\d.]+)\s*<\/span>/);
      waterLevelM = spanM ? parseNum(spanM[1]) : null;
    }

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;

    rows.push({ toyamaName, observedAt, waterLevelM, inflowM3s, outflowM3s });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '富山県 県内ダム情報実況表 — 16 ダム (Salesforce public page, hourly)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

function normalizeName(s: string): string {
  return (
    s
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/ダム$/, '')
      .replace(/貯水池$/, '')
      // Normalise 第N kanji numerals → Arabic so "第二" matches master "第2".
      .replace(/第一/g, '第1')
      .replace(/第二/g, '第2')
      .replace(/第三/g, '第3')
      .replace(/第四/g, '第4')
      .replace(/第五/g, '第5')
      .trim()
  );
}

interface DamMatch {
  toyamaName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.toyamaName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.toyamaName) rank = 0;
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
      log(`${SOURCE_ID}: no master match for "${r.toyamaName}"`);
      continue;
    }
    out.push({ toyamaName: r.toyamaName, damId: best.id });
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

  const html = await r.text();
  const rows = parseToyamaPage(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.toyamaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.toyamaName);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
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
