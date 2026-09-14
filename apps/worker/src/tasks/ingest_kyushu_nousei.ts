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
// below) is read and mapped to a JIS code, and chooseMaster() is run against
// only that prefecture's masters. 佐賀 appears in the PDF but has none of our
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
// し、利水容量に対する貯水率としている」) means the printed "有効貯水量" cell
// is sometimes actually 利水容量 for multi-purpose dams; some of those dams
// (e.g. 石場ダム) print a bare capacity number with no trailing "%" right
// before the column where it changes — usually the 洪水期/非洪水期 boundary
// (6/1, 6/15, 7/15, 8/1 in the R8 survey). unpdf's reading-order extraction
// puts that bare number in the same numeric run as the real (貯水量,貯水率)
// pairs, so `pairDateColumns` below treats any number NOT immediately
// followed by "%" as one of these markers and drops it, rather than trying to
// track which capacity applies when — we only need the latest column's
// (volume, rate), not the capacity itself (see trusted_rate_basis below).
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
// rolling up), so it should keep winning preferredSourceForDam() for those 4
// dams. The other 8 target dams (久保白/伊佐ノ浦/教良木/東原調整池/竹山/西京/
// 金峰/喜界地下) have no competing source at any priority, so this only
// matters for the 大分 overlap.
//
// trusted_rate_basis is set, verified the same way #27 was: the published
// 貯水率 for every one of the 12 dams this issue targets is exactly
// 現貯水量 / 有効貯水量 as the R8.9.1 PDF prints it (久保白 2,891/4,150=69.7%,
// 伊佐ノ浦 1,459/1,640=89.0%, 教良木 1,064/1,371=77.6%, 石場 688/2,154=31.9%,
// 深見 785/1,250=62.8%, 日指 1,112/4,510=24.7%, 並石 519/1,429=36.3%, 東原調整池
// 763/910=83.8%, 竹山 936/1,937=48.3%, 西京 2,073/2,238=92.6%, 金峰
// 1,740/2,290=76.0%, 喜界地下 1,292/1,330=97.1%) — all 12 are single-purpose
// agricultural dams whose 有効貯水量 and 利水容量 columns print the same
// number, so the multi-purpose-dam caveat above never applies to them.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';
import { extractText, getDocumentProxy } from 'unpdf';

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

/** Upper sanity bound for a published 貯水率, in percent. */
const MAX_PLAUSIBLE_PCT = 200;

export interface ParsedRow {
  /** Name exactly as the PDF prints it, e.g. 「石場ダム」. */
  kyushuName: string;
  /** JIS code of the prefecture block the row was printed under. */
  prefCode: string;
  /** 現貯水量 in m³ (the PDF prints 千m³). */
  storageVolumeM3: number;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number;
}

interface PublishedRow {
  name: string;
  prefCode: string | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parse 「九州農政局管内の農業用ダムの合計貯水率（令和８年９月１日現在）」 →
 * JST midnight of that day.
 *
 * Unlike oita-nourin's own PDF, this table carries no survey time (HH:MM),
 * only the date, so the observation is stamped at JST midnight. Anchored on
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
}

/**
 * Pair up (volume, rate) for every survey-date column plus the trailing 平年
 * column, skipping the bare capacity-update markers described in the header
 * comment. See there for why a bare number is dropped and a "－ －" run
 * becomes an explicit null pair rather than being skipped.
 */
function pairDateColumns(tokens: Token[]): DatePair[] {
  const pairs: DatePair[] = [];
  let i = 0;
  while (i < tokens.length) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a?.kind === 'num' && b?.kind === 'pct') {
      pairs.push({ volume: a.value, rate: b.value });
      i += 2;
    } else if (a?.kind === 'dash' && b?.kind === 'dash') {
      pairs.push({ volume: null, rate: null });
      i += 2;
    } else if (a?.kind === 'num') {
      // Bare 利水容量 update — printed inline with no rate of its own.
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
  rows: ParsedRow[];
  published: PublishedRow[];
} {
  const reportDate = parseKyushuNouseiDate(text);
  const rows: ParsedRow[] = [];
  const published: PublishedRow[] = [];

  let currentPrefCode: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 小計 (per-prefecture subtotal) and 計 (grand total) rows carry no dam
    // name and would otherwise just fail NAME_RE, but skip explicitly so a
    // future subtotal that happens to contain a real dam name in its
    // description column can never be mistaken for one.
    if (line.startsWith('小計') || /^計(\s|$)/.test(line)) continue;

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

    published.push({ name, prefCode: currentPrefCode });

    // First two tokens: 有効貯水量, 利水容量 (千m³). Both must be real numbers
    // for the row to be usable — no target dam ever prints these as "－".
    const effCapTok = tokens[0];
    const waterRightTok = tokens[1];
    if (effCapTok?.kind !== 'num' || waterRightTok?.kind !== 'num') continue;
    const effectiveCapacity = effCapTok.value;
    if (effectiveCapacity <= 0) continue;

    const pairs = pairDateColumns(tokens.slice(2));
    // The last pair is always 平年; the one before it is the current survey.
    // Fewer than 2 pairs means there is no current reading to distinguish
    // from the 平年 baseline (would only happen on a PDF with a single date
    // column and no 平年 data at all — not seen in practice).
    if (pairs.length < 2) continue;
    const current = pairs[pairs.length - 2];
    if (!current || current.volume == null || current.rate == null) continue;

    // A published 0% is a drained or out-of-survey reservoir, not an
    // operating reading — dropping it avoids recreating the phantom-zero
    // problem migrations 0038/0039 had to undo.
    if (current.rate <= 0 || current.rate > MAX_PLAUSIBLE_PCT) continue;

    // The row must be internally consistent: the printed rate is
    // 現貯水量 / (有効貯水量 column, which the PDF's own footnote says is
    // really 利水容量 for multi-purpose dams). A row that fails this is a
    // layout misread, not data — drop it rather than publish an unexplained
    // number.
    const implied = (100 * current.volume) / effectiveCapacity;
    if (Math.abs(implied - current.rate) > 1.5) continue;

    rows.push({
      kyushuName: name,
      prefCode: currentPrefCode ?? 'unknown',
      storageVolumeM3: current.volume * 1000,
      storageRate: current.rate / 100,
    });
  }

  return { reportDate, rows, published };
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

// --- name matching ----------------------------------------------------------

/**
 * Strip the ダム suffix and parenthetical annotations; fold ノ/の and 渓/溪.
 *
 * 渓/溪 fixes the one known mismatch this feed brings (also present in
 * oita-nourin's own table): the PDF prints 「耶馬渓ダム」, master holds
 * 「耶馬溪ダム」.
 */
export function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .replace(/ノ/g, 'の')
    .replace(/渓/g, '溪')
    .trim();
}

const KIND_SUFFIX_RE = /(調整池|貯水池|ため池|溜池)$/;

/** Best master dam for a feed name; exact beats stem beats substring. */
export function chooseMaster(
  feedName: string,
  masters: { id: bigint; name: string }[],
): bigint | null {
  const stem = normalizeName(feedName);
  if (!stem) return null;
  const bareStem = stem.replace(KIND_SUFFIX_RE, '');
  const hasBareStem = bareStem.length >= 2 && bareStem !== stem;

  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === feedName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else if (hasBareStem && mStem === bareStem) rank = 5;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
      best = { id: m.id, rank };
    }
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
    VALUES (${SOURCE_ID}, 279,
            '九州農政局 管内の農業用ダムの貯水状況 — 59 基 (6県, 月1-2回, 貯水量+貯水率)',
            true, true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority           = EXCLUDED.priority,
          description        = EXCLUDED.description,
          active             = EXCLUDED.active,
          trusted_rate_basis = EXCLUDED.trusted_rate_basis
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
  const pdfUrl = findLatestPdfUrl(await indexRes.text(), INDEX_URL);
  if (!pdfUrl) {
    log(`${SOURCE_ID}: no survey PDF linked from the index; aborting`);
    return;
  }

  const pdfRes = await fetch(pdfUrl, { headers, signal: AbortSignal.timeout(30_000) });
  if (pdfRes.status !== 200) {
    log(`${SOURCE_ID}: PDF HTTP ${pdfRes.status} for ${pdfUrl}; aborting`);
    return;
  }

  const text = await pdfToText(new Uint8Array(await pdfRes.arrayBuffer()));
  const { reportDate, rows, published } = parseKyushuNouseiPdfText(text);
  if (!reportDate) {
    log(`${SOURCE_ID}: no survey date in ${pdfUrl}; aborting`);
    return;
  }
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows for ${reportDate.toISOString()}`);

  const prefCodes = Object.values(PREF_NAME_TO_CODE);
  const masterRows = await sql<{ id: bigint; name: string; prefCode: string }[]>`
    SELECT id, name, pref_code AS "prefCode" FROM dams
    WHERE pref_code = ANY(${prefCodes}) ORDER BY id
  `;
  const mastersByPref = new Map<string, { id: bigint; name: string }[]>();
  for (const m of masterRows) {
    const list = mastersByPref.get(m.prefCode) ?? [];
    list.push({ id: m.id, name: m.name });
    mastersByPref.set(m.prefCode, list);
  }

  const universe: UniverseRow[] = published.map((p) => ({
    externalId: `${p.prefCode ?? 'unknown'}:${p.name}`,
    name: p.name,
    prefCode: p.prefCode,
    resolvedDamId: chooseMaster(p.name, mastersByPref.get(p.prefCode ?? '') ?? []),
  }));
  await recordUniverse(SOURCE_ID, universe);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let unmatched = 0;
  for (const p of rows) {
    const damId = chooseMaster(p.kyushuName, mastersByPref.get(p.prefCode) ?? []);
    if (!damId) {
      unmatched += 1;
      log(`${SOURCE_ID}: no master match for "${p.kyushuName}" (pref ${p.prefCode})`);
      continue;
    }
    inputs.push({
      observedAt: reportDate,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
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
  log(
    `${SOURCE_ID} done: parsed=${rows.length} matched=${inputs.length} unmatched=${unmatched} written=${written}`,
  );
};

export default task;
