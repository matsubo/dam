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

import { ingestTask, type Log } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import { pdfToText } from './ingest_oita_nourin.ts';

const INDEX_URL =
  process.env.KAGAWA_TAMEIKE_URL ?? 'https://www.pref.kagawa.lg.jp/mizusigen/mizu/kfvn.html';

const ORIGIN = 'https://www.pref.kagawa.lg.jp';
const PREF_CODE = '37';
const SOURCE_ID = 'kagawa-tameike';

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

/** 宝山湖 as the page names it — its stamp and universe key. */
const HOZANKO = '宝山湖';
/**
 * 香川用水調整池. No master row carries the lake name 宝山湖, so it is pinned
 * by NDI; ダム便覧 3374 (the same row's damnet id) gives 「ダム湖名 宝山湖」.
 */
const HOZANKO_NDI = '2170';

/** One pond of the ため池 column: its printed name and its rate cell. */
export interface PondRow {
  /** Pond name exactly as printed (「公渕池」) — also the stamp and universe key. */
  name: string;
  /** The rate cell as printed: a whole percent, or the PDF's 「－」 marker. */
  cell: string;
}

export type Fetcher = (url: string) => Promise<Response>;

// --- parsing ----------------------------------------------------------------

/** One pond line: name ending 池, the rate (or a marker), the 市町 or 〃. */
const POND_LINE_RE = /^(\S+池)\s+(\S+)\s+(\S+(?:市|町|村)|〃)$/;

/** A rate cell the PDF prints in place of a figure. */
const MARK_RE = /^[－―ー‐-]+$/;

export function parseKagawaTameikeText(text: string): {
  surveyDate: Date | null;
  ponds: PondRow[];
} {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const labelAt = lines.findIndex((l) => l.startsWith('ため池貯水率'));
  if (labelAt < 0) return { surveyDate: null, ponds: [] };

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
  const ponds: PondRow[] = [];
  for (let i = labelAt - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line === '備考') continue;
    const m = line.match(POND_LINE_RE);
    if (!m) break;
    ponds.unshift({ name: m[1] as string, cell: m[2] as string });
  }
  return { surveyDate, ponds };
}

/** A pond's reading from its rate cell and the column's survey date. */
export function pondReading(cell: string, surveyDate: Date | null): Reading {
  if (MARK_RE.test(cell)) return { state: 'empty', mark: cell };
  const pct = /^\d{1,3}$/.test(cell) ? Number(cell) : null;
  if (pct === null) return { state: 'unreadable', why: `rate cell 「${cell}」` };
  if (pct <= 0 || pct > 100) {
    return { state: 'unreadable', why: `${pct} % is not an operating reading` };
  }
  if (!surveyDate) return { state: 'unreadable', why: 'no 「…現在」 survey date' };
  return { state: 'values', observations: [{ observedAt: surveyDate, storageRate: pct / 100 }] };
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

// --- entries ----------------------------------------------------------------

/**
 * 宝山湖, read from the page itself whatever happens to the PDF. Pinned by
 * NDI: no master row carries the lake name.
 */
export function hozankoEntry(indexHtml: string): Entry {
  const hozanko = parseHozankoHtml(indexHtml);
  let reading: Reading;
  if (!hozanko) reading = { state: 'unreadable', why: `no ${HOZANKO} block on the index` };
  else if (hozanko.storageRate === null) {
    reading = { state: 'unreadable', why: 'no usable 現在貯水率' };
  } else {
    reading = {
      state: 'values',
      observations: [{ observedAt: hozanko.observedAt, storageRate: hozanko.storageRate }],
    };
  }
  return {
    key: HOZANKO,
    name: HOZANKO,
    pref: PREF_CODE,
    bind: { ndi: HOZANKO_NDI },
    reading,
  };
}

/**
 * Pond names are generic (新池, 城池, 大谷池 exist all over the prefecture),
 * so only an exact name binds — after folding 渕→淵 (the PDF's 公渕池 is the
 * master's 公淵池); a （元）/（再） pair goes to the live twin.
 */
export function pondEntries(text: string): Entry[] {
  const { surveyDate, ponds } = parseKagawaTameikeText(text);
  return ponds.map((p) => ({
    key: p.name,
    name: p.name,
    pref: PREF_CODE,
    bind: { name: p.name.replace(/渕/g, '淵'), exact: true },
    reading: pondReading(p.cell, surveyDate),
  }));
}

/**
 * The ため池 column of the newest report PDF. Empty (logged) when the PDF is
 * not linked, not served, times out or cannot be read — so 宝山湖, read from
 * the page itself, is still written.
 */
export async function readPonds(indexHtml: string, fetcher: Fetcher, log: Log): Promise<Entry[]> {
  const pdfUrl = findLatestPdfUrl(indexHtml);
  if (!pdfUrl) {
    log(`${SOURCE_ID}: no chosui PDF linked from the index`);
    return [];
  }
  let text: string;
  try {
    const pdfRes = await fetcher(pdfUrl);
    if (pdfRes.status !== 200) {
      log(`${SOURCE_ID}: PDF HTTP ${pdfRes.status} for ${pdfUrl}`);
      return [];
    }
    text = await pdfToText(new Uint8Array(await pdfRes.arrayBuffer()));
  } catch (err) {
    log(`${SOURCE_ID}: PDF unreadable at ${pdfUrl}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
  const ponds = pondEntries(text);
  log(`${SOURCE_ID}: ${ponds.length} ponds in ${pdfUrl}`);
  return ponds;
}

const fetchWithUa: Fetcher = (url) =>
  fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });

export default ingestTask(SOURCE_ID, async (log) => {
  const indexRes = await fetchWithUa(INDEX_URL);
  if (indexRes.status !== 200) {
    throw new Error(`${SOURCE_ID}: index HTTP ${indexRes.status} for ${INDEX_URL}`);
  }
  const indexHtml = await indexRes.text();
  // Both blocks are located by fixed labels (the 宝山湖 heading has been on the
  // page since at least 2024); a layout change that breaks one makes its
  // entries unreadable while the fetch succeeds.
  const entries = [hozankoEntry(indexHtml), ...(await readPonds(indexHtml, fetchWithUa, log))];
  return { entries, dated: true };
});
