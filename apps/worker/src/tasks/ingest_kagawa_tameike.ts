// apps/worker/src/tasks/ingest_kagawa_tameike.ts
//
// 香川県 水資源対策課「かがわの水」— 降雨及び貯水率の状況 の主要ため池貯水率 (26 か所)。
//
// Source:
//   https://www.pref.kagawa.lg.jp/mizusigen/mizu/kfvn.html
// The page links today's report as /documents/5847/chosuiYYYYMMDD.pdf; the
// filename changes daily, so the newest dated link is discovered, never pinned.
//
// The PDF carries three blocks: 早明浦ダム, 県内ダム (15 県管理ダム — carried
// hourly by kagawa-bousai, so ignored here) and ため池貯水率 — the 県下平均 of
// 181 surveyed ponds plus 26 named ones (満濃池/公渕池/神内池/仁池/豊稔池 …),
// none of which any other feed publishes. unpdf extracts that column cleanly,
// one pond per line:
//   宮池 75 さぬき市
//   石神池 88 〃
// followed by the label 「ため池貯水率 (%)」 and the survey date
// 「9月16日現在」. That date — not the report date — is the observation time
// (JST midnight; no hour is printed). The ponds are surveyed about twice a
// month while the report is issued every 開庁日, so most runs re-upsert the
// same survey.
//
// Values: 貯水率 only, whole percent. No volume is printed, so nothing can be
// back-solved; trusted_rate_basis stays off (see migration 0048's rule).
// 0 % is not stored (0038/0039 phantom zeros).
//
// Priority 283 — no other source covers these ponds; kept below the
// finer-grained agricultural feeds (fukushima-nourin 285, miyagi-nousei 286)
// by convention.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';
import { pdfToText } from './ingest_oita_nourin.ts';

const INDEX_URL =
  process.env.KAGAWA_TAMEIKE_URL ?? 'https://www.pref.kagawa.lg.jp/mizusigen/mizu/kfvn.html';

const ORIGIN = 'https://www.pref.kagawa.lg.jp';
const PREF_CODE = '37';
const SOURCE_ID = 'kagawa-tameike';

export interface ParsedRow {
  /** Pond name exactly as printed (「公渕池」) — also the stamp and universe key. */
  name: string;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number;
}

// --- parsing ----------------------------------------------------------------

/** One pond line: name ending 池, the rate (or a marker), the 市町 or 〃. */
const POND_LINE_RE = /^(\S+池)\s+(\S+)\s+(\S+(?:市|町|村)|〃)$/;

export function parseKagawaTameikeText(text: string): {
  surveyDate: Date | null;
  rows: ParsedRow[];
  published: string[];
} {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const labelAt = lines.findIndex((l) => l.startsWith('ため池貯水率'));
  if (labelAt < 0) return { surveyDate: null, rows: [], published: [] };

  // The report date (「令和8年9月25日」) fixes the year; the survey date follows
  // the ため池 label and has no year of its own.
  const report = text.match(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日/);
  const survey = lines
    .slice(labelAt + 1, labelAt + 3)
    .join(' ')
    .match(/(\d{1,2})月(\d{1,2})日現在/);
  let surveyDate: Date | null = null;
  if (report && survey) {
    const reportMonth = Number(report[2]);
    const month = Number(survey[1]);
    // A 12月 survey still on a 1月 report belongs to the previous year.
    const year = 2018 + Number(report[1]) - (month > reportMonth ? 1 : 0);
    // JST midnight = 15:00 UTC the previous day.
    surveyDate = new Date(Date.UTC(year, month - 1, Number(survey[2]) - 1, 15, 0, 0));
  }

  // The pond column runs upward from the label until the 県下平均/平年値 lines.
  const rows: ParsedRow[] = [];
  const published: string[] = [];
  for (let i = labelAt - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line === '備考') continue;
    const m = line.match(POND_LINE_RE);
    if (!m) break;
    published.unshift(m[1] as string);
    const pct = /^\d{1,3}$/.test(m[2] ?? '') ? Number(m[2]) : null;
    if (pct === null || pct <= 0 || pct > 100) continue;
    rows.unshift({ name: m[1] as string, storageRate: pct / 100 });
  }
  return { surveyDate, rows, published };
}

/** The newest chosuiYYYYMMDD.pdf linked from the かがわの水 page. */
export function findLatestPdfUrl(html: string): string | null {
  let best: { href: string; ymd: string } | null = null;
  for (const m of html.matchAll(/href="([^"]*\/chosui(\d{8})\.pdf)"/g)) {
    const ymd = m[2] as string;
    if (!best || ymd > best.ymd) best = { href: m[1] as string, ymd };
  }
  if (!best) return null;
  return best.href.startsWith('http') ? best.href : `${ORIGIN}${best.href}`;
}

// --- matching ---------------------------------------------------------------

/**
 * Pond names are generic (新池, 城池, 大谷池 exist all over the prefecture),
 * so only an exact name binds — after folding 渕→淵 (the PDF's 公渕池 is the
 * master's 公淵池) and dropping the （元）/（再） marker, whose twins
 * preferMaster settles.
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const key = name.replace(/渕/g, '淵');
  let best: BindableMaster | null = null;
  for (const m of masters) {
    if (m.name.replace(/[（(][^）)]*[）)]/g, '').trim() !== key) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 283,
            '香川県 水資源対策課 降雨及び貯水率の状況 — 主要ため池 26 か所の貯水率, 月2回程度',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const headers = {
    'user-agent':
      process.env.HTTP_USER_AGENT ??
      'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
  };

  const indexRes = await fetch(INDEX_URL, { headers, signal: AbortSignal.timeout(20_000) });
  if (indexRes.status !== 200) {
    log(`${SOURCE_ID}: index HTTP ${indexRes.status}; aborting`);
    return;
  }
  const pdfUrl = findLatestPdfUrl(await indexRes.text());
  if (!pdfUrl) {
    log(`${SOURCE_ID}: no chosui PDF linked from the index; aborting`);
    return;
  }
  const pdfRes = await fetch(pdfUrl, { headers, signal: AbortSignal.timeout(30_000) });
  if (pdfRes.status !== 200) {
    log(`${SOURCE_ID}: PDF HTTP ${pdfRes.status} for ${pdfUrl}; aborting`);
    return;
  }

  const text = await pdfToText(new Uint8Array(await pdfRes.arrayBuffer()));
  const { surveyDate, rows, published } = parseKagawaTameikeText(text);
  if (!surveyDate) {
    log(`${SOURCE_ID}: no ため池 survey date in ${pdfUrl}; aborting`);
    return;
  }
  log(
    `${SOURCE_ID}: parsed ${rows.length}/${published.length} ponds for ${surveyDate.toISOString()}`,
  );

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const damByName = new Map<string, bigint>();
  for (const name of published) {
    const damId = chooseMaster(name, masters);
    universe.push({ externalId: name, name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (!damId) continue;
    damByName.set(name, damId);
    await bindExternalId(damId, SOURCE_ID, name);
  }
  await recordUniverse(SOURCE_ID, universe);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.name);
    if (!damId) continue;
    inputs.push({
      observedAt: surveyDate,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damByName.size} written=${written}`);

  // The pond column is read by walking up from its label; a layout change
  // that breaks that yields nothing while the fetch succeeds.
  if (rows.length === 0) {
    throw new Error(`${SOURCE_ID}: no ため池 rows in ${pdfUrl} — layout change?`);
  }
};

export default task;
