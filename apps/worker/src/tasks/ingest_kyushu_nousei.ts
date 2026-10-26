// apps/worker/src/tasks/ingest_kyushu_nousei.ts
//
// 九州農政局「管内の農業用ダムの貯水状況」— 農業用ダム等 59 基, 6 県 (福岡/佐賀/
// 長崎/熊本/大分/宮崎/鹿児島) にまたがる広域表。
//
// Source:
//   https://www.maff.go.jp/kyusyu/keikaku/shinko/tyosui/tyosui.html
// The index links the current-year PDF alongside two past-year archives; the
// current one's anchor text always contains "現在の" ("...現在の...貯水状況"),
// the archives read "...（１月から12月まで）" instead — that substring is what
// picks the right link, and the filename (`tyosui-109.pdf` today) changes
// every survey, so it is discovered, never pinned, same as #27.
//
// Distinct from `oita-nourin` (#27, 大分県 単独): this is a 九州農政局 regional
// roll-up covering 6 prefectures in one PDF, so unlike every single-prefecture
// adapter in this codebase, master lookup CANNOT filter on one fixed
// pref_code — the row's own 県名 cell (printed once per prefecture block, see
// below) is read and mapped to a JIS code, and the row is bound within only
// that prefecture's masters (BINDS reaches the two 大分-listed dams the
// master files under 熊本). 佐賀 appears in the PDF but has none of our
// 12 target dams — it is skipped implicitly (its rows just won't match).
//
// Format: PDF, one wide table titled 「...の貯水状況（令和８年）」. Columns:
//   県名 水系名 ダム名 有効貯水量 利水容量 [(貯水量,貯水率) per survey date,
//   4/1〜current] 平年貯水量 平年貯水率 対平年比
// 県名 is printed only on the first row of each prefecture's block (rows below
// it repeat 水系名/ダム名 only) — carried forward while scanning.
// Volumes are 千m³, unlike the 平年比 percentage this table does *not* have an
// observations column for storing it (see below).
//
// The PDF's own footnote (「多目的ダムにおいては、有効貯水容量欄を利水容量と
// し、利水容量に対する貯水率としている」) means the rate column is always
// 現貯水量 / 利水容量 (the second capacity column), never 有効貯水量 (the
// first) — for our 12 target dams the two print the same number, but several
// multi-purpose dams sharing the table (寺内ダム 16,000 有効 / 8,230 利水
// etc.) do not, and validating against the wrong one fails the consistency
// check below for no reason. Some multi-purpose FLOOD-CONTROL dams also
// narrow their 利水容量 for 洪水期 and widen it back afterwards (日向神ダム:
// 21,000 → 7,300 → 18,300 across the R8 survey); the PDF reprints the new
// figure as a bare number with no trailing "%" right at the column boundary
// where it changes, rather than adding its own column. `pairDateColumns`
// below tracks this running value so each column's (volume, rate) is checked
// against whatever 利水容量 actually applied that day.
//
// A survey date can also be missing outright: 熊本県 教良木ダム and 市房ダム
// print "－ －" for 令和8年8月1日 per the PDF's own footnote
// ("※令和８年８月１日の貯水率には熊本県の教良木ダムと市房ダムの貯水率等は
// 含まれていません。"). `pairDateColumns` treats a "－ －" run as an explicit
// null pair rather than skipping it, which keeps every later column's
// position — including "current" — correctly aligned.
//
// The table's LAST (volume, rate) pair is always 平年 (the normal-year
// baseline for the report date), and the current survey's pair is the one
// immediately before it — this holds regardless of how many date columns the
// PDF happens to carry, so nothing here hardcodes "11 columns" even though
// that's what the R8.9.1 fixture has. A lone trailing value after the last
// pair (数値 or "－") is 対平年比; `observations` has no column for it or for
// 平年貯水量/平年貯水率, so none of the three are stored — a future feature
// wanting the source's own seasonal-norm comparison (see issue #39) would
// need a schema change, not a parser change.
//
// Cadence: same as oita-nourin — twice monthly in かんがい期 (4–9月), monthly
// otherwise, survey-date based rather than a clock feed.
//
// Priority 279 — deliberately BELOW oita-nourin (282, #27): 石場・深見・日指・
// 並石(大分) are published by both, and oita-nourin is the more specific
// single-prefecture source (also the one 九州農政局 itself is presumably
// rolling up), so it should keep winning windowSource() (the chart) for those 4
// dams. The other 8 target dams (久保白/伊佐ノ浦/教良木/東原調整池/竹山/西京/
// 金峰/喜界地下) have no competing source at any priority, so this only
// matters for the 大分 overlap.
//
// trusted_rate_basis is set, verified the same way #27 was: the published
// 貯水率 for every one of the 12 dams this issue targets is exactly
// 現貯水量 / 利水容量 as the R8.9.1 PDF prints it (久保白 2,891/4,150=69.7%,
// 伊佐ノ浦 1,459/1,640=89.0%, 教良木 1,064/1,371=77.6%, 石場 688/2,154=31.9%,
// 深見 785/1,250=62.8%, 日指 1,112/4,510=24.7%, 並石 519/1,429=36.3%, 東原調整池
// 763/910=83.8%, 竹山 936/1,937=48.3%, 西京 2,073/2,238=92.6%, 金峰
// 1,740/2,290=76.0%, 喜界地下 1,292/1,330=97.1%) — all 12 are single-purpose
// agricultural dams whose 有効貯水量 and 利水容量 columns print the same
// number, so the multi-purpose-dam capacity caveat above never changes their
// denominator.

import { extractText, getDocumentProxy } from 'unpdf';
import { ingestTask } from '../ingest/run.ts';
import type { Bind, Entry, Reading } from '../ingest/types.ts';

const INDEX_URL =
  process.env.KYUSHU_NOUSEI_URL ??
  'https://www.maff.go.jp/kyusyu/keikaku/shinko/tyosui/tyosui.html';

const SOURCE_ID = 'kyushu-nousei';

/** JIS prefecture codes, matching PREF_CODE constants across the other adapters. */
const PREF_NAME_TO_CODE: Record<string, string> = {
  福岡: '40',
  佐賀: '41',
  長崎: '42',
  熊本: '43',
  大分: '44',
  宮崎: '45',
  鹿児島: '46',
};

/**
 * JST hour each prefecture block's figures were read at, by JIS code.
 *
 * The PDF prints only the survey date. Matching the 11 survey columns of the
 * R8.9.15 table (4/15–9/15) against prod's hourly feeds for the same dams:
 * 福岡 equals the JST-midnight readings (38 matches at 15:00Z, none at 00:00Z;
 * 江川 4,652 = fukuoka-bodik, 油木 7,353 = kasenbosai), while 佐賀 (厳木,
 * 嘉瀬川: 11), 熊本 (市房, 竜門, 緑川: 18) and 大分 (耶馬渓 vs kasenbosai, and
 * all six rows oita-nourin prints at 「9：00現在」: 10) match 09:00 JST only.
 * 宮崎's three dams with a kasenbosai series (田代八重, 立花, 綾北) are on
 * another volume basis, but an affine fit against the 09:00 readings leaves
 * 4–5× less residual than against midnight.
 *
 * 長崎 and 鹿児島 stay at midnight. Their only other feed is kasenbosai's
 * 貯水位 (no 貯水量), from 5/19, so the 6/1–9/15 columns were fitted to it
 * as a level–volume curve. 鹿児島 fits midnight: 高隈's ΔV/ΔL between
 * surveys is 924–967 千m³/m at midnight but 901–1,335 at 09:00, and a cubic
 * fit leaves 4.3 千m³ RMS at midnight against 65 at 09:00 (谷川内 0.2 vs
 * 2.4, 中岳 0.8 vs 3.0, 輝北 4.2 vs 8.9; 高川, 荒瀬 and 徳之島 do not
 * separate the hours). 長崎's one comparable dam, 小ヶ倉, moves under 0.1 m
 * between midnight and 09:00; a cubic fit over its 7 surveys leans to
 * midnight (12 vs 20 千m³ RMS) with 3 degrees of freedom left, which
 * does not settle the hour.
 */
const SURVEY_HOUR_JST: Readonly<Record<string, number>> = {
  '41': 9,
  '43': 9,
  '44': 9,
  '45': 9,
};

/**
 * How a row finds its master when its printed name does not, keyed by
 * feedKey below.
 *
 * 大蘇ダム and 大谷ダム are on the 大野川 headwaters at the 大分/熊本 line and
 * serve 大分 (竹田市荻町): the PDF lists them in the 大分 block, the master files
 * both under 熊本, as ダム便覧 does (2681 大蘇, 熊本県阿蘇郡産山村, 九州農政局;
 * 2657 大谷, 熊本県阿蘇郡高森町, 荻柏原土地改良区). The PDF's 有効 3,890 and
 * 1,500 千m³ are the master's (and ダム便覧's) 有効貯水容量 exactly.
 *
 * 小ヶ倉ダム (長崎市) has two master rows of the same name, NDI 2592 and 2609,
 * with the same manager, height and capacity; this source has always bound
 * NDI 2592, so it stays pinned there.
 *
 * The rest are spellings: the PDF prints 「花宗ため池」 and 「耶馬渓ダム」, the
 * master holds 「花宗溜池」 and 「耶馬溪」 (the same name in old kanji).
 */
export const BINDS: Readonly<Record<string, Bind>> = {
  '44:大蘇ダム': { ndi: '2306' },
  '44:大谷ダム': { ndi: '2307' },
  '42:小ヶ倉ダム': { ndi: '2592' },
  '40:花宗ため池': { name: '花宗溜池' },
  '44:耶馬渓ダム': { name: '耶馬溪ダム' },
};

/** Upper sanity bound for a published 貯水率, in percent. */
const MAX_PLAUSIBLE_PCT = 200;

/** One dam row of the table: where it was printed and what we read from it. */
export interface KyushuRow {
  /** Name exactly as the PDF prints it, e.g. 「石場ダム」. */
  name: string;
  /** JIS code of the prefecture block the row was printed under. */
  prefCode: string | null;
  reading: Reading;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parse 「九州農政局管内の農業用ダムの合計貯水率（令和８年９月１日現在）」 →
 * JST midnight of that day.
 *
 * Unlike oita-nourin's own PDF, this table carries no survey time (HH:MM),
 * only the date; each row adds its block's hour (SURVEY_HOUR_JST). Anchored on
 * 現在 so the table's own title line — the only place this phrase appears —
 * is what is matched, not some other 令和N年M月D日 elsewhere on the page.
 */
export function parseKyushuNouseiDate(text: string): Date | null {
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = normalized.match(/令和(\d+)年(\d+)月(\d+)日現在/);
  if (!m) return null;
  const [, eraStr, moStr, dayStr] = m;
  const era = Number(eraStr);
  const mo = Number(moStr);
  const day = Number(dayStr);
  if (!mo || !day) return null;
  // 令和 N → 2018 + N. JST midnight = 15:00 UTC the previous day.
  const d = new Date(Date.UTC(2018 + era, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 「1,050」→ 1050, 「△ 9.1」→ -9.1. */
function parseNum(s: string): number | null {
  const t = s
    .replace(/,/g, '')
    .replace(/[△▲]\s*/, '-')
    .trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

type Token = { kind: 'num'; value: number } | { kind: 'pct'; value: number } | { kind: 'dash' };

const DASH_RE = /^[－―ー‐-]$/;

/** Every number, percentage or dash in a row's numeric tail, in reading order. */
function tokenize(tail: string): Token[] {
  const raw = tail.match(/[△▲]?[\d,]+\.?\d*%?|[－―ー‐-]/g) ?? [];
  const tokens: Token[] = [];
  for (const t of raw) {
    if (DASH_RE.test(t)) {
      tokens.push({ kind: 'dash' });
      continue;
    }
    const n = t.endsWith('%') ? parseNum(t.slice(0, -1)) : parseNum(t);
    if (n === null) continue;
    tokens.push(t.endsWith('%') ? { kind: 'pct', value: n } : { kind: 'num', value: n });
  }
  return tokens;
}

interface DatePair {
  volume: number | null;
  rate: number | null;
  /** 利水容量 in effect for this column (千m³) — see below. */
  capacity: number;
}

/**
 * Pair up (volume, rate, capacity) for every survey-date column plus the
 * trailing 平年 column, tracking 利水容量 as it changes mid-row.
 *
 * A bare number (not immediately followed by "%") is a 利水容量 update, not
 * noise to discard: for a 洪水期/非洪水期-restricted dam (flood-control
 * multipurpose dams such as 日向神ダム), the usable capacity really does drop
 * for the flood season and recover afterwards, and the PDF reprints the new
 * figure inline rather than in its own column. For most rows the bare number
 * just repeats the same value (寺内ダム reprints "8,230" — its constant
 * 利水容量 — three times with no change), so tracking it is a no-op there;
 * for 日向神ダム it drops from 21,000 to 7,300 and back to 18,300 across the
 * row, and using a single static capacity for the whole row (this adapter's
 * first cut) mis-derived 16 of the table's 59 rows as internally
 * inconsistent, including several with no relation to this issue's 12 target
 * dams. A "－ －" run is an explicit missing survey (see header comment) and
 * still advances the column position, carrying the last-known capacity
 * forward.
 */
function pairDateColumns(tokens: Token[], initialCapacity: number): DatePair[] {
  const pairs: DatePair[] = [];
  let capacity = initialCapacity;
  let i = 0;
  while (i < tokens.length) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a?.kind === 'num' && b?.kind === 'pct') {
      pairs.push({ volume: a.value, rate: b.value, capacity });
      i += 2;
    } else if (a?.kind === 'dash' && b?.kind === 'dash') {
      pairs.push({ volume: null, rate: null, capacity });
      i += 2;
    } else if (a?.kind === 'num') {
      capacity = a.value;
      i += 1;
    } else {
      // A lone trailing 対平年比 (pct or dash): the row's date columns are done.
      break;
    }
  }
  return pairs;
}

/**
 * Every ダム/池 name on a line, with the numeric run that follows it.
 *
 * Anchoring on the name rather than a positional split survives 県名 being
 * printed only on a prefecture block's first row and 水系名 sometimes being
 * "－" (自然湖・地下ダムに水系名なし, e.g. 池田湖・喜界地下ダム) — same
 * approach as oita-nourin (#27).
 */
const NAME_RE = /([^\s\d]+?(?:ダム|調整池|貯水池|溜池|ため池))/;

export function parseKyushuNouseiPdfText(text: string): {
  reportDate: Date | null;
  rows: KyushuRow[];
} {
  const reportDate = parseKyushuNouseiDate(text);
  const rows: KyushuRow[] = [];

  let currentPrefCode: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 小計 (per-prefecture subtotal) and 計 (grand total) rows carry no dam
    // name and would otherwise just fail NAME_RE, but skip explicitly so a
    // future subtotal that happens to contain a real dam name in its
    // description column can never be mistaken for one. Footnote lines
    // (「※...」) are skipped for the same reason — one of them literally
    // reads "...熊本県の教良木ダムと市房ダムの..." and would otherwise be
    // read as a phantom 教良木ダム row with no numeric tail.
    if (line.startsWith('小計') || /^計(\s|$)/.test(line) || line.startsWith('※')) continue;

    for (const [prefName, code] of Object.entries(PREF_NAME_TO_CODE)) {
      if (line.startsWith(`${prefName} `) || line.startsWith(`${prefName}　`)) {
        currentPrefCode = code;
        break;
      }
    }

    const nameMatch = line.match(NAME_RE);
    if (!nameMatch?.[1]) continue;
    const name = nameMatch[1];
    const tail = line.slice((nameMatch.index ?? 0) + name.length);
    const tokens = tokenize(tail);

    // First token: 有効貯水量 (千m³). The R8.9.1 PDF followed it with a 利水容量
    // column; from R8.9.15 the table's date window slid right and the row goes
    // straight into the first (貯水量, 貯水率) pair. Which layout a row has is
    // read off the third token: a percentage there means the second token is
    // already a volume. Without the leading 利水容量 the row starts from
    // 有効貯水量, and pairDateColumns picks up the real 利水容量 from the next
    // bare number the row reprints (寺内ダム 8,230) — before the current survey
    // column, which is the only one checked.
    // A line with no numeric tail is not a table row — this is also what
    // rejects the page's title lines and the embedded chart's own "繁敷ダム"
    // caption, which NAME_RE matches but which carry no numbers. The PDF's
    // own footnote ("利水容量に対する貯水率としている") says the rate is
    // always against 利水容量, not 有効貯水量 — for our 12 target dams the two
    // are the same number, but for multi-purpose dams sharing the table
    // (寺内ダム 16,000/8,230 etc.) they differ, and using the wrong one fails
    // the consistency check below for no reason.
    // In the new layout the first survey column may itself be a 「－ －」
    // missing pair (教良木ダム 1,371 - - 1,153 84.1% …), so a dash in second
    // place also means "no 利水容量 column" rather than "not a row".
    const effCapTok = tokens[0];
    const secondTok = tokens[1];
    if (effCapTok?.kind !== 'num') continue;
    if (secondTok?.kind !== 'num' && secondTok?.kind !== 'dash') continue;
    const hasWaterRightColumn = secondTok.kind === 'num' && tokens[2]?.kind !== 'pct';
    const initialCapacity =
      secondTok.kind === 'num' && hasWaterRightColumn ? secondTok.value : effCapTok.value;
    if (initialCapacity <= 0) continue;

    // A real row, even if the rest of it turns out unusable below, so an
    // unmatched or zero-rate dam still counts as published.
    const pairs = pairDateColumns(tokens.slice(hasWaterRightColumn ? 2 : 1), initialCapacity);
    rows.push({
      name,
      prefCode: currentPrefCode,
      reading: reportDate
        ? currentReading(pairs, reportDate, currentPrefCode)
        : { state: 'unreadable', why: 'no 「…現在」 survey date in the PDF' },
    });
  }

  return { reportDate, rows };
}

/** The current survey column of a row: the pair just before 平年. */
function currentReading(pairs: DatePair[], reportDate: Date, prefCode: string | null): Reading {
  // The last pair is always 平年; the one before it is the current survey.
  // Fewer than 2 pairs means there is no current reading to distinguish
  // from the 平年 baseline (would only happen on a PDF with a single date
  // column and no 平年 data at all — not seen in practice).
  const current = pairs.length < 2 ? undefined : pairs[pairs.length - 2];
  if (!current) return { state: 'unreadable', why: `${pairs.length} survey columns` };
  // 「－ －」: the PDF's own mark for a survey the dam was left out of.
  if (current.volume == null && current.rate == null) return { state: 'empty', mark: '－ －' };
  if (current.volume == null || current.rate == null) {
    return { state: 'unreadable', why: 'half a (貯水量, 貯水率) pair' };
  }

  // A published 0% is a drained or out-of-survey reservoir, not an
  // operating reading — storing it would recreate the phantom-zero problem
  // migrations 0038/0039 had to undo.
  if (current.rate <= 0 || current.rate > MAX_PLAUSIBLE_PCT) {
    return { state: 'unreadable', why: `貯水率 ${current.rate} % is not an operating reading` };
  }

  // The row must be internally consistent: the printed rate is
  // 現貯水量 / 利水容量, using whatever 利水容量 is in effect for this
  // column (see pairDateColumns). A row that fails this is a layout
  // misread, not data — unreadable rather than an unexplained number.
  const implied = (100 * current.volume) / current.capacity;
  if (Math.abs(implied - current.rate) > 1.5) {
    return {
      state: 'unreadable',
      why: `printed ${current.rate} % is not ${current.volume}/${current.capacity}`,
    };
  }

  return {
    state: 'values',
    observations: [
      {
        observedAt: new Date(
          reportDate.getTime() + (SURVEY_HOUR_JST[prefCode ?? ''] ?? 0) * 3_600_000,
        ),
        storageVolumeM3: current.volume * 1000,
        storageRate: current.rate / 100,
      },
    ],
  };
}

/** Extract the PDF's text with unpdf (no poppler in the runtime image). */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/**
 * The newest survey PDF linked from the index page.
 *
 * The index also links the last two fiscal years' archive PDFs
 * ("...（１月から12月まで）"); only the current survey's anchor text contains
 * "現在の", which is what tells them apart. The filename (`tyosui-109.pdf`
 * today) is a CMS attachment id that changes every survey, so — same as
 * oita-nourin — it is discovered, never pinned.
 */
export function findLatestPdfUrl(html: string, baseUrl: string): string | null {
  const re = /<a\s+href="([^"]+\.pdf)"[^>]*>([^<]*)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const href = m[1];
    const text = m[2];
    if (href && text?.includes('現在の')) {
      return new URL(href, baseUrl).toString();
    }
  }
  return null;
}

// --- entries ----------------------------------------------------------------

/** The universe key: the PDF has no ids, and names repeat across prefectures. */
export function feedKey(name: string, prefCode: string | null): string {
  return `${prefCode ?? 'unknown'}:${name}`;
}

/** Every dam row of the table, bound within its own prefecture block. */
export function kyushuNouseiEntries(text: string): Entry[] {
  return parseKyushuNouseiPdfText(text).rows.map((r) => {
    const key = feedKey(r.name, r.prefCode);
    const bind = BINDS[key];
    return {
      key,
      name: r.name,
      pref: r.prefCode,
      ...(bind ? { bind } : {}),
      reading: r.reading,
    };
  });
}

async function fetchOk(url: string, timeoutMs: number): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${res.status} for ${url}`);
  return res;
}

// The R8.9.15 PDF dropped its leading 利水容量 column and this adapter parsed
// 0 of 59 rows while exiting green. Every row is now an entry, so a layout
// change makes them unreadable and the run fails the job (failing_jobs).
export default ingestTask(SOURCE_ID, async (log) => {
  const pdfUrl = findLatestPdfUrl(await (await fetchOk(INDEX_URL, 20_000)).text(), INDEX_URL);
  if (!pdfUrl) throw new Error(`${SOURCE_ID}: no survey PDF linked from ${INDEX_URL}`);
  const pdf = await fetchOk(pdfUrl, 30_000);
  const entries = kyushuNouseiEntries(await pdfToText(new Uint8Array(await pdf.arrayBuffer())));
  log(`${SOURCE_ID}: ${entries.length} dam rows in ${pdfUrl}`);
  return { entries, dated: true };
});
