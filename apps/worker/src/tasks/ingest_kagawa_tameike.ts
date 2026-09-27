// apps/worker/src/tasks/ingest_kagawa_tameike.ts
//
// 香川県 水資源対策課「かがわの水」— 降雨及び貯水率の状況 の主要ため池貯水率 (26 か所)
// and 宝山湖 (香川用水調整池).
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
// The page itself also carries a 宝山湖 block, which the PDF lacks:
//   <h2>宝山湖2026年9月25日（9時現在）</h2>
//   貯水量（100％） 3百万立方メートル | 現在貯水率 37.5%
// 宝山湖 is the lake of 香川用水調整池 (JWA, NDI 2170; ダム便覧 3374 lists
// 「ダム湖名 宝山湖」). Its rate is stamped at the stated hour JST. It is the
// only feed for that dam: JWA's own 香川用水 page is an image.
//
// Values: 貯水率 only (ponds whole percent, 宝山湖 0.1 %). The ponds print no
// volume, and 宝山湖's 「3百万立方メートル」 is a rounded capacity (master
// 有効 3,050,000 m³), so nothing can be back-solved; trusted_rate_basis stays
// off (see migration 0048's rule). 0 % is not stored (0038/0039 phantom zeros).
//
// Priority 283 — no other source covers these ponds or 宝山湖; kept below the
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

/** 宝山湖 as the page names it — its stamp and universe key. */
const HOZANKO = '宝山湖';
/**
 * 香川用水調整池. No master row carries the lake name 宝山湖, so it is pinned
 * by NDI; ダム便覧 3374 (the same row's damnet id) gives 「ダム湖名 宝山湖」.
 */
const HOZANKO_NDI = '2170';

export interface ParsedRow {
  /** Pond name exactly as printed (「公渕池」) — also the stamp and universe key. */
  name: string;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number;
}

type Master = BindableMaster & { ndi: string | null };

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

/**
 * The 宝山湖 block of the かがわの水 page: its heading date (「（9時現在）」
 * → that hour JST, a bare 「現在」 → JST midnight) and the 現在貯水率 cell.
 * null when the page has no 宝山湖 heading; a block whose cell holds no
 * usable figure (a marker, 0 %, > 100 %) comes back with a null rate.
 */
export function parseHozankoHtml(
  html: string,
): { observedAt: Date; storageRate: number | null } | null {
  const text = html.normalize('NFKC');
  const head = text.match(
    /宝山湖\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:\((\d{1,2})時現在\)|現在)/,
  );
  if (!head) return null;
  const [, y, mo, d, h] = head;
  const observedAt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0) - 9));

  // The first <td> carrying a percentage in the table under the heading. The
  // capacity header 「貯水量（100％）」 is a <th>, so it never matches.
  const table = text.slice((head.index ?? 0) + head[0].length).match(/^[\s\S]*?<\/table>/)?.[0];
  let pct: number | null = null;
  for (const cell of table?.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? []) {
    const m = cell[1]?.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (m) {
      pct = Number(m[1]);
      break;
    }
  }
  const storageRate = pct !== null && pct > 0 && pct <= 100 ? pct / 100 : null;
  return { observedAt, storageRate };
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

/** 宝山湖's master: the row already stamped with it, else NDI 2170. */
export function chooseHozanko(masters: Master[]): bigint | null {
  return (
    stampedMaster(masters, HOZANKO)?.id ?? masters.find((m) => m.ndi === HOZANKO_NDI)?.id ?? null
  );
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 283,
            '香川県 水資源対策課 降雨及び貯水率の状況 — 主要ため池 26 か所 (月2回程度) と宝山湖の貯水率',
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
  const indexHtml = await indexRes.text();

  const masters = await sql<Master[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp,
           external_ids->>'ndi' AS ndi
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const readings: { damId: bigint; observedAt: Date; storageRate: number }[] = [];

  // 宝山湖 lives on the page itself, so it is read whatever happens to the PDF.
  const hozanko = parseHozankoHtml(indexHtml);
  if (hozanko) {
    const damId = chooseHozanko(masters);
    universe.push({
      externalId: HOZANKO,
      name: HOZANKO,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (damId) {
      await bindExternalId(damId, SOURCE_ID, HOZANKO);
      if (hozanko.storageRate !== null) {
        readings.push({ damId, observedAt: hozanko.observedAt, storageRate: hozanko.storageRate });
      }
    }
    log(
      `${SOURCE_ID}: ${HOZANKO} ${hozanko.storageRate ?? '-'} at ${hozanko.observedAt.toISOString()}`,
    );
  } else {
    log(`${SOURCE_ID}: no ${HOZANKO} block on the index`);
  }

  const ponds = await readPonds(indexHtml, headers, log);
  const damByName = new Map<string, bigint>();
  for (const name of ponds?.published ?? []) {
    const damId = chooseMaster(name, masters);
    universe.push({ externalId: name, name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (!damId) continue;
    damByName.set(name, damId);
    await bindExternalId(damId, SOURCE_ID, name);
  }
  await recordUniverse(SOURCE_ID, universe);

  for (const p of ponds?.rows ?? []) {
    const damId = damByName.get(p.name);
    if (damId && ponds) {
      readings.push({ damId, observedAt: ponds.surveyDate, storageRate: p.storageRate });
    }
  }

  const written = await upsertObservations(
    readings.map((r) => ({
      observedAt: r.observedAt,
      damId: r.damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: r.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    })),
  );
  const parsed = (ponds?.rows.length ?? 0) + (hozanko?.storageRate != null ? 1 : 0);
  log(`${SOURCE_ID} done: parsed=${parsed} matched=${readings.length} written=${written}`);

  // Both blocks are located by fixed labels (the 宝山湖 heading has been on the
  // page since at least 2024); a layout change that breaks one yields nothing
  // while the fetch succeeds.
  if (!hozanko) {
    throw new Error(`${SOURCE_ID}: no ${HOZANKO} block on ${INDEX_URL} — layout change?`);
  }
  if (ponds?.rows.length === 0) {
    throw new Error(`${SOURCE_ID}: no ため池 rows in ${ponds.pdfUrl} — layout change?`);
  }
};

/**
 * The ため池 column of the newest report PDF. null (logged) when the PDF is
 * not linked, not served, or carries no survey date.
 */
async function readPonds(
  indexHtml: string,
  headers: Record<string, string>,
  log: (s: string) => void,
): Promise<{ pdfUrl: string; surveyDate: Date; rows: ParsedRow[]; published: string[] } | null> {
  const pdfUrl = findLatestPdfUrl(indexHtml);
  if (!pdfUrl) {
    log(`${SOURCE_ID}: no chosui PDF linked from the index`);
    return null;
  }
  const pdfRes = await fetch(pdfUrl, { headers, signal: AbortSignal.timeout(30_000) });
  if (pdfRes.status !== 200) {
    log(`${SOURCE_ID}: PDF HTTP ${pdfRes.status} for ${pdfUrl}`);
    return null;
  }
  const text = await pdfToText(new Uint8Array(await pdfRes.arrayBuffer()));
  const { surveyDate, rows, published } = parseKagawaTameikeText(text);
  if (!surveyDate) {
    log(`${SOURCE_ID}: no ため池 survey date in ${pdfUrl}`);
    return null;
  }
  log(
    `${SOURCE_ID}: parsed ${rows.length}/${published.length} ponds for ${surveyDate.toISOString()}`,
  );
  return { pdfUrl, surveyDate, rows, published };
}

export default task;
