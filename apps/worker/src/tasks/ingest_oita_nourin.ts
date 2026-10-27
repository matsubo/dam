// apps/worker/src/tasks/ingest_oita_nourin.ts
//
// 大分県 農林水産部 農地・農村整備課「農業用ダム貯水率一覧」— 農業用ダム 21 基。
//
// Source:
//   https://www.pref.oita.jp/site/oitanougyouyoudamuchosuiritsuitiran/
// The page links the current survey as a PDF under /uploaded/attachment/;
// the filename changes every survey, so the link is discovered, never pinned.
//
// Distinct from `oita-bousai` (土木部・河川): the two barely overlap — this is
// the agricultural set (土地改良区 / 市管理の溜池・調整池) that never appears in
// the 防災 feed.
//
// Format: PDF, one table. `unpdf` extracts it in reading order as
//   [地域] 水系名 ダム名 有効貯水量 現貯水量 貯水率 前回貯水率 増減 平年 対平年比 受益面積 うち水田 管理者
// Volumes are 千m³. The 地域 cell only appears on the first row of each block,
// and the 管理者 may contain spaces (「国 東 市」), so the parser anchors on the
// ダム名 and reads the numeric run that follows it rather than splitting on
// whitespace positionally.
//
// Cadence: twice monthly in かんがい期 (4–9月), monthly otherwise. Priority 282
// — below fukushima-nourin (285) and jwa-junpo (290), so any finer feed wins a
// dam both cover; 石場・深見・日指・並石 are also published by 九州農政局 (#28).
//
// trusted_rate_basis is set, and for most rows the feed proves itself: the
// printed 貯水率 is 現貯水量 / 有効貯水量 from the same row (油留木
// 150/165 = 90.9, 石山 183/788 = 23.2, 石場 844/2,154 = 39.2). Back-solving
// therefore returns the source's own 有効貯水量 rather than whatever master
// capacity we hold — which for most of these dams is nothing at all.
//
// Two rows do NOT satisfy that identity and are deliberately left unreadable
// rather than published: 大谷 (730/1,500 = 48.7 vs printed 89.0) and 大蘇
// (3,095/3,890 = 79.6 vs 72.0), both 国営 reservoirs in the 大野川上流 block
// whose rate is evidently against some other capacity. Neither is among the
// 14 dams this issue adds. The per-row check below is what enforces this, so a
// layout misread or a second denominator becomes an unreadable row, never a
// number we cannot explain.

import { extractText, getDocumentProxy } from 'unpdf';
import { ingestTask } from '../ingest/run.ts';
import type { Bind, Entry, Reading } from '../ingest/types.ts';

const INDEX_URL =
  process.env.OITA_NOURIN_URL ??
  'https://www.pref.oita.jp/site/oitanougyouyoudamuchosuiritsuitiran/';

const ORIGIN = 'https://www.pref.oita.jp';
const PREF_CODE = '44';
const SOURCE_ID = 'oita-nourin';

/** Upper sanity bound for a published 貯水率, in percent. */
const MAX_PLAUSIBLE_PCT = 200;

/** One dam row of the survey: its printed name and what we read from it. */
export interface OitaRow {
  /** Name exactly as the PDF prints it, e.g. 「石山ダム」. */
  name: string;
  reading: Reading;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parse 「（ 令和８年９月８日 ９：００ 現在 ）」 → that instant in JST.
 *
 * The header is typeset with full-width digits and padded spaces, so both
 * digit forms are accepted. Anchored on 現在 so a 掲載日 elsewhere on the page
 * can never stand in for the survey time.
 */
export function parseOitaNourinDate(text: string): Date | null {
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = normalized.match(/令和(\d+)年\s*(\d+)月\s*(\d+)日\s*(\d+)\s*[：:]\s*(\d+)\s*現在/);
  if (!m) return null;
  const [, era, mo, day, hh, mi] = m.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!mo || !day) return null;
  // 令和 N → 2018 + N. JST is UTC+9.
  const d = new Date(Date.UTC(2018 + era, mo - 1, day, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 「1,050」→ 1050, 「△ 9.1」→ -9.1, 「－」→ null. */
function parseNum(s: string): number | null {
  const t = s
    .replace(/,/g, '')
    .replace(/[△▲]\s*/, '-')
    .trim();
  if (!t || /^[－—–-]$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every ダム/池 name on a line, with the numeric run that follows it.
 *
 * Anchoring on the name rather than a positional split is what makes this
 * survive the layout: the 地域 column is only printed on the first row of each
 * block, and 管理者 names are spaced out for typesetting (「国 東 市」), so
 * column N is not the same field on every line.
 */
const NAME_RE = /([^\s\d]+?(?:ダム|調整池|貯水池|溜池|ため池))/;

/**
 * The row's reading from 有効貯水量, 現貯水量, 貯水率 (千m³, 千m³, %) — the
 * first three figures after the name.
 */
function rowReading(nums: number[], reportDate: Date): Reading {
  const [capacity, volume, pct] = nums;
  if (capacity == null || volume == null || pct == null) {
    return { state: 'unreadable', why: `only ${nums.length} figures after the name` };
  }
  if (capacity <= 0) return { state: 'unreadable', why: `有効貯水量 ${capacity}` };
  // A published 0 % on an agricultural reservoir is a drained or
  // out-of-survey pond, not an operating reading; storing it would recreate
  // the phantom-zero problem migrations 0038/0039 had to undo.
  if (pct <= 0 || pct > MAX_PLAUSIBLE_PCT) {
    return { state: 'unreadable', why: `貯水率 ${pct} % is not an operating reading` };
  }
  // The row must be internally consistent: the printed rate is
  // 現貯水量 / 有効貯水量. A row that fails this is a layout misread, not
  // data — unreadable rather than a number we cannot explain.
  const implied = (100 * volume) / capacity;
  if (Math.abs(implied - pct) > 1.5) {
    return {
      state: 'unreadable',
      why: `printed ${pct} % is not ${volume}/${capacity} = ${implied.toFixed(1)} %`,
    };
  }
  return {
    state: 'values',
    observations: [
      { observedAt: reportDate, storageVolumeM3: volume * 1000, storageRate: pct / 100 },
    ],
  };
}

export function parseOitaNourinPdfText(text: string): {
  reportDate: Date | null;
  rows: OitaRow[];
} {
  const reportDate = parseOitaNourinDate(text);
  const rows: OitaRow[] = [];

  // Everything after 「(参考) 利水貯水量」 is a reference block of 国交省管理ダム
  // whose first capacity column is 利水貯水量, not the 有効貯水量 the main table
  // prints. Those rows pass the consistency check on their own terms
  // (耶馬渓 2,772/9,800 = 28.3 %), so nothing else would catch them — but
  // storing them under trusted_rate_basis would contradict what back-solving
  // means for this source. They are MLIT dams carried by hourly feeds anyway.
  const referenceAt = text.search(/[（(]参考[）)]\s*利水貯水量/);
  const body = referenceAt >= 0 ? text.slice(0, referenceAt) : text;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const nameMatch = line.match(NAME_RE);
    if (!nameMatch?.[1]) continue;
    const name = nameMatch[1];

    // Numbers printed after the dam name, in column order.
    const tail = line.slice((nameMatch.index ?? 0) + name.length);
    const nums = (tail.match(/[△▲]?\s*[\d,]+(?:\.\d+)?/g) ?? [])
      .map(parseNum)
      .filter((n): n is number => n !== null);

    // The report's own title —「農業用ダムの貯水状況調査」— ends in ダム and
    // matches NAME_RE. Only a line that carries figures is a data row, so the
    // heading cannot enter the published universe as a phantom dam.
    if (nums.length === 0) continue;

    rows.push({
      name,
      reading: reportDate
        ? rowReading(nums, reportDate)
        : { state: 'unreadable', why: 'no 「…現在」 survey date in the PDF' },
    });
  }

  return { reportDate, rows };
}

/** Extract the PDF's text with unpdf (no poppler in the runtime image). */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/**
 * The survey day a link label names, as a sortable yyyymmdd number.
 *
 * Labels carry the date only (「令和8年9月24日現在の貯水率 [PDFファイル／62KB]」),
 * so parseOitaNourinDate's 「H:MM現在」 anchor never matches them.
 */
function labelSurveyDay(label: string): number | null {
  const m = label.normalize('NFKC').match(/令和(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  return (2018 + Number(m[1])) * 10_000 + Number(m[2]) * 100 + Number(m[3]);
}

/**
 * The newest survey PDF linked from the index page.
 *
 * The filename is a CMS attachment id that changes every survey, so pinning
 * one would silently freeze the feed at whatever was current the day it was
 * written. Taking the *first* link is not good enough either: the page is free
 * to list a 過去の調査 archive or a 様式 above the current survey, and because
 * observedAt comes from inside the PDF, an older survey would be written under
 * its own old timestamp where nothing looks wrong — the feed would simply stop
 * moving.
 *
 * So the link is chosen, in order of preference:
 *   1. the newest 令和 date in the link text (「令和8年9月15日現在の貯水率」)
 *   2. the highest attachment id — the CMS counter is monotonic, so a newer
 *      upload always outranks an older one
 * Position on the page is never the deciding factor.
 */
export function findLatestPdfUrl(html: string): string | null {
  const links = [
    ...html.matchAll(
      /<a[^>]+href="([^"]*\/uploaded\/attachment\/(\d+)\.pdf)"[^>]*>([\s\S]{0,120}?)<\/a>/g,
    ),
  ].map((m) => ({
    href: m[1] as string,
    id: Number(m[2]),
    label: (m[3] as string).replace(/<[^>]+>/g, ''),
  }));

  if (links.length === 0) {
    // No anchor markup (or an unexpected shape) — fall back to a bare path
    // match so a template change degrades to the old behaviour rather than
    // dropping the feed entirely.
    const bare = html.match(/\/uploaded\/attachment\/\d+\.pdf/);
    return bare ? `${ORIGIN}${bare[0]}` : null;
  }

  const scored = links.map((l) => ({ ...l, day: labelSurveyDay(l.label) }));
  const dated = scored.filter((l) => l.day !== null);
  const best = dated.length
    ? dated.reduce((a, b) => ((b.day as number) > (a.day as number) ? b : a))
    : scored.reduce((a, b) => (b.id > a.id ? b : a));

  return best.href.startsWith('http') ? best.href : `${ORIGIN}${best.href}`;
}

/**
 * How a row finds its master when its printed name does not.
 *
 * 大蘇ダム and 大谷ダム are on the 大野川 headwaters at the 大分/熊本 line and
 * serve 竹田市荻町; the master files both under 熊本, as ダム便覧 does (2681
 * 大蘇, 熊本県阿蘇郡産山村; 2657 大谷, 熊本県阿蘇郡高森町, 荻柏原土地改良区 —
 * the 管理者 this PDF prints). The PDF's 有効 3,890 and 1,500 千m³ are the
 * master's 有効貯水容量 exactly. Their readings fail the rate check, so the
 * pin only links the universe rows.
 *
 * 中ノ川ダム is the master's 中の川.
 */
export const BINDS: Readonly<Record<string, Bind>> = {
  大蘇ダム: { ndi: '2306' },
  大谷ダム: { ndi: '2307' },
  中ノ川ダム: { name: '中の川' },
};

/** Every dam row of the survey PDF, in print order. */
export function oitaNourinEntries(text: string): Entry[] {
  return parseOitaNourinPdfText(text).rows.map((r) => {
    const bind = BINDS[r.name];
    return {
      key: r.name,
      name: r.name,
      pref: PREF_CODE,
      ...(bind ? { bind } : {}),
      reading: r.reading,
    };
  });
}

// A parser that silently yields nothing is the failure mode this source is
// most exposed to: it is line-oriented over PDF-extracted text, so a layout
// change (numbers before the name, two table rows merged onto one line) makes
// every row unreadable while the fetch still succeeds. The run then fails the
// job, which puts it in /api/v1/admin/jobs `failing_jobs` — exactly how #31
// would have surfaced.
export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const pdfUrl = findLatestPdfUrl((await upstream.fetch(INDEX_URL)).text());
  if (!pdfUrl) throw new Error(`${SOURCE_ID}: no survey PDF linked from ${INDEX_URL}`);
  const pdf = await upstream.fetch(pdfUrl, { timeoutMs: 30_000 });
  const text = await pdfToText(pdf.bytes);
  const entries = oitaNourinEntries(text);
  log(`${SOURCE_ID}: ${entries.length} dam rows in ${pdfUrl}`);
  return { entries, dated: true };
});
